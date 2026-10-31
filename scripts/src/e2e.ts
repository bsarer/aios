/**
 * End-to-end check of the chat shell in a real browser, with a mock model.
 * `pnpm test:e2e [--shots <dir>]`
 *
 * Starts an in-process OpenAI-compatible mock, runs aios-core against it with a
 * throwaway config, data dir and fake keyring, then drives Chromium through the
 * acceptance checks: streaming chat, the now() tool, Esc to stop, slash commands,
 * live status values, memory cards and, with the GreenMail stack up, new-mail
 * notifications, the reply flow and opening attachments; C1: the calendar against a pretend
 * Google Calendar (fixtures/calendar.ts); D1: Word and Excel files through pretend WordCraft and
 * GridCraft tools (fixtures/documents.ts). Never touches real accounts or keys.
 *
 * Chromium: $CHROMIUM_PATH, else `chromium` on PATH.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { ImapFlow } from 'imapflow';
import { type Page, chromium } from 'playwright-core';
import { utcToLocal, zonedToUtc } from '@aios/core';
import { FAKE_CLIENT_ID, calendarFixtures, startFakeGoogleCalendar } from '../../fixtures/calendar.js';
import { makeDocFixture } from '../../fixtures/documents.js';
import { type FixtureMail, john, makePdf } from '../../fixtures/mail.js';
import { composeFixture } from './compose.js';
import { TEST_MAILBOX } from './mailbox.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : undefined;

// ── Mock model ───────────────────────────────────────────────────────────────

/** C1: the calendar fixtures are relative to today, in this machine's zone like the config. */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = utcToLocal(Date.now(), TZ).slice(0, 10);
const calDay = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const calAt = (n: number, hhmm: string) => zonedToUtc(`${calDay(n)}T${hhmm}`, TZ).toISOString();

const chunk = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { stream?: boolean; response_format?: unknown; messages: { role: string; content: string | null }[] };
  const last = body.messages.at(-1)!;
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (body.response_format) {
    // Triage: one item per wrapped message; the first is urgent, the rest low priority.
    const ids = [...(last.content ?? '').matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    const items = ids.map((id, i) => ({ id, urgency: i === 0 ? 'high' : 'low', summary: `Mock summary ${i + 1}`, needs_reply: i === 0, suggested_action: 'read', category: 'work' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 60, cost: 0.0002 } }));
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const finish = (cost: number) => {
    chunk(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 40, cost } });
    res.end('data: [DONE]\n\n');
  };

  // C1: calendar. A real model would call these from the user's words; the mock maps fixed phrases.
  const toolCall = (name: string, args: unknown) => {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_c', function: { name, arguments: JSON.stringify(args) } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    res.end('data: [DONE]\n\n');
  };
  if (last.role === 'user' && /^what'?s on tomorrow\??$/i.test(lastUser)) return toolCall('calendar_list', { from: calDay(1) });
  if (last.role === 'user' && /^move my standup to 11$/i.test(lastUser)) return toolCall('calendar_update_event', { id: 'standup1', start: `${calDay(1)}T11:00` });
  if (last.role === 'user' && /^cancel my lunch$/i.test(lastUser)) return toolCall('calendar_cancel_event', { id: 'lunch1' });
  if (last.role === 'tool' && /<untrusted source="calendar"/.test(last.content ?? '')) {
    const titles = [...(last.content ?? '').matchAll(/^Title: (.*)$/gm)].map((m) => m[1]);
    chunk(res, { choices: [{ delta: { content: `Tomorrow: ${titles.join('; ')}.` } }] });
    return finish(0.0004);
  }
  if (last.role === 'tool' && /^A card (with the change|asking to cancel)/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'The card is ready; nothing changes until you click it.' } }] });
    return finish(0.0004);
  }
  // Notifications: "why was that low-priority email low?" goes through mail_recent.
  if (last.role === 'user' && /low.priority email/i.test(lastUser)) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_n', function: { name: 'mail_recent', arguments: '{}' } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /from recent notifications/.test(last.content ?? '')) {
    const low = /Subject: (.*)\nReceived: .*\nPriority: low/.exec(last.content ?? '')?.[1] ?? 'none';
    chunk(res, { choices: [{ delta: { content: `The low-priority one is: ${low}` } }] });
    return finish(0.0004);
  }
  // S2: attachments. Show posts a card; read answers with a line of the attachment's text.
  const attachmentCall = last.role === 'user' ? /^(open|what does) attachment (\d+) of email (\S+)(?: say)?$/i.exec(lastUser) : null;
  if (attachmentCall) {
    const name = attachmentCall[1]!.toLowerCase() === 'open' ? 'mail_attachment_show' : 'mail_attachment_read';
    const args = JSON.stringify({ id: attachmentCall[3], attachment: Number(attachmentCall[2]) });
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name, arguments: args } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /^A card for attachment/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'It is on the card; click Open.' } }] });
    return finish(0.0004);
  }
  if (last.role === 'tool' && /<untrusted source="email"[^>]*>\nAttachment: /.test(last.content ?? '')) {
    const line = (last.content ?? '').split('\n').find((l) => /Lakeside/.test(l)) ?? 'nothing I recognise';
    chunk(res, { choices: [{ delta: { content: `The attachment says: ${line}` } }] });
    return finish(0.0004);
  }
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
  // S4: building an app ("make me a pomodoro timer" builds "Pomodoro"), and asking how it is going.
  const buildAsk = last.role === 'user' ? /^make me (an? (\w+) (?:timer|app))$/i.exec(lastUser) : null;
  const buildCall = buildAsk
    ? ['build_app', { name: buildAsk[2]![0]!.toUpperCase() + buildAsk[2]!.slice(1), request: buildAsk[1] }]
    : last.role === 'user' && /^how is my build going\?$/i.test(lastUser)
      ? ['build_status', {}]
      : null;
  if (buildCall) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_build', function: { name: buildCall[0], arguments: JSON.stringify(buildCall[1]) } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /^A card in the chat now asks the user to confirm building/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'Click Build on the card to start.' } }] });
    return finish(0.0004);
  }
  if (last.role === 'tool' && /^App builds, newest first:/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: last.content ?? '' } }] });
    return finish(0.0004);
  }
  // D1: documents. Show the sales workbook as a card, or read the report and quote it.
  const docCall = last.role === 'user' ? (/^show my sales spreadsheet$/i.test(lastUser) ? ['doc_show', { path: 'Finance/sales.xlsx' }] : /^what does report\.docx say$/i.test(lastUser) ? ['doc_read', { path: 'report.docx' }] : null) : null;
  if (docCall) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_doc', function: { name: docCall[0], arguments: JSON.stringify(docCall[1]) } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /^A card for the (Word|Excel) file/.test(last.content ?? '')) {
    chunk(res, { choices: [{ delta: { content: 'The card is in the chat; open it there.' } }] });
    return finish(0.0004);
  }
  if (last.role === 'tool' && /<untrusted source="document"/.test(last.content ?? '')) {
    const line = (last.content ?? '').split('\n').find((l) => /lease/.test(l)) ?? '';
    chunk(res, { choices: [{ delta: { content: `The report says: ${line}` } }] });
    return finish(0.0004);
  }
  // S3: apps. List them, or start one; then answer with one line.
  const appCall = last.role === 'user' ? (/^what apps do i have\??$/i.test(lastUser) ? ['apps_list', {}] : /^open (\w+)$/i.test(lastUser) && !/attachment/i.test(lastUser) ? ['open_app', { app: /^open (\w+)$/i.exec(lastUser)![1] }] : null) : null;
  if (appCall) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_app', function: { name: appCall[0], arguments: JSON.stringify(appCall[1]) } }] } }] });
    chunk(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.0003 } });
    return void res.end('data: [DONE]\n\n');
  }
  if (last.role === 'tool' && /^\d+ apps? installed:|^Started /.test(last.content ?? '')) {
    const text = (last.content ?? '').startsWith('Started') ? `${/^Started ([^.]+)/.exec(last.content ?? '')![1]} is open.` : (last.content ?? '');
    chunk(res, { choices: [{ delta: { content: text } }] });
    return finish(0.0004);
  }
  // S1: answer with the system tool's own result line.
  if (last.role === 'tool' && /^Volume is now|Nothing has changed yet/.test(last.content ?? '')) {
    const text = /Nothing has changed yet/.test(last.content ?? '') ? 'The Turn off button is on the card.' : (last.content ?? '');
    chunk(res, { choices: [{ delta: { content: text } }] });
    return finish(0.0004);
  }
  const systemCall = last.role === 'user' ? (/^set the volume to (\d+)$/i.exec(lastUser) ? ['volume_set', { percent: Number(/(\d+)$/.exec(lastUser)![1]) }] : /^turn off wi-?fi$/i.test(lastUser) ? ['wifi_off', {}] : null) : null;
  if (systemCall) {
    chunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: systemCall[0], arguments: JSON.stringify(systemCall[1]) } }] } }] });
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

const PNG_2PX = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwPAfhP7//w8AH+4F+3uLQwgAAAAASUVORK5CYII=';

/** A message with a PDF, a picture and a text file; returns its mail id (INBOX:<uid>). */
async function deliverAttachmentMail(subject: string): Promise<string> {
  const mail: FixtureMail = {
    key: `e2e-att-${Date.now()}`,
    folder: 'INBOX',
    from: { name: 'Lena Fischer', address: 'lena@eventspace.example' },
    to: [john],
    subject,
    daysAgo: 0,
    seen: false,
    text: 'Venue list, a photo and my notes are attached.',
    attachments: [
      { filename: 'venues.pdf', contentType: 'application/pdf', content: makePdf(['Offsite venues', '1. Lakeside Lodge: 2,900 EUR']) },
      { filename: 'room.png', contentType: 'image/png', content: PNG_2PX, encoding: 'base64' },
      { filename: 'notes.txt', contentType: 'text/plain', content: 'Bring the projector.\nLunch at 12:30.' },
    ],
  };
  const { raw } = await composeFixture(mail, new Map(), new Date());
  const c = new ImapFlow({ host: TEST_MAILBOX.host, port: TEST_MAILBOX.imapPort, secure: false, auth: { user: TEST_MAILBOX.user, pass: TEST_MAILBOX.pass }, logger: false });
  await c.connect();
  try {
    await c.append('INBOX', raw);
    await c.mailboxOpen('INBOX', { readOnly: true });
    const uids = (await c.search({ subject }, { uid: true })) || [];
    return `INBOX:${uids.at(-1)}`;
  } finally {
    await c.logout();
  }
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
  // S4: a built app trying the network would hit /probe; its policy must stop it first.
  let probeHits = 0;
  const mock = createServer((req, res) => {
    if (req.url?.startsWith('/probe')) {
      probeHits++;
      res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' });
      return void res.end('reached');
    }
    void mockModel(req, res);
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = (mock.address() as AddressInfo).port;

  const tmp = mkdtempSync(join(tmpdir(), 'aios-e2e-'));
  const bin = join(tmp, 'bin');
  mkdirSync(bin);
  // Fake keyring: the GreenMail test password for the mail account, a dummy key for the model.
  // C1: the pretend Google Calendar, and its refresh token in the fake keyring.
  const gcal = await startFakeGoogleCalendar(calendarFixtures(calAt, calDay));
  writeFileSync(
    join(bin, 'secret-tool'),
    '#!/bin/sh\n[ "$1" = lookup ] || exit 1\n[ "$5" = mail ] && printf test-only-password && exit 0\n[ "$5" = calendar-google ] && printf test-only-refresh-token && exit 0\nprintf test-key\n',
  );
  chmodSync(join(bin, 'secret-tool'), 0o755);
  // Fake Omarchy commands for the system controls (S1), keeping their state in files.
  const state = join(tmp, 'system-state');
  mkdirSync(state);
  writeFileSync(join(state, 'volume'), '55\n');
  writeFileSync(join(state, 'radio'), 'enabled\n');
  const fakes: Record<string, string> = {
    'omarchy-audio-output-sink': 'echo alsa_output.speakers',
    pactl: [
      'case "$1" in',
      '  get-sink-volume) echo "Volume: front-left: 1 /  $(cat "$S/volume")% / 0 dB" ;;',
      '  get-sink-mute) echo "Mute: no" ;;',
      '  get-default-sink) echo alsa_output.speakers ;;',
      `  -f) echo '[{"index":50,"name":"alsa_output.speakers","description":"Speakers"}]' ;;`,
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
    'omarchy-audio-output-volume': 'v=$(cat "$S/volume")\ncase "$1" in +*) v=$((v + ${1#+})) ;; -*) v=$((v - ${1#-})) ;; *) exit 1 ;; esac\necho $v > "$S/volume"',
    nmcli: [
      'case "$*" in',
      '  "radio wifi") cat "$S/radio" ;;',
      '  "radio wifi off") echo disabled > "$S/radio" ;;',
      '  "radio wifi on") echo enabled > "$S/radio" ;;',
      '  *ACTIVE,SSID*) grep -q enabled "$S/radio" && echo "yes:Home" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  };
  // S3: a pretend Hyprland. hyprctl reports one fullscreen chat window and one 1920x1200 monitor
  // with a 26 px bar, and records every dispatch; gtk-launch records the app it was asked to start.
  writeFileSync(join(state, 'dispatches'), '');
  writeFileSync(join(state, 'launched'), '');
  fakes.hyprctl = [
    'case "$1 $2" in',
    `  "-j clients") echo '[{"address":"0xc4a7","class":"org.aios.home","floating":false,"pinned":false,"fullscreen":2,"monitor":0}]' ;;`,
    `  "-j monitors") echo '[{"id":0,"width":1920,"height":1200,"x":0,"y":0,"scale":1,"transform":0,"focused":true,"reserved":[0,26,0,0]}]' ;;`,
    '  dispatch*) printf "%s\\n" "$2" >> "$S/dispatches"; echo ok ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n');
  fakes['uwsm-app'] = '[ "$1" = -- ] && shift\nexec "$@"';
  fakes['gtk-launch'] = 'echo "$1" >> "$S/launched"';
  // S4: a pretend Claude Code, signed in with a plan. It notes how it was run, says it is writing
  // index.html, waits for the test to let it go on ($S/claude-go), and writes an app that tries
  // the network. $S/claude-mode makes it hang until stopped (stop) or hit its cap (fail).
  fakes.claude = [
    `if [ "$1" = auth ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi`,
    'pwd > "$S/claude-cwd"',
    'printf "%s\\n" "$@" > "$S/claude-args"',
    'cat > "$S/claude-stdin"',
    'mode=$(cat "$S/claude-mode" 2>/dev/null)',
    `if [ "$mode" = fail ]; then echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"result":"","total_cost_usd":1.02}'; exit 1; fi`,
    `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"index.html"}}]}}'`,
    'if [ "$mode" = stop ]; then sleep 60; exit 0; fi',
    'i=0; while [ ! -f "$S/claude-go" ] && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done',
    `printf '%s' '<!doctype html><html><head><title>Pomodoro</title></head><body><p id="local">waiting</p><p id="net">waiting</p><script src="app.js"></script></body></html>' > index.html`,
    `printf '%s' "document.getElementById('local').textContent = 'local script ran'; fetch('http://127.0.0.1:${mockPort}/probe').then(() => { document.getElementById('net').textContent = 'reached' }, () => { document.getElementById('net').textContent = 'blocked' });" > app.js`,
    `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"app.js"}}]}}'`,
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"A 25-minute focus timer.","total_cost_usd":0.31}'`,
  ].join('\n');
  fakes.chromium = 'exit 0';
  fakes['notify-send'] = 'printf "%s|" "$@" >> "$S/notified"; echo >> "$S/notified"';
  const apps = join(tmp, 'data', 'applications');
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, 'firefox.desktop'), '[Desktop Entry]\nType=Application\nName=Firefox\nComment=Browse the web\nExec=firefox %u\nCategories=Network;WebBrowser;\n');
  writeFileSync(join(apps, 'btop.desktop'), '[Desktop Entry]\nType=Application\nName=btop\nComment=Resource monitor\nExec=btop\nTerminal=true\n');
  writeFileSync(join(apps, 'hidden.desktop'), '[Desktop Entry]\nType=Application\nName=Hidden helper\nExec=helper\nNoDisplay=true\n');
  const hyprDir = join(tmp, 'run', 'hypr', 'e2e');
  mkdirSync(hyprDir, { recursive: true });
  const hyprSockets = new Set<import('node:net').Socket>();
  const hyprEvents = createNetServer((sock) => {
    hyprSockets.add(sock);
    sock.on('close', () => hyprSockets.delete(sock));
  });
  await new Promise<void>((r) => hyprEvents.listen(join(hyprDir, '.socket2.sock'), r));
  const hyprEmit = (line: string) => {
    for (const sock of hyprSockets) sock.write(`${line}\n`);
  };
  const dispatches = () => readFileSync(join(state, 'dispatches'), 'utf8').trim().split('\n').filter(Boolean);
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nS="${state}"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const fakeState = (name: string) => readFileSync(join(state, name), 'utf8').trim();
  const port = 17_000 + Math.floor(Math.random() * 1000);
  // D1: fixture documents and pretend WordCraft/GridCraft tools.
  const docs = makeDocFixture();
  mkdirSync(join(tmp, 'config', 'aios'), { recursive: true });
  const role = `baseUrl = "http://127.0.0.1:${mockPort}/v1"\nmodel = "mock/model"\napiKeyRef = "keyring:model-chat"\n`;
  writeFileSync(
    join(tmp, 'config', 'aios', 'config.toml'),
    `[user]\nname = "John"\ntimezone = "${Intl.DateTimeFormat().resolvedOptions().timeZone}"\n` +
      `[models.chat]\n${role}[models.triage]\n${role}[models.nightly]\n${role}` +
      `[mail]\naddress = "john@aios.test"\nusername = "john@aios.test"\npasswordRef = "keyring:mail"\nbatchWindowSeconds = 2\n` +
      `imap = { host = "127.0.0.1", port = 3143, tls = false }\nsmtp = { host = "127.0.0.1", port = 3025, tls = false }\n` +
      `[calendar]\nclientId = "${FAKE_CLIENT_ID}"\napiBaseUrl = "${gcal.apiBaseUrl}"\ntokenUrl = "${gcal.tokenUrl}"\n` +
      `[docs]\nroots = ["${docs.documents}"]\nwordCli = "${docs.wordCli}"\nsheetCli = "${docs.sheetCli}"\n` +
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
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        XDG_CONFIG_HOME: join(tmp, 'config'),
        XDG_DATA_HOME: join(tmp, 'data'),
        XDG_DATA_DIRS: join(tmp, 'share'),
        XDG_RUNTIME_DIR: join(tmp, 'run'),
        HYPRLAND_INSTANCE_SIGNATURE: 'e2e',
        XDG_CURRENT_DESKTOP: 'Hyprland',
        HOME: tmp,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
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

    // S1. System controls: a small change runs straight away; Wi-Fi off waits for a click.
    await input.fill('set the volume to 30');
    await input.press('Enter');
    check('"set the volume to 30" changes the volume', await waitFor(async () => (await lastAssistant().innerText()).includes('Volume is now 30% (was 55%)')));
    check('the volume really is 30', fakeState('volume') === '30', fakeState('volume'));
    await input.fill('turn off wifi');
    await input.press('Enter');
    const wifiCard = page.locator('[data-kind="action"]').last();
    check('"turn off wifi" shows a card instead', await waitFor(async () => (await wifiCard.getAttribute('data-state')) === 'pending'));
    check('Wi-Fi still on before the click', fakeState('radio') === 'enabled');
    await shot(page, 's1-wifi-card');
    await wifiCard.getByTestId('action-cancel').click();
    check('Cancel marks the card cancelled', await waitFor(async () => (await wifiCard.getAttribute('data-state')) === 'cancelled'));
    check('Cancel leaves Wi-Fi on', fakeState('radio') === 'enabled');
    await input.fill('turn off wifi');
    await input.press('Enter');
    const wifiCard2 = page.locator('[data-kind="action"]').last();
    check('a second card appears', await waitFor(async () => (await page.locator('[data-kind="action"]').count()) === 2 && (await wifiCard2.getAttribute('data-state')) === 'pending'));
    await wifiCard2.getByTestId('action-confirm').click();
    check('Turn off runs it', await waitFor(async () => (await wifiCard2.getAttribute('data-state')) === 'done'));
    check('Wi-Fi is off', fakeState('radio') === 'disabled');
    check('status strip shows Wi-Fi off', await waitFor(async () => (await page.getByTestId('status').innerText()).includes('Wi-Fi off')));
    await shot(page, 's1-wifi-off');

    // C1: calendar. Reading answers straight away; a change is a card until the click.
    const calWrites = () => gcal.requests.filter((r) => r.path.includes('/events') && r.method !== 'GET');
    await input.fill("what's on tomorrow?");
    await input.press('Enter');
    check('"what\'s on tomorrow" lists the events', await waitFor(async () => /Tomorrow: Team standup; Lunch with Sara; Design review/.test(await lastAssistant().innerText())));
    await input.fill('move my standup to 11');
    await input.press('Enter');
    const moveCard = page.locator('[data-kind="event"]').last();
    check('"move my standup" shows a calendar card', await waitFor(async () => (await moveCard.getAttribute('data-state')) === 'pending'));
    check('the card shows the old and new time', /10:00–10:15/.test(await moveCard.getByTestId('event-before').innerText()) && /11:00–11:15/.test(await moveCard.getByTestId('event-when').innerText()));
    check('the card names who gets an update', (await moveCard.getByTestId('event-attendees').innerText()).includes('ana@aios.test'));
    check('nothing reached the calendar before the click', calWrites().length === 0, JSON.stringify(calWrites()));
    await shot(page, 'c1-move-card');
    await moveCard.getByTestId('event-confirm').click();
    check('Change moves the event', await waitFor(async () => (await moveCard.getAttribute('data-state')) === 'done'));
    check('the calendar got exactly one change, with an update to the guests', calWrites().length === 1 && calWrites()[0]!.method === 'PATCH' && calWrites()[0]!.query.sendUpdates === 'all', JSON.stringify(calWrites()));
    check('the standup is at 11 now', Date.parse(gcal.events.get('standup1')?.start.dateTime ?? '') === Date.parse(calAt(1, '11:00')), JSON.stringify(gcal.events.get('standup1')?.start));
    await input.fill('cancel my lunch');
    await input.press('Enter');
    const cancelCard = page.locator('[data-kind="event"]').last();
    check('"cancel my lunch" shows a card', await waitFor(async () => (await cancelCard.getAttribute('data-change')) === 'cancel' && (await cancelCard.getAttribute('data-state')) === 'pending'));
    await cancelCard.getByTestId('event-discard').click();
    check('Discard leaves the lunch in the calendar', await waitFor(async () => (await cancelCard.getAttribute('data-state')) === 'discarded') && calWrites().length === 1);
    await shot(page, 'c1-discarded');

    // S3: apps. The chat lists installed apps, starts one, and steps aside as the orb until it closes.
    await input.fill('what apps do I have?');
    await input.press('Enter');
    check('the chat lists installed apps', await waitFor(async () => /Firefox \(id: firefox\): Browse the web/.test(await lastAssistant().innerText())));
    check('hidden apps are not listed', !(await lastAssistant().innerText()).includes('Hidden helper'));
    await input.fill('open firefox');
    await input.press('Enter');
    const orb = page.getByTestId('orb');
    check('"open firefox" starts it through gtk-launch', await waitFor(async () => fakeState('launched') === 'firefox.desktop'), fakeState('launched'));
    check('the chat becomes the orb', await waitFor(async () => (await orb.count()) === 1));
    check('Hyprland was asked to shrink, pin and place it', ['hl.dsp.window.pin({ action = "on", window = "address:0xc4a7" })', 'hl.dsp.window.move({ x = 932, y = 34, window = "address:0xc4a7" })'].every((d) => dispatches().includes(d)), dispatches().join(' | '));
    await page.setViewportSize({ width: 56, height: 56 });
    await shot(page, 's3-orb');
    await page.setViewportSize({ width: 1280, height: 800 });
    // Firefox's window opens; a window the user opens themselves doesn't count.
    hyprEmit('openwindow>>f1,1,firefox,Mozilla Firefox');
    hyprEmit('openwindow>>k1,1,kitty,Terminal');
    await orb.click();
    check('clicking the orb brings the chat back at half screen', await waitFor(async () => (await page.getByTestId('window-controls').count()) === 1 && (await chat.innerText()).includes('Firefox is open.')));
    check('Hyprland was asked for the right half, with focus', ['hl.dsp.window.resize({ x = 942, y = 1150, window = "address:0xc4a7" })', 'hl.dsp.focus({ window = "address:0xc4a7" })'].every((d) => dispatches().includes(d)));
    await shot(page, 's3-half');
    await page.keyboard.press('Escape');
    check('Esc at half screen goes back to the orb', await waitFor(async () => (await orb.count()) === 1));
    await orb.click();
    await page.getByTestId('window-orb').click();
    check('"Back to the orb" does too', await waitFor(async () => (await orb.count()) === 1));
    hyprEmit('closewindow>>k1');
    await sleep(500);
    check("closing the user's own window changes nothing", (await orb.count()) === 1);
    hyprEmit('closewindow>>f1');
    check('closing Firefox brings the chat back full screen', await waitFor(async () => (await orb.count()) === 0 && (await page.getByTestId('window-controls').count()) === 0 && (await input.count()) === 1));
    check('Hyprland was asked for fullscreen', dispatches().at(-2) === 'hl.dsp.window.fullscreen({ mode = "fullscreen", action = "set", window = "address:0xc4a7" })', dispatches().at(-2));
    await shot(page, 's3-back');

    // S4: building an app. A Build card with caps to pick, progress while Claude Code runs,
    // a message with Open when it is done, and the app is offline.
    const notified = () => (existsSync(join(state, 'notified')) ? fakeState('notified') : '');
    await input.fill('make me a pomodoro timer');
    await input.press('Enter');
    const buildCard = page.locator('[data-kind="action"]').last();
    const choice = (card: typeof buildCard, value: string) => card.locator(`[data-testid="action-choice"][data-value="${value}"]`);
    check(
      '"make me a pomodoro timer" shows a Build card with caps to pick',
      await waitFor(async () => (await buildCard.getAttribute('data-state')) === 'pending' && (await buildCard.getByTestId('action-choice').allInnerTexts()).join(',') === 'Build · up to $1,Build · up to $2,Build · up to $5'),
    );
    const buildNote = await buildCard.getByTestId('action-note').innerText();
    check('the card says there is no estimate yet, and what plan dollars mean', buildNote.includes('There are no past new builds to estimate the cost from yet.') && buildNote.includes("signed in with a Claude plan"), buildNote);
    check('the chat says to click Build to start', await waitFor(async () => (await lastAssistant().innerText()).includes('Click Build on the card to start.')));
    check('nothing is built before the click', !existsSync(join(state, 'claude-args')));
    await shot(page, 's4-build-card');
    await choice(buildCard, '2').click();
    check('the running card shows what Claude Code is doing, the time and the cap', await waitFor(async () => (await buildCard.getAttribute('data-state')) === 'running' && (await buildCard.getByTestId('action-progress').innerText()) === 'Writing index.html…' && (await buildCard.getByTestId('action-elapsed').innerText()).includes('stops at $2')), await buildCard.innerText());
    check('the cap picked is the one Claude Code got', fakeState('claude-args').includes('--max-budget-usd\n2\n'));
    await shot(page, 's4-building');
    await input.fill('how is my build going?');
    await input.press('Enter');
    check('the chat can say how the build is going', await waitFor(async () => /“Pomodoro”: building for less than a minute; now: Writing index\.html\. It stops at \$2 at most\./.test(await lastAssistant().innerText())), await lastAssistant().innerText());
    writeFileSync(join(state, 'claude-go'), '');
    check('the card says what it made', await waitFor(async () => (await buildCard.getAttribute('data-state')) === 'done' && (await buildCard.innerText()).includes('Built “Pomodoro” in less than a minute. A 25-minute focus timer. About $0.31 at API prices.')), await buildCard.innerText());
    const builtMsg = page.locator('[data-kind="build_result"]').last();
    check('a message says it is ready, with Open', (await builtMsg.getAttribute('data-ok')) === 'true' && (await builtMsg.innerText()).includes('“Pomodoro” is ready. A 25-minute focus timer.') && (await builtMsg.getByTestId('build-open').count()) === 1);
    check('a desktop notification says it is ready', notified().includes('--app-name=AI OS|Pomodoro is ready|'), notified());
    const appDir = join(tmp, 'data', 'aios', 'apps', 'pomodoro');
    check('Claude Code ran in the app folder, restricted, with the request on stdin', fakeState('claude-cwd') === appDir && fakeState('claude-args').includes('--restricted') && fakeState('claude-stdin') === 'a pomodoro timer', fakeState('claude-cwd'));
    await shot(page, 's4-built');
    await builtMsg.getByTestId('build-open').click();
    check('Open starts the built app', await waitFor(async () => fakeState('launched').split('\n').includes('aios-app-pomodoro.desktop')), fakeState('launched'));
    hyprEmit('openwindow>>b1d,1,aios-app-pomodoro,Pomodoro');
    hyprEmit('closewindow>>b1d');
    check('closing it brings the chat back', await waitFor(async () => (await page.getByTestId('orb').count()) === 0 && (await input.count()) === 1));
    // The built page itself, in Chromium: its own script runs, the network does not.
    const appPage = await browser.newPage();
    await appPage.goto(`file://${appDir}/index.html`);
    check("the built app's own script runs", await waitFor(async () => (await appPage.locator('#local').innerText()) === 'local script ran'));
    check('the built app cannot reach the network', await waitFor(async () => (await appPage.locator('#net').innerText()) === 'blocked') && probeHits === 0, `${await appPage.locator('#net').innerText()}, ${probeHits} hits`);
    await appPage.close();
    await page.bringToFront();
    // A build can be stopped from its card, and the next card has an estimate.
    writeFileSync(join(state, 'claude-mode'), 'stop');
    await input.fill('make me a notes app');
    await input.press('Enter');
    const notesCard = page.locator('[data-kind="action"]').last();
    check('the next Build card estimates from the last build', await waitFor(async () => (await notesCard.getAttribute('data-state')) === 'pending' && (await notesCard.getByTestId('action-note').innerText()).startsWith('Similar new builds cost about $0.31 (median of 1).')));
    await choice(notesCard, '1').click();
    check('the build starts', await waitFor(async () => (await notesCard.getByTestId('action-progress').count()) === 1));
    await notesCard.getByTestId('action-stop').click();
    check('Stop stops it and says so', await waitFor(async () => (await notesCard.getAttribute('data-state')) === 'cancelled' && (await notesCard.innerText()).includes("Stopped after less than a minute. The app wasn't added.")), await notesCard.innerText());
    check('a stopped build gets no message or notification', (await page.locator('[data-kind="build_result"]').count()) === 1 && !notified().includes('Notes'));
    // A failed build says why, in the chat and on the desktop.
    writeFileSync(join(state, 'claude-mode'), 'fail');
    await input.fill('make me a dice app');
    await input.press('Enter');
    const diceCard = page.locator('[data-kind="action"]').last();
    await waitFor(async () => (await diceCard.getAttribute('data-state')) === 'pending' && (await diceCard.innerText()).includes('Dice'));
    await choice(diceCard, '1').click();
    const failMsg = page.locator('[data-kind="build_result"]').last();
    check('a failed build says why on the card and in a message', await waitFor(async () => (await diceCard.getAttribute('data-state')) === 'failed' && (await failMsg.getAttribute('data-ok')) === 'false' && (await failMsg.innerText()).includes("Building “Dice” didn't work: it reached its $1 spending cap before finishing.")), await failMsg.innerText());
    check('a failed build has no Open button, and a notification says it failed', (await failMsg.getByTestId('build-open').count()) === 0 && notified().includes("Building Dice didn't work|"), notified());
    await shot(page, 's4-failed');
    // 8. Mail (needs `pnpm test:stack:up`): new mail becomes one triaged notification.
    if (await mailStackUp()) {
      check('status strip shows mail connected', await waitFor(async () => (await page.getByTestId('status').innerText()).includes('Mail: connected'), 15_000));
      const stamp = Date.now();
      await deliverTestMail(`E2E urgent ${stamp}`);
      await deliverTestMail(`E2E normal ${stamp}`);
      const note = page.locator('[data-kind="notification"]').last();
      check('new mail posts one notification', await waitFor(async () => (await note.count()) > 0 && (await note.getByTestId('mail-row').count()) === 2, 40_000));
      check('notification headline counts urgent mail', (await note.innerText()).includes('2 new emails. 1 looks urgent. 1 low-priority.'));
      check('low-priority mail keeps its buttons', (await note.getByTestId('mail-digest').getByTestId('mail-read').count()) === 1);
      await input.fill('why was that low-priority email low?');
      await input.press('Enter');
      check('the chat finds the low-priority email from the notification', await waitFor(async () => (await lastAssistant().innerText()).includes(`The low-priority one is: E2E normal ${stamp}`), 15_000));
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

      // 10. Attachments (S2): a card per attachment, each opening in the viewer; the model reads the PDF's text.
      const attId = await deliverAttachmentMail(`E2E attachments ${stamp}`);
      const kinds = [
        [1, 'pdf', 'PDF'],
        [2, 'image', 'picture'],
        [3, 'text', 'text file'],
      ] as const;
      for (const [n, kind, word] of kinds) {
        await input.fill(`open attachment ${n} of email ${attId}`);
        await input.press('Enter');
        const card = page.locator('[data-kind="attachment"]').last();
        check(`"open attachment" shows a card for the ${word}`, await waitFor(async () => (await page.locator('[data-kind="attachment"]').count()) === n, 15_000));
        await card.getByTestId('attachment-open').click();
        const viewer = page.getByTestId('attachment-viewer');
        check(`Open shows the ${word} in the viewer`, await waitFor(async () => (await viewer.getAttribute('data-state')) === kind, 15_000), (await viewer.getAttribute('data-state')) ?? '');
        if (kind === 'pdf') {
          check('the PDF is drawn', await waitFor(async () => (await page.locator('[data-testid="attachment-pages"] canvas').count()) === 1, 15_000));
          await sleep(500);
          check('drawing it raised no error', (await viewer.getAttribute('data-state')) === 'pdf' && (await page.getByTestId('attachment-error').count()) === 0);
          const box = await viewer.boundingBox();
          check('the viewer fills the window', box !== null && box.x === 0 && box.y === 0 && box.width === page.viewportSize()!.width, JSON.stringify(box));
        }
        if (kind === 'image') check('the picture loads', await waitFor(async () => (await page.getByTestId('attachment-image').evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)) === 2));
        if (kind === 'text') check('the text is shown as text', (await page.getByTestId('attachment-text').innerText()).includes('Lunch at 12:30.'));
        await shot(page, `13-attachment-${kind}`);
        await page.keyboard.press('Escape');
        check('Esc closes the viewer', await waitFor(async () => (await viewer.count()) === 0));
      }
      await input.fill(`what does attachment 1 of email ${attId} say`);
      await input.press('Enter');
      check('the model reads the PDF text', await waitFor(async () => (await lastAssistant().innerText()).includes('Lakeside Lodge: 2,900 EUR'), 15_000));
    } else if (process.env.AIOS_REQUIRE_STACK === '1') {
      check('GreenMail test stack is reachable', false);
    } else {
      console.log('SKIP  mail checks (GreenMail not running; `pnpm test:stack:up` to include them)');
    }
    // 11. Documents (D1): the model reads a Word file's text; a workbook opens as a table from a card.
    await input.fill('what does report.docx say');
    await input.press('Enter');
    check('the model reads the Word file', await waitFor(async () => (await lastAssistant().innerText()).includes('Renew the office lease by 15 November'), 15_000));
    await input.fill('show my sales spreadsheet');
    await input.press('Enter');
    check('"show my sales spreadsheet" shows a document card', await waitFor(async () => (await page.locator('[data-kind="document"]').count()) === 1, 15_000));
    check('the card names the file', (await page.getByTestId('document-name').innerText()) === 'sales.xlsx');
    await page.getByTestId('document-open').click();
    check('Open shows the sheet as a table', await waitFor(async () => (await page.getByTestId('document-sheet').count()) === 1, 15_000));
    check('the table holds the cells', (await page.getByTestId('document-sheet').innerText()).includes('Lamp'));
    check('both sheets have tabs', (await page.getByTestId('document-sheet-tab').count()) === 2);
    await shot(page, '14-document-sheet');
    await page.keyboard.press('Escape');
    check('Esc closes the document', await waitFor(async () => (await page.getByTestId('document-viewer').count()) === 0));
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
    hyprEvents.close();
    await gcal.close();
  }
  if (failures) console.log(`\n--- aios-core output ---\n${coreLog}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`e2e failed: ${(err as Error).message}`);
  process.exit(1);
});
