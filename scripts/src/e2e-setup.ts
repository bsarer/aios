/**
 * R2: the setup window end to end in Chromium, with pretend checks, keyring and desktop install.
 * `pnpm --filter @aios/scripts e2e:setup`. First run: every step, the failing and passing key and
 * sign-in tests, Gmail's app password steps, an unknown provider's server fields, and what the
 * finish call stores. Then Settings: answers come back prefilled and blank secrets are kept.
 * Never touches real accounts, keys or the desktop.
 *
 * Chromium: $CHROMIUM_PATH, else `chromium` on PATH.
 */
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Page, chromium } from 'playwright-core';
import { Wallpaper, wallpaperSamples } from '@aios/core';
import type { AiosConfig, SecretRef } from '@aios/shared';
import { readPresets } from './onboard/answers.js';
import { type SetupDeps, startSetupServer } from './onboard/server.js';
import { type LinkRunner, SignalLinker } from './onboard/signal.js';
import providers from '../providers.json' with { type: 'json' };

const here = dirname(fileURLToPath(import.meta.url));
const shotsArg = process.argv.indexOf('--shots');
const shots = shotsArg > 0 ? process.argv[shotsArg + 1] : undefined;
const FAKE_KEY = 'sk-or-v1-e2e-fake-key';
const FAKE_APP_PASSWORD = 'abcd efgh ijkl mnop';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`setup e2e: ${what}`);
  console.log(`  ✓ ${what}`);
}

/** SG1: a pretend signal-cli whose phone "scans" the code when the test says so. */
const signalPhone = { scan: () => undefined as void };
const pretendSignal: LinkRunner = {
  link(_command, onLine, onExit) {
    setTimeout(() => onLine('sgnl://linkdevice?uuid=e2e&pub_key=e2e'), 50);
    signalPhone.scan = () => onExit(0);
    return { kill: () => undefined };
  },
  listAccounts: async () => 'Number: +905550000001\n',
};

function fakeDeps(state: { config: AiosConfig | null; secrets: Map<SecretRef, string>; done: number; exits: number; installs: number; mailTests: { address: string; password: string; host: string }[]; addons: string[][]; wallpaper: Wallpaper }): SetupDeps {
  return {
    page: () => readFile(join(here, '..', 'onboard', 'page.html'), 'utf8'),
    presets: readPresets(providers as Record<string, unknown>),
    readConfig: async () => state.config,
    writeConfig: async (c) => void (state.config = c),
    keyring: {
      set: async (ref, v) => void state.secrets.set(ref, v),
      get: async (ref) => (state.secrets.has(ref) ? { reveal: () => state.secrets.get(ref)! } : null),
    },
    look: async () => ({
      name: 'John',
      timezone: 'Europe/Istanbul',
      folders: [{ path: '~/Documents' }, { path: '~/Downloads' }, { path: '~/Projects' }],
      apps: { wordcraft: null, gridcraft: null, wordcraftCli: null, gridcraftCli: null, mpv: '/usr/bin/mpv', claude: null, whisper: '/home/john/.local/src/whisper.cpp/build/bin/whisper-server', speech: true, embed: 'embeddinggemma', signal: '/usr/bin/signal-cli' },
      ollama: ['qwen3:8b'],
      screens: [
        { name: 'DP-1', width: 2560, height: 1440, focused: false },
        { name: 'eDP-1', width: 1920, height: 1200, focused: true },
      ],
      // Music is installed once the add-ons terminal has run.
      addons: [
        { id: 'video', label: 'Videos', blurb: 'Play videos.', installed: true },
        { id: 'music', label: 'Music controls', blurb: 'Pause and skip.', installed: state.addons.flat().includes('music') },
        { id: 'voice', label: 'Speak to Astra', blurb: 'whisper.cpp.', installed: false },
      ],
    }),
    installAddons: async (ids) => {
      state.addons.push(ids);
      return 'xdg-terminal-exec';
    },
    mx: async (address) => (address.endsWith('@example.org') ? ['aspmx.l.google.com.'] : []),
    checkAi: async ({ key }) => (key === FAKE_KEY ? { ok: true, message: 'OpenRouter answered.' } : { ok: false, message: 'OpenRouter rejected this key.', fix: 'Make a new key.' }),
    checkMail: async ({ address, password, servers }) => {
      state.mailTests.push({ address, password, host: servers.imap.host });
      return password === FAKE_APP_PASSWORD.replace(/\s/g, '') || password === 'other-pass'
        ? { ok: true, message: 'Signed in. Found Sent and Drafts.' }
        : { ok: false, message: 'Gmail did not accept this app password.', fix: 'Make a new app password.' };
    },
    installDesktop: async () => {
      state.installs++;
      return ['Started Astra in the background (astra.service).'];
    },
    signal: new SignalLinker(() => '/usr/bin/signal-cli', pretendSignal),
    wallpaper: state.wallpaper,
    done: () => void state.done++,
    exit: () => void state.exits++,
  };
}

const next = (p: Page) => p.click('#next');
async function until(ok: () => Promise<boolean>, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (await ok()) return;
  throw new Error('setup e2e: timed out');
}
const heading = (p: Page) => p.textContent('h1');

async function main(): Promise<void> {
  const state = { config: null as AiosConfig | null, secrets: new Map<SecretRef, string>(), done: 0, exits: 0, installs: 0, mailTests: [] as { address: string; password: string; host: string }[], addons: [] as string[][], wallpaper: new Wallpaper(mkdtempSync(join(tmpdir(), 'aios-e2e-wallpaper-')), () => wallpaperSamples({ themeDirs: [] })) };
  const server = await startSetupServer(fakeDeps(state));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? 'chromium' });
  const errors: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));

    console.log('First run');
    await page.goto(server.url);
    await page.waitForSelector('#name');
    check((await page.inputValue('#name')) === 'John', 'the name comes from the account');
    check((await page.inputValue('#tz')) === 'Europe/Istanbul', 'the timezone comes from the computer');
    await page.fill('#name', '');
    await next(page);
    check((await page.textContent('#err'))?.includes('Type the name'), 'an empty name keeps you on the step');
    await page.fill('#name', 'Johnny');
    await next(page);

    check((await heading(page))?.includes('Choose the AI'), 'the AI step');
    check((await page.inputValue('#model')) === 'anthropic/claude-haiku-5.5', 'the model is filled in from the provider');
    await next(page);
    check((await page.textContent('#err'))?.includes('Test key'), 'Next waits for a passing key test');
    await page.fill('#key', 'wrong');
    await page.click('#test-ai');
    await page.waitForSelector('.result.bad');
    check((await page.textContent('.result'))?.includes('rejected this key'), 'a rejected key says so, with a fix');
    await page.fill('#key', FAKE_KEY);
    await page.click('#test-ai');
    await page.waitForSelector('.result.ok');
    await page.check('#local');
    await next(page);

    check((await heading(page))?.includes('Connect your mail'), 'the mail step');
    await page.fill('#address', 'john@gmail.com');
    await page.dispatchEvent('#address', 'change');
    await page.waitForSelector('text=Gmail needs an app password');
    check(!(await page.$('#imap')), 'Gmail shows the app password steps and no server fields');
    await page.fill('#password', 'wrong');
    await page.click('#test-mail');
    await page.waitForSelector('.result.bad');
    check((await page.textContent('.result'))?.includes('did not accept'), 'a rejected app password says so');
    await page.fill('#address', 'john@mail.example.net');
    await page.dispatchEvent('#address', 'change');
    await page.waitForSelector('#imap');
    check(true, 'an unknown provider asks for its servers');
    await page.fill('#address', 'john@example.org');
    await page.dispatchEvent('#address', 'change');
    await page.waitForSelector('text=Gmail needs an app password');
    check(!(await page.$('#imap')), 'a Google Workspace domain is found by its mail servers');
    await page.fill('#password', FAKE_APP_PASSWORD);
    await page.click('#test-mail');
    await page.waitForSelector('.result.ok');
    check(state.mailTests.at(-1)?.host === 'imap.gmail.com' && state.mailTests.at(-1)?.password === 'abcdefghijklmnop', 'the sign-in test used Gmail with the spaces removed');
    await next(page);

    check((await heading(page))?.includes('calendar'), 'the calendar step');
    check((await page.textContent('#next')) === 'Skip for now', 'the calendar can be skipped');
    await next(page);
    check((await page.isChecked('[id="f-~/Documents"]')) && !(await page.isChecked('[id="f-~/Projects"]')), 'usual folders start ticked');
    await page.check('[id="f-~/Projects"]');
    await next(page);
    check((await heading(page))?.includes('Add what Astra can do'), 'the add-ons step');
    check((await page.isDisabled('#addon-video')) && (await page.isChecked('#addon-video')), 'installed add-ons show as installed');
    check(await page.isDisabled('#addons-install'), 'Install waits for a tick');
    await page.check('#addon-music');
    await page.click('#addons-install');
    await page.waitForSelector('.result.ok');
    check(JSON.stringify(state.addons) === '[["music"]]' && (await page.textContent('.result'))?.includes('password'), 'Install opens the terminal for the ticked add-ons only');
    await page.click('#addons-check');
    await page.waitForSelector('#addon-music:disabled');
    check(await page.isChecked('#addon-music'), 'Check again shows what the terminal installed');
    await next(page);
    check((await heading(page))?.includes('Signal'), 'the Signal step');
    check((await page.textContent('#next')) === 'Skip for now', 'Signal can be skipped until a phone is linked');
    await page.click('#signal-link');
    await page.waitForSelector('img.qr');
    check((await page.getAttribute('img.qr', 'src'))?.startsWith('data:image/svg+xml;base64,') && !(await page.textContent('main'))?.includes('sgnl://'), 'the window shows a QR code, not the link');
    signalPhone.scan();
    await page.waitForSelector('#signal-on', { timeout: 10_000 });
    check((await page.isChecked('#signal-on')) && (await page.textContent('main'))?.includes('+905550000001'), 'scanning it links Signal and turns it on');
    await next(page);
    check(await page.isDisabled('#app-docs'), 'apps that are not installed can’t be turned on');
    check(await page.isChecked('#app-video'), 'found apps start on');
    check((await page.isChecked('#app-voice')) && (await page.textContent('main'))?.includes('Running'), 'a running whisper.cpp server turns voice on');
    await next(page);
    check((await heading(page)) === 'Chat wallpaper' && (await page.textContent('main'))?.includes('No wallpaper'), 'the wallpaper step starts with none');
    check((await page.locator('button.card[data-sample]').count()) === 4, 'the four samples are offered');
    await page.click('button.card[data-sample="aurora"]');
    await until(async () => (await page.locator('[data-testid="wp-preview"] img').evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)) > 0);
    check((await page.getAttribute('[data-testid="wp-preview"] img', 'src'))?.endsWith('api/wallpaper-sample/aurora') === true, 'a sample shows in the preview');
    if (shots) {
      await page.click('button.card[data-sample="dusk"]');
      await until(async () => (await page.locator('button.card[data-sample] img').evaluateAll((all) => all.every((img) => (img as unknown as { naturalWidth: number }).naturalWidth > 0))));
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.screenshot({ path: join(shots, 'settings-wallpaper-samples.png') });
      await page.setViewportSize({ width: 1280, height: 720 });
    }
    // Any real PNG will do: a picture of this page.
    const picture = await page.screenshot({ type: 'png' });
    await page.setInputFiles('#wp-file', { name: 'not-a-picture.png', mimeType: 'image/png', buffer: Buffer.from('<svg><script>alert(1)</script></svg>') });
    await page.waitForSelector('.result.bad');
    check((await page.textContent('.result.bad'))?.includes('isn’t a picture'), 'a file that isn’t a picture is refused by its bytes');
    await page.setInputFiles('#wp-file', { name: 'beach.png', mimeType: 'image/png', buffer: picture });
    await page.waitForSelector('[data-testid="wp-preview"] img');
    check(state.wallpaper.current() === null, 'a picked picture shows in the preview, and nothing is saved yet');
    await page.click('button.card:has-text("Strong")');
    check((await page.getAttribute('[data-testid="wp-preview"]', 'data-dim')) === 'strong', 'the preview dims as chosen');
    check(await page.isChecked('#chat-fade'), 'fading older messages starts on');
    if (shots) await page.screenshot({ path: join(shots, 'settings-wallpaper-fade.png') });
    await page.uncheck('#chat-fade');
    await next(page);
    check((await page.textContent('main'))?.includes('You have 2 screens'), 'two screens ask which is Astra’s');
    check((await page.getAttribute('button.card[aria-pressed="true"]', 'aria-pressed')) === 'true' && (await page.textContent('button.card[aria-pressed="true"] b')) === 'eDP-1', 'the focused screen is picked');
    await page.uncheck('#d-bar');
    await next(page);
    check((await page.textContent('main'))?.includes('Mail: john@example.org'), 'the last step sums up the answers');
    await next(page);
    await page.waitForSelector('text=Astra is ready');
    const c = state.config!;
    check(c.user.name === 'Johnny' && c.user.timezone === 'Europe/Istanbul', 'the name and timezone are saved');
    check(c.mail.username === 'john@example.org' && c.mail.imap.host === 'imap.gmail.com' && c.mail.smtp.port === 465, 'mail uses the address and Gmail’s servers');
    check(c.models.triage.model === c.models.chat.model && c.models.local?.model === 'qwen3:8b', 'triage shares the chat model; the local model is on');
    check(c.files.roots.includes('~/Projects') && c.video.enabled && !c.docs.enabled, 'folders and apps are saved');
    check(c.screen.monitor === 'eDP-1', 'the screen is saved');
    check(c.signal.enabled && c.signal.account === '+905550000001' && c.signal.command === '/usr/bin/signal-cli', 'Signal is saved with the linked number');
    check(c.models.embeddings?.model === 'embeddinggemma', 'finding files by meaning uses the local embedding model');
    check(c.models.speech?.baseUrl === 'http://127.0.0.1:8178', 'voice is set up for the running whisper.cpp server');
    check(state.secrets.get('keyring:model-chat') === FAKE_KEY && state.secrets.get('keyring:mail') === 'abcdefghijklmnop', 'the key and app password went to the keyring');
    check(!JSON.stringify(c).includes(FAKE_KEY) && !JSON.stringify(c).includes('abcdefghijklmnop'), 'no secret is in the config');
    check(state.wallpaper.current()?.dim === 'strong', 'Finish put the picture behind the chat, dimmed strongly');
    check(!c.ui.fade, 'fading older messages is saved off');
    check(state.installs === 1, 'the desktop parts were installed once');
    check((await page.inputValue('#key').catch(() => '')) === '', 'the page forgets the key');
    await next(page);
    await page.waitForSelector('#next:text-is("Opening…")');
    await new Promise((r) => setTimeout(r, 150));
    check(state.done === 1, 'Open Astra opens the chat');

    console.log('Settings');
    const before = state.mailTests.length;
    const again = await browser.newPage();
    again.on('pageerror', (e) => errors.push(e.message));
    await again.goto(server.url);
    await again.waitForSelector('#name');
    check((await heading(again)) === 'Astra settings', 'opening it again is Settings');
    check((await again.inputValue('#name')) === 'Johnny', 'answers come back');
    await next(again);
    check((await again.inputValue('#key')) === '' && (await again.inputValue('#model')) === 'anthropic/claude-haiku-5.5', 'no key is sent back to the page');
    await next(again);
    check((await again.inputValue('#address')) === 'john@example.org', 'the mail address comes back');
    await next(again);
    await again.click('nav button:has-text("Folders")');
    check(await again.isChecked('[id="f-~/Projects"]'), 'ticked folders come back');
    await again.click('nav button:has-text("Apps")');
    check(await again.isChecked('#app-voice'), 'voice comes back on');
    await again.click('nav button:has-text("Wallpaper")');
    // The page's CSP allows no eval, so this is a function; the scripts are typed without the DOM.
    await until(async () => (await again.locator('[data-testid="wp-preview"] img').evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)) > 0);
    check((await again.getAttribute('[data-testid="wp-preview"]', 'data-dim')) === 'strong', 'the wallpaper comes back, with its dim');
    check(!(await again.isChecked('#chat-fade')), 'fading comes back off');
    await again.click('nav button:has-text("Finish")');
    check((await again.textContent('#next')) === 'Save', 'the last button is Save');
    await next(again);
    await again.waitForSelector('text=Astra is ready');
    check(state.secrets.get('keyring:model-chat') === FAKE_KEY && state.secrets.get('keyring:mail') === 'abcdefghijklmnop', 'blank fields keep the stored key and password');
    check(state.mailTests.length === before, 'Settings did not sign in again for an unchanged address');

    console.log('Exit without saving');
    const saved = JSON.stringify(state.config);
    const leave = await browser.newPage();
    leave.on('pageerror', (e) => errors.push(e.message));
    await leave.goto(server.url);
    await leave.waitForSelector('#name');
    check((await leave.textContent('#exit')) === 'Exit without saving', 'Settings has an Exit without saving button');
    await leave.fill('#name', 'Someone else');
    await leave.click('#exit');
    check((await leave.textContent('#err'))?.includes('won’t be saved') === true && state.exits === 0, 'with a change, Exit asks once first');
    await leave.click('#exit');
    await leave.waitForSelector('text=Nothing was saved');
    await leave.waitForTimeout(150);
    check(state.exits === 1 && state.done === 1, 'the second press closes the window without opening the chat');
    check(JSON.stringify(state.config) === saved, 'Exit saved nothing');
    check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  } finally {
    await browser.close();
    await server.close();
  }
  console.log('setup e2e passed');
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exit(1);
});
