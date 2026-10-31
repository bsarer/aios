/**
 * Building apps with Claude Code (S4). An approved exception to "model access only through
 * model.ts": Claude Code is a separate program with its own login and model access, run here
 * as a child process. Checked against Claude Code 2.1.314's --help and code.claude.com/docs
 * (cli-reference, headless, permission-modes), October 2026.
 *
 * Runs only from a click on a Build card (system/actions.ts), never from a model call, and the
 * card can't be offered while an email is in view (tools/registry.ts). Claude Code runs:
 *
 * - in the app's own folder, ~/.local/share/aios/apps/<slug>/, which is its working directory;
 * - with --restricted and --tools Read,Write,Edit,Glob,Grep: no shell, no code running, no
 *   web, file tools confined to that folder, and user/project settings ignored;
 * - in acceptEdits mode with --permission-prompts none, so edits inside the folder go ahead and
 *   anything that would ask (a path outside it) is denied;
 * - with no MCP servers, no saved session, a spending cap and a time limit;
 * - with the request on stdin, never on a command line, and no shell.
 *
 * Afterwards AI OS checks index.html, puts its own Content-Security-Policy first in it (no
 * network, nothing loaded from elsewhere), and writes the desktop entry that opens it as a
 * Chromium app window with a profile of its own, so S3's apps_list and open_app see it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { dataDir } from '../paths.js';
import { cleanName } from '../system/controls.js';
import { applicationDirs, onPath } from './desktop.js';

export interface BuilderConfig {
  command: string;
  model?: string | undefined;
  maxBudgetUsd: number;
  timeoutMinutes: number;
}

export interface BuildRequest {
  name: string;
  request: string;
}

export interface BuildOptions {
  signal?: AbortSignal | undefined;
  /** Called with a short line each time Claude Code starts a step, e.g. "Writing index.html". */
  onStep?: ((step: string) => void) | undefined;
  /** This build's spending cap; the config's maxBudgetUsd when not given. */
  maxBudgetUsd?: number | undefined;
}

/** How Claude Code is signed in, from `claude auth status`: 'plan' is a Claude subscription. */
export type ClaudeLogin = 'plan' | 'api' | 'none' | 'unknown';

export interface BuildResult {
  slug: string;
  name: string;
  created: boolean;
  /** Claude Code's one-line account of what it did, cleaned. */
  summary: string;
  costUsd: number | null;
  desktopId: string;
}

export const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_TURNS = 60;
/** Everything in a path that goes into the desktop entry's Exec line. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const BROWSERS = ['chromium', 'google-chrome-stable', 'brave'];

export const APP_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' file:",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "media-src 'self' data: blob: file:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');
const CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP}"><!-- AI OS: this app has no network access -->`;

/** A short app name for the launcher, or null when nothing usable is left. */
export function appName(raw: string): string | null {
  const name = cleanName(raw).slice(0, 40).trim();
  return name && appSlug(name) ? name : null;
}

export function appSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return APP_SLUG.test(slug) ? slug : null;
}

export const appDesktopId = (slug: string) => `aios-app-${slug}.desktop`;

/** index.html with AI OS's CSP as the first thing in <head>, and no other CSP meta tags. */
export function withCsp(html: string): string {
  const stripped = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>(\s*<!-- AI OS:[^>]*-->)?/gi, '');
  const head = /<head\b[^>]*>/i.exec(stripped);
  if (head) return `${stripped.slice(0, head.index + head[0].length)}${CSP_TAG}${stripped.slice(head.index + head[0].length)}`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(stripped);
  const at = doctype ? doctype[0].length : 0;
  return `${stripped.slice(0, at)}<head>${CSP_TAG}</head>${stripped.slice(at)}`;
}

export function systemPrompt(name: string): string {
  return [
    `You build one small app, "${name}", in the current folder, for a person who asked for it in plain words. They will not read your messages, only use the app.`,
    'Rules:',
    '- index.html in the current folder is the entry point. Plain HTML, CSS and JavaScript only, no build step; split into a few files next to it if that helps.',
    '- No network at all: no CDNs, web fonts, remote images, fetch, analytics or links that load pages. Everything the app needs is in this folder. A policy blocks the network anyway.',
    '- Keep any data the app saves in localStorage.',
    '- It opens in its own window of about 900x700 and may be made full screen; it should look clean at both sizes and follow the system light or dark theme (prefers-color-scheme).',
    `- Give index.html the <title> "${name}".`,
    '- If the app already exists here, change it as asked and keep everything else working.',
    '- When done, answer with one short sentence saying what the app does now.',
  ].join('\n');
}

export function claudeArgs(c: BuilderConfig, name: string, maxBudgetUsd = c.maxBudgetUsd): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--restricted',
    '--tools',
    'Read,Write,Edit,Glob,Grep',
    '--permission-mode',
    'acceptEdits',
    '--permission-prompts',
    'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-budget-usd',
    String(maxBudgetUsd),
    '--max-turns',
    String(MAX_TURNS),
    ...(c.model ? ['--model', c.model] : []),
    '--append-system-prompt',
    systemPrompt(name),
  ];
}

/** The last line of Claude Code's stream-json output. Only these fields are read. */
const ResultLine = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
});

/**
 * Claude Code's assistant messages, read only for the tool calls in them, to show progress.
 * The block shape isn't documented, so anything unexpected is skipped.
 */
const AssistantLine = z.looseObject({
  type: z.literal('assistant'),
  message: z.looseObject({ content: z.array(z.unknown()) }),
});
const ToolUse = z.looseObject({
  type: z.literal('tool_use'),
  name: z.string(),
  input: z.looseObject({ file_path: z.string().optional() }).optional(),
});

/** One short line for the Build card about what a tool call is doing. */
export function stepText(tool: string, filePath?: string): string {
  const file = filePath ? cleanName(basename(filePath)).slice(0, 60) : '';
  switch (tool) {
    case 'Write':
      return file ? `Writing ${file}` : 'Writing a file';
    case 'Edit':
    case 'MultiEdit':
      return file ? `Editing ${file}` : 'Editing a file';
    case 'Read':
      return file ? `Reading ${file}` : 'Reading a file';
    case 'Glob':
    case 'Grep':
      return 'Looking through the files';
    default:
      return 'Working';
  }
}

/** `claude auth status` prints JSON with authMethod; only that field is read. */
const AuthStatus = z.looseObject({ authMethod: z.string().optional() });

export class BuildError extends Error {
  constructor(
    message: string,
    /** What Claude Code reported spending before it stopped, when it said. */
    readonly costUsd: number | null = null,
  ) {
    super(message);
  }
}

export interface AppBuilderOptions {
  config: BuilderConfig;
  env?: NodeJS.ProcessEnv;
}

export class AppBuilder {
  private busy = false;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly o: AppBuilderOptions) {
    this.env = o.env ?? process.env;
  }

  appDir(slug: string): string {
    return join(dataDir(this.env), 'apps', slug);
  }

  private profileDir(slug: string): string {
    return join(dataDir(this.env), 'app-profiles', slug);
  }

  private desktopFile(slug: string): string {
    return join(applicationDirs(this.env)[0]!, appDesktopId(slug));
  }

  /** An app AI OS built before, by slug. */
  exists(slug: string): boolean {
    return existsSync(join(this.appDir(slug), 'index.html'));
  }

  /** Why building can't work on this computer, or null. Checked before a card is shown. */
  async unavailable(): Promise<string | null> {
    if (!(await onPath(this.o.config.command, this.env))) {
      return `Claude Code isn't installed where AI OS can find it (looked for "${this.o.config.command}"). Install it and sign in with \`claude\` once, or set [builder] command in the config to its full path.`;
    }
    if (!(await this.browser())) return 'No Chromium-based browser is installed to open built apps in (chromium, google-chrome-stable or brave).';
    return null;
  }

  private async browser(): Promise<string | null> {
    for (const b of BROWSERS) if (await onPath(b, this.env)) return b;
    return null;
  }

  /**
   * How Claude Code is signed in. Runs `claude auth status`, which prints no secrets; only its
   * authMethod is read. 'unknown' when it can't tell (an older Claude Code, a timeout).
   */
  login(): Promise<ClaudeLogin> {
    return new Promise((resolve) => {
      let out = '';
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.o.config.command, ['auth', 'status'], { env: this.env, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve('unknown');
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve('unknown');
      }, 10_000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        out = (out + d).slice(0, 10_000);
      });
      child.once('error', () => {
        clearTimeout(timer);
        resolve('unknown');
      });
      child.once('close', () => {
        clearTimeout(timer);
        let method: string | undefined;
        try {
          method = AuthStatus.safeParse(JSON.parse(out)).data?.authMethod;
        } catch {
          method = undefined;
        }
        resolve(method === undefined ? 'unknown' : method === 'none' ? 'none' : method === 'claude.ai' ? 'plan' : 'api');
      });
    });
  }

  async build(req: BuildRequest, opts: BuildOptions = {}): Promise<BuildResult> {
    const name = appName(req.name);
    const slug = name ? appSlug(name) : null;
    if (!name || !slug) throw new BuildError('that is not a usable app name');
    if (this.busy) throw new BuildError('another app is being built; try again when it is done');
    this.busy = true;
    try {
      const dir = this.appDir(slug);
      const created = !this.exists(slug);
      for (const p of [dir, this.profileDir(slug), this.desktopFile(slug)]) {
        if (!SAFE_PATH.test(p)) throw new BuildError(`the folder ${p} has characters a launcher can't hold`);
      }
      await mkdir(dir, { recursive: true });
      const { summary, costUsd } = await this.runClaude(dir, name, req.request, opts);
      const index = join(dir, 'index.html');
      const st = await lstat(index).catch(() => null);
      if (!st?.isFile()) throw new BuildError("Claude Code finished without writing index.html, so there's no app to open");
      if (st.size > MAX_INDEX_BYTES) throw new BuildError('index.html came out larger than 2 MB');
      await writeFile(index, withCsp(await readFile(index, 'utf8')));
      const browser = await this.browser();
      if (!browser) throw new BuildError('no Chromium-based browser is installed to open the app in');
      await this.writeDesktopEntry(slug, name, browser);
      return { slug, name, created, summary, costUsd, desktopId: appDesktopId(slug) };
    } finally {
      this.busy = false;
    }
  }

  private async writeDesktopEntry(slug: string, name: string, browser: string): Promise<void> {
    const file = this.desktopFile(slug);
    const exec = [
      browser,
      `--user-data-dir=${this.profileDir(slug)}`,
      `--class=aios-app-${slug}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--app=file://${join(this.appDir(slug), 'index.html')}`,
    ].join(' ');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(
      file,
      [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${name}`,
        'Comment=Built by AI OS',
        `Exec=${exec}`,
        'Terminal=false',
        'Categories=Utility;',
        `StartupWMClass=aios-app-${slug}`,
        'X-AIOS-Built=true',
        '',
      ].join('\n'),
    );
  }

  private runClaude(dir: string, name: string, request: string, opts: BuildOptions): Promise<{ summary: string; costUsd: number | null }> {
    const c = this.o.config;
    const { signal, onStep } = opts;
    const budget = opts.maxBudgetUsd ?? c.maxBudgetUsd;
    return new Promise((resolve, reject) => {
      const child = spawn(c.command, claudeArgs(c, name, budget), { cwd: dir, env: this.env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let result: z.infer<typeof ResultLine> | null = null;
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(() => {
        kill();
        reject(new BuildError(`it took longer than ${c.timeoutMinutes} minutes, so I stopped it`));
      }, c.timeoutMinutes * 60_000);
      const onAbort = () => {
        kill();
        reject(new BuildError('stopped'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        out += d;
        let nl: number;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const json: unknown = JSON.parse(line);
            const parsed = ResultLine.safeParse(json);
            if (parsed.success) result = parsed.data;
            const said = onStep ? AssistantLine.safeParse(json) : null;
            if (said?.success) {
              for (const block of said.data.message.content) {
                const use = ToolUse.safeParse(block);
                if (use.success) onStep!(stepText(use.data.name, use.data.input?.file_path));
              }
            }
          } catch {
            // Not JSON; ignore.
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        err = (err + d).slice(-2000);
      });
      child.once('error', (e) => {
        done();
        reject(new BuildError(`Claude Code could not start: ${e.message}`));
      });
      child.once('close', (code) => {
        done();
        const r = result as z.infer<typeof ResultLine> | null;
        const cost = r?.total_cost_usd ?? null;
        if (r && !r.is_error && code === 0) {
          resolve({ summary: cleanName(r.result ?? '').slice(0, 200), costUsd: cost });
          return;
        }
        if (r?.subtype === 'error_max_budget_usd') {
          reject(new BuildError(`it reached its $${budget} spending cap before finishing`, cost));
          return;
        }
        const why = r?.is_error ? cleanName(r.result ?? r.subtype ?? 'error') : cleanName(err.split('\n').filter(Boolean).at(-1) ?? '') || `it exited with code ${code ?? 'unknown'}`;
        reject(new BuildError(`Claude Code stopped: ${why.slice(0, 200)}`, cost));
      });
      child.stdin.end(request);
    });
  }
}
