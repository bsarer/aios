/**
 * End-to-end check of the chat shell in a real browser, with a mock model.
 * `pnpm test:e2e [--shots <dir>]`
 *
 * Starts an in-process OpenAI-compatible mock, runs aios-core against it with a
 * throwaway config, data dir and fake keyring, then drives Chromium through the
 * acceptance checks: streaming chat, the now() tool, Esc to stop, slash commands,
 * live status values, memory cards and, with the GreenMail stack up, new-mail
 * notifications and the reply flow. Never touches real accounts or keys.
 *
 * Chromium: $CHROMIUM_PATH, else `chromium` on PATH.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';
import { ImapFlow } from 'imapflow';
import { type Page, chromium } from 'playwright-core';
import { TEST_MAILBOX } from './mailbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : undefined;

// ── Mock model ───────────────────────────────────────────────────────────────

const chunk = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { stream?: boolean; response_format?: unknown; messages: { role: string; content: string | null }[] };
  const last = body.messages.at(-1)!;
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (body.response_format) {
    // Triage: one item per wrapped message; the first is urgent.
    const ids = [...(last.content ?? '').matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    const items = ids.map((id, i) => ({ id, urgency: i === 0 ? 'high' : 'normal', summary: `Mock summary ${i + 1}`, needs_reply: i === 0, suggested_action: 'read', category: 'work' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 60, cost: 0.0002 } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const finish = (cost: number) => {
    chunk(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 40, cost } });
    res.end('data: [DONE]\n\n');
  };

  if (last.role === 'tool' && /<untrusted source="email"/.test(last.content ?? '')) {
    const subject = /Subject: (.*)/.exec(last.content ?? '')?.[1] ?? '?';
    const replyTo = /^Draft a reply to email (\S+)$/.exec(lastUser)?.[1];
    if (replyTo) {
      const sender = /From: [^<\n]*<([^>]+)>/.exec(last.content ?? '')?.[1] ?? '';
      const args = JSON.stringify({ inReplyTo: replyTo, to: [sender], subject: `Re: ${subject}`, body: 'Thanks Sara, I will look at it today.\n\nJohn' });
      chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_d', function: { name: 'mail_create_draft', arguments: args } }] } }] });
      chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
      return void res.end('data: [DONE]\n\n');
    }
    chunk(res, { choices: [{ delta: { content: `That email is about: ${subject}` } }] });
    return finish(0.0004);
  }
  if (last.role === 'tool' && /has NOT been sent/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'The draft is ready for you to review.' } }] });
    return finish(0.0004);
  }
  const readId = last.role === 'user' ? /^(?:Read email|Draft a reply to email) (\S+)$/.exec(lastUser)?.[1] : undefined;
  if (readId) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_r', function: { name: 'mail_read', arguments: JSON.stringify({ id: readId }) } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /card/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'Tap **Save** if that is right.' } }] });
    return finish(0.0004);
  }
  if (last.role === 'user' && /remember/i.test(lastUser)) {
    const args = JSON.stringify({ fact: 'Sara prefers short emails' });
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_m', function: { name: 'memory_propose', arguments: args } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool') {
    // Answer using the tool result, as a real model would.
    const time = /(\d\d:\d\d)/.exec(last.content ?? '')?.[1] ?? '??:??';
    chunk(res, { choices: [{ delta: { content: `It's **${time}** right now.` } }] });
    return finish(0.0004);
  }
  if (/time/i.test(lastUser)) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'now', arguments: '{}' } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (/essay/i.test(lastUser)) {
    // Slow stream so the test can press Esc mid-way.
    for (let i = 0; i < 200 && !res.destroyed; i++) {
      chunk(res, { choices: [{ delta: { content: `Word${i} ` } }] });
      await sleep(50);
    }
    return finish(0.001);
  }
  for (const piece of ['Hello ', 'John! ', 'This reply is ', '*streamed* ', 'token by token.']) {
    chunk(res, { choices: [{ delta: { content: piece } }] });
    await sleep(60);
  }
  finish(0.0005);
}

// ── Test mailbox ─────────────────────────────────────────────────────────────

async function mailStackUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect(TEST_MAILBOX.imapPort, TEST_MAILBOX.host);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function deliverTestMail(subject: string): Promise<void> {
  const c = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
  await c.connect();
  await c.append('INBOX', `From: Sara Kaya <sara.kaya@northwind.example>\r\nTo: ${TEST_MAILBOX.user}\r\nSubject: ${subject}\r\nMessage-ID: <e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@aios.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\nPlease look at this today.`);
  await c.logout();
}

/** Plain-text bodies of messages in Sent whose subject contains `subject`. */
async function sentMatching(subject: string): Promise<string[]> {
  const c = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
  await c.connect();
  try {
    await c.mailboxOpen('Sent', { readOnly: true });
    const uids = (await c.search({ subject }, { uid: true })) || [];
    const out: string[] = [];
    for (const uid of uids) {
      const { content } = await c.download(String(uid), '1', { uid: true });
      let text = '';
      for await (const part of content ?? []) text += part;
      out.push(text);
    }
    return out;
  } finally {
    await c.logout();
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function waitFor(fn: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

async function main(): Promise<void> {
  if (shots) mkdirSync(shots, { recursive: true });
  const mock = createServer((req, res) => void mockModel(req, res));
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = (mock.address() as AddressInfo).port;

  const tmp = mkdtempSync(join(tmpdir(), 'aios-e2e-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  // Fake keyring: the GreenMail test password for the mail account, a dummy key for the model.
  writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\n[ "$1" = lookup ] || exit 1\n[ "$5" = mail ] && printf test-only-password && exit 0\nprintf test-key\n');
  chmodSync(join(bin, 'secret-tool'), 0o755);
  const port = 17_000 + Math.floor(Math.random() * 1000);
  mkdirSync(join(tmp, 'config', 'aios'), { recursive: true });
  const role = `baseUrl = "http://127.0.0.1:${mockPort}/v1"\nmodel = "mock/model"\napiKeyRef = "keyring:model-chat"\n`;
  writeFileSync(
    join(tmp, 'config', 'aios', 'config.toml'),
    `[user]\nname = "John"\ntimezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone}"\n` +
      `[models.chat]\n${role}[models.triage]\n${role}[models.nightly]\n${role}` +
      `[mail]\naddress = "john@aios.test"\nusername = "john@aios.test"\npasswordRef = "keyring:mail"\nbatchWindowSeconds = 2\n` +
      `imap = { host = "127.0.0.1", port = 3143, tls = false }\nsmtp = { host = "127.0.0.1", port = 3025, tls = false }\n` +
      `[ui]\nport = ${port}\nkiosk = false\n`,
  );

  let coreLog = '';
  let core: ChildProcess | undefined;
  // Own process group, so stopping it also stops the tsx/node children pnpm starts.
  const stopCore = async () => {
    if (!core?.pid || core.exitCode !== null) return;
    const exited = new Promise((r) => core!.once('exit', r));
    process.kill(-core.pid, 'SIGTERM');
    await exited;
  };
  const startCore = async () => {
    const started = coreLog.length;
    core = spawn('pnpm', ['--silent', '--filter', '@aios/core', 'start'], {
      cwd: root,
      detached: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(tmp, 'config'), XDG_DATA_HOME: join(tmp, 'data'), HOME: tmp, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    core.stdout?.on('data', (d) => (coreLog += d));
    core.stderr?.on('data', (d) => (coreLog += d));
    const up = await waitFor(async () => coreLog.slice(started).includes('listening'), 20_000);
    if (!up) throw new Error(`aios-core did not start:\n${coreLog}`);
  };
  await startCore();
  process.on('exit', () => {
    if (core?.pid && core.exitCode === null) process.kill(-core.pid, 'SIGTERM');
  });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // Newer Chromium returns a Promise from scrollIntoView(); mimic it so effects that leak the return value fail here.
    await page.addInitScript(`{
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (...args) { orig.apply(this, args); return Promise.resolve(); };
    }`);
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    const chat = page.getByTestId('chat');
    const input = page.getByTestId('input');
    const agentState = page.getByTestId('agent-state');
    const lastAssistant = () => page.locator('[data-kind="assistant"]').last();

    // 1. Boot: greeting and live status.
    check('greeting on boot', await waitFor(async () => /(Hello|Morning|Afternoon|Evening), John/.test(await chat.innerText())));
    const hhmm = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    check('status strip shows the current time', (await page.getByTestId('clock').innerText()) === hhmm, await page.getByTestId('clock').innerText());
    check('agent idle at start', (await agentState.innerText()).includes('idle'));
    const costBefore = await page.getByTestId('cost').innerText();
    await shot(page, '1-boot');

    // 2. Streaming chat.
    await input.fill('hello');
    await input.press('Enter');
    check('reply streams in', await waitFor(async () => (await lastAssistant().getAttribute('data-streaming')) === 'true'));
    check('reply completes', await waitFor(async () => (await lastAssistant().innerText()).includes('token by token') && (await lastAssistant().getAttribute('data-streaming')) === null));
    check('markdown renders', (await lastAssistant().locator('em').count()) === 1);
    check('cost in status strip updates', await waitFor(async () => (await page.getByTestId('cost').innerText()) !== costBefore), `${costBefore} → ${await page.getByTestId('cost').innerText()}`);
    await shot(page, '2-chat');

    // 3. now() tool round trip.
    await input.fill('what time is it?');
    await input.press('Enter');
    check('tool status line appears', await waitFor(async () => (await page.locator('[data-kind="tool"]').last().innerText()).includes('Checking the time')));
    check('answer uses the tool result', await waitFor(async () => /It's \d\d:\d\d right now/.test(await lastAssistant().innerText())));
    await shot(page, '3-tool');

    // 4. Esc stops generation.
    await input.fill('write a long essay');
    await input.press('Enter');
    check('agent shows working while streaming', await waitFor(async () => (await agentState.innerText()).includes('working')));
    await sleep(500);
    await page.keyboard.press('Escape');
    check('Esc stops the reply', await waitFor(async () => (await lastAssistant().innerText()).includes('Stopped')));
    const words = ((await lastAssistant().innerText()).match(/Word\d+/g) ?? []).length;
    check('partial text kept, stream cut short', words > 0 && words < 200, `${words} words`);
    check('agent back to idle', await waitFor(async () => (await agentState.innerText()).includes('idle')));
    await shot(page, '4-stopped');

    // 5. Slash commands.
    await input.fill('/pause');
    await input.press('Enter');
    check('/pause shows paused in status strip', await waitFor(async () => (await agentState.innerText()).includes('paused')));
    await input.fill('/cost');
    await input.press('Enter');
    check('/cost reports spend', await waitFor(async () => /Today: \$0\.\d{4} across 4 model calls/.test(await page.locator('[data-kind="notice"]').last().innerText())));
    await shot(page, '5-commands');
    await input.fill('/resume');
    await input.press('Enter');
    check('/resume returns to idle', await waitFor(async () => (await agentState.innerText()).includes('idle')));

    // 6. History survives a reload.
    await page.reload();
    check('history restored after reload', await waitFor(async () => (await chat.innerText()).includes('token by token')));

    // 7. Memory: a card, nothing saved until Save, and the fact survives a restart.
    await input.fill('Please remember that Sara prefers short emails');
    await input.press('Enter');
    const card = page.locator('[data-kind="memory"]').last();
    check('remember shows a Save/Skip card', await waitFor(async () => (await card.getAttribute('data-state')) === 'pending'));
    await input.fill('/memory');
    await input.press('Enter');
    check('nothing saved before the click', await waitFor(async () => /Facts[^]*None yet/.test(await page.locator('[data-kind="notice"]').last().innerText())));
    await shot(page, '6-memory-card');
    await card.getByTestId('memory-save').click();
    check('Save marks the card saved', await waitFor(async () => (await card.getAttribute('data-state')) === 'saved'));
    await stopCore();
    await startCore();
    await page.reload();
    await waitFor(async () => (await agentState.innerText()).includes('idle'));
    await input.fill('/memory');
    await input.press('Enter');
    check('fact persists across a restart', await waitFor(async () => (await page.locator('[data-kind="notice"]').last().innerText()).includes('- Sara prefers short emails')));
    await shot(page, '7-memory-after-restart');
    // 8. Mail (needs `pnpm test:stack:up`): new mail becomes one triaged notification.
    if (await mailStackUp()) {
      check('status strip shows mail connected', await waitFor(async () => (await page.getByTestId('status').innerText()).includes('Mail: connected'), 15_000));
      const stamp = Date.now();
      await deliverTestMail(`E2E urgent ${stamp}`);
      await deliverTestMail(`E2E normal ${stamp}`);
      const note = page.locator('[data-kind="notification"]').last();
      check('new mail posts one notification', await waitFor(async () => (await note.count()) > 0 && (await note.getByTestId('mail-row').count()) === 2, 40_000));
      check('notification headline counts urgent mail', (await note.innerText()).includes('2 new emails. 1 looks urgent.'));
      await shot(page, '8-mail-notification');
      await note.getByTestId('mail-ignore').last().click();
      check('Ignore greys out the row', await waitFor(async () => (await note.getByTestId('mail-ignore').count()) === 1));
      await note.getByTestId('mail-read').first().click();
      check('Read opens the email through mail_read', await waitFor(async () => (await lastAssistant().innerText()).includes(`That email is about: E2E urgent ${stamp}`), 15_000));
      await shot(page, '9-mail-read');

      // 9. Reply flow (A5): Draft reply → card → Edit → Send transmits exactly the shown text; Discard sends nothing.
      await note.getByTestId('mail-draft-reply').first().click();
      const draft = page.locator('[data-kind="draft"]').last();
      check('Draft reply shows a pending draft card', await waitFor(async () => (await draft.getAttribute('data-state')) === 'pending', 15_000));
      check('draft is addressed to the sender', (await draft.getByTestId('draft-to-text').innerText()) === 'sara.kaya@northwind.example');
      check('nothing in Sent before the click', (await sentMatching(`E2E urgent ${stamp}`)).length === 0);
      await shot(page, '10-draft-card');
      await draft.getByTestId('draft-edit').click();
      const edited = `Edited by John ${stamp}: I can do it today.\nBest, John`;
      await draft.getByTestId('draft-body').fill(edited);
      await draft.getByTestId('draft-save').click();
      check('Edit updates the card', await waitFor(async () => (await draft.getByTestId('draft-body-text').innerText()) === edited));
      await shot(page, '11-draft-edited');
      await draft.getByTestId('draft-send').click();
      check('Send marks the card sent', await waitFor(async () => (await draft.getAttribute('data-state')) === 'sent', 15_000));
      const sent = await sentMatching(`E2E urgent ${stamp}`);
      check('the edited text is what was sent', sent.length === 1 && sent[0]!.replace(/\r\n/g, '\n').trimEnd() === edited, JSON.stringify(sent));
      await shot(page, '12-draft-sent');

      await note.getByTestId('mail-draft-reply').first().click();
      const second = page.locator('[data-kind="draft"]').last();
      check('a second draft card appears', await waitFor(async () => (await page.locator('[data-kind="draft"]').count()) === 2 && (await second.getAttribute('data-state')) === 'pending', 15_000));
      await second.getByTestId('draft-discard').click();
      check('Discard marks the card discarded', await waitFor(async () => (await second.getAttribute('data-state')) === 'discarded'));
      await sleep(1000);
      check('Discard sent nothing', (await sentMatching(`E2E urgent ${stamp}`)).length === 1);
    } else if (process.env.AIOS_REQUIRE_STACK === '1') {
      check('GreenMail test stack is reachable', false);
    } else {
      console.log('SKIP  mail checks (GreenMail not running; `pnpm test:stack:up` to include them)');
    }
    // 9. A7: a lasting outage says what to do; a brief one does not. The banner clears on reconnect.
    await stopCore();
    await sleep(2000);
    check('a brief outage shows no banner', (await page.getByTestId('offline').count()) === 0);
    check('a lasting outage shows the offline banner', await waitFor(async () => (await page.getByTestId('offline').count()) === 1, 10_000));
    await startCore();
    check('the banner clears when the service is back', await waitFor(async () => (await page.getByTestId('offline').count()) === 0, 20_000));
    check('every server event was understood by the page', (await page.getByTestId('outdated').count()) === 0);
    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
  } catch (err) {
    console.log(`\n--- aios-core output ---\n${coreLog}`);
    throw err;
  } finally {
    await browser.close();
    await stopCore();
    mock.close();
  }
  if (failures) console.log(`\n--- aios-core output ---\n${coreLog}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`e2e failed: ${(err as Error).message}`);
  process.exit(1);
});
