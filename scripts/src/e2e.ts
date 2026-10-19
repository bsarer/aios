/**
 * End-to-end check of the chat shell in a real browser, with a mock model.
 * `pnpm test:e2e [--shots <dir>]`
 *
 * Starts an in-process OpenAI-compatible mock, runs aios-core against it with a
 * throwaway config, data dir and fake keyring, then drives Chromium through the
 * A2 acceptance checks: streaming chat, the now() tool, Esc to stop, slash
 * commands, and live status values. Never touches real accounts or keys.
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
import { type Page, chromium } from 'playwright-core';

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
  const body = JSON.parse(raw) as { messages: { role: string; content: string | null }[] };
  const last = body.messages.at(-1)!;
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const finish = (cost: number) => {
    chunk(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 40, cost } });
    res.end('data: [DONE]\n\n');
  };

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
  writeFileSync(join(bin, 'secret-tool'), '#!/bin/sh\n[ "$1" = lookup ] && printf test-key && exit 0\nexit 1\n');
  chmodSync(join(bin, 'secret-tool'), 0o755);
  const port = 17_000 + Math.floor(Math.random() * 1000);
  mkdirSync(join(tmp, 'config', 'aios'), { recursive: true });
  const role = `baseUrl = "http://127.0.0.1:${mockPort}/v1"\nmodel = "mock/model"\napiKeyRef = "keyring:model-chat"\n`;
  writeFileSync(
    join(tmp, 'config', 'aios', 'config.toml'),
    `[user]\nname = "John"\ntimezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone}"\n` +
      `[models.chat]\n${role}[models.triage]\n${role}[models.nightly]\n${role}` +
      `[mail]\naddress = "john@aios.test"\nusername = "john@aios.test"\npasswordRef = "keyring:mail"\n` +
      `imap = { host = "127.0.0.1", port = 3143, tls = false }\nsmtp = { host = "127.0.0.1", port = 3025, tls = false }\n` +
      `[ui]\nport = ${port}\nkiosk = false\n`,
  );

  const core: ChildProcess = spawn('pnpm', ['--silent', '--filter', '@aios/core', 'start'], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(tmp, 'config'), XDG_DATA_HOME: join(tmp, 'data'), HOME: tmp, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let coreLog = '';
  core.stdout?.on('data', (d) => (coreLog += d));
  core.stderr?.on('data', (d) => (coreLog += d));
  const up = await waitFor(async () => coreLog.includes('listening'), 20_000);
  if (!up) throw new Error(`aios-core did not start:\n${coreLog}`);

  process.on('exit', () => core.kill('SIGTERM'));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
  } catch (err) {
    console.log(`\n--- aios-core output ---\n${coreLog}`);
    throw err;
  } finally {
    await browser.close();
    core.kill('SIGTERM');
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
