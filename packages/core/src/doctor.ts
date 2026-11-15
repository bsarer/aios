/**
 * P1: `pnpm doctor` and `/doctor`. Checks the things an Omarchy update or a Node upgrade can
 * break, each with a one-line fix. Written by code from what it finds; nothing reaches a model,
 * and secrets are only looked up (present or not), never shown.
 */
import { execFile } from 'node:child_process';
import { access, constants, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { APP_NAME, type AiosConfig, type SecretRef, configDir, parseConfig } from '@aios/shared';
import { BAR_ID, type KioskPaths } from './kiosk-paths.js';
import { Keyring } from './secrets/keyring.js';
import { secretRefs } from './secrets/refs.js';
import { SYSTEM_COMMANDS } from './system/run.js';

/** The Omarchy commands system controls (S1) and the top bar (S7) run. */
export const OMARCHY_COMMANDS = SYSTEM_COMMANDS.filter((c) => c.startsWith('omarchy-'));

export interface Check {
  name: string;
  /** warn: works, but something optional is missing. */
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface DoctorProbes {
  env: NodeJS.ProcessEnv;
  paths: KioskPaths;
  /** File text, or null when it can't be read. */
  readFile: (path: string) => Promise<string | null>;
  exists: (path: string) => Promise<boolean>;
  /** Runs a program without a shell; never throws (code 127 when it is missing). */
  run: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  /** True when the core answers on 127.0.0.1:port. */
  health: (port: number) => Promise<boolean>;
  /** Whether a keyring reference is stored. Values are never returned. */
  hasSecret: (ref: SecretRef) => Promise<boolean>;
}

/** The probes on this computer. Programs are run without a shell, with a 5 s limit. */
export function realDoctorProbes(paths: KioskPaths, env: NodeJS.ProcessEnv = process.env): DoctorProbes {
  const keyring = new Keyring();
  return {
    env,
    paths,
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    exists: (path) => access(path, constants.F_OK).then(() => true, () => false),
    run: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, { timeout: 5000, env }, (err, stdout) => {
          const code = err ? ((err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          resolve({ code, stdout: String(stdout ?? '') });
        });
      }),
    health: (port) => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
    hasSecret: async (ref) => (await keyring.get(ref).catch(() => null)) !== null,
  };
}

const SETUP_KIOSK = 'run `astra setup --kiosk`';

/** A program's full path on PATH, or null. */
async function onPath(p: DoctorProbes, cmd: string): Promise<string | null> {
  if (cmd.includes('/')) return (await p.exists(cmd)) ? cmd : null;
  for (const dir of (p.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (await p.exists(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

/** ExecStart's program and WorkingDirectory from the unit setup wrote. */
export function unitTargets(unit: string): { node?: string; dir?: string } {
  const exec = /^ExecStart=(\S+)/m.exec(unit)?.[1];
  const dir = /^WorkingDirectory=(.+)$/m.exec(unit)?.[1]?.trim();
  return { ...(exec ? { node: exec } : {}), ...(dir ? { dir } : {}) };
}

export async function runDoctor(p: DoctorProbes): Promise<Check[]> {
  const svc = p.paths.service;
  const unitName = svc.replace(/\.service$/, '');
  const module = p.paths.aiosLua.split('/').pop() ?? 'astra.lua';
  const out: Check[] = [];
  const add = (c: Check) => out.push(c);

  // Config.
  const toml = await p.readFile(join(configDir(p.env), 'config.toml'));
  let config: AiosConfig | null = null;
  if (toml === null) add({ name: 'Config', status: 'fail', detail: `no ${join(configDir(p.env), 'config.toml')}`, fix: 'run `astra setup`' });
  else {
    try {
      config = parseConfig(toml);
      add({ name: 'Config', status: 'ok', detail: 'config.toml loads' });
    } catch (err) {
      add({ name: 'Config', status: 'fail', detail: (err as Error).message.split('\n')[0]!.slice(0, 200), fix: 'fix config.toml, or run `astra setup` again' });
    }
  }

  // The service and what it points at.
  const unit = await p.readFile(p.paths.unit);
  if (unit === null) add({ name: 'Service', status: 'fail', detail: `${svc} is not installed`, fix: SETUP_KIOSK });
  else {
    const enabled = (await p.run('systemctl', ['--user', 'is-enabled', svc])).stdout.trim();
    const active = (await p.run('systemctl', ['--user', 'is-active', svc])).stdout.trim();
    const ok = enabled === 'enabled' && active === 'active';
    add({ name: 'Service', status: ok ? 'ok' : 'fail', detail: `${unitName} is ${active || 'unknown'} and ${enabled || 'unknown'}`, ...(ok ? {} : { fix: `run \`systemctl --user enable --now ${unitName}\`; if it keeps stopping, \`journalctl --user -u ${unitName} -n 20\` says why` }) });
    const t = unitTargets(unit);
    const missing = [t.node, t.dir].filter((x): x is string => !!x);
    const gone: string[] = [];
    for (const f of missing) if (!(await p.exists(f))) gone.push(f);
    add(gone.length ? { name: 'Service paths', status: 'fail', detail: `the service points at ${gone.join(' and ')}, which no longer exists`, fix: `${SETUP_KIOSK} (needed after a Node upgrade or moving the folder)` } : { name: 'Service paths', status: 'ok', detail: `node and the app folder exist` });
  }
  if (config) {
    const up = await p.health(config.ui.port);
    add({ name: 'Chat page', status: up ? 'ok' : 'fail', detail: up ? `answers on 127.0.0.1:${config.ui.port}` : `nothing answers on 127.0.0.1:${config.ui.port}`, ...(up ? {} : { fix: `\`journalctl --user -u ${unitName} -n 20\` says why it did not start` }) });
  }

  // Hyprland: the kiosk line and the session the service sees.
  const lua = await p.readFile(p.paths.hyprlandLua);
  const hasLine = lua?.split('\n').some((l) => l.trim() === p.paths.requireLine) ?? false;
  const hasModule = await p.exists(p.paths.aiosLua);
  add(
    lua === null
      ? { name: 'Kiosk', status: 'fail', detail: `no ${p.paths.hyprlandLua} (${APP_NAME} needs Omarchy 4, Hyprland 0.55+)` }
      : hasLine && hasModule
        ? { name: 'Kiosk', status: 'ok', detail: `hyprland.lua loads ${module}` }
        : { name: 'Kiosk', status: 'fail', detail: hasModule ? `the ${APP_NAME} line is gone from hyprland.lua (an Omarchy update may have reset it)` : `${module} is missing`, fix: SETUP_KIOSK },
  );
  const envOut = (await p.run('systemctl', ['--user', 'show-environment'])).stdout;
  const missingVars = ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE'].filter((v) => !new RegExp(`^${v}=`, 'm').test(envOut));
  add(missingVars.length ? { name: 'Desktop session', status: 'fail', detail: `the service can't see ${missingVars.join(' and ')}`, fix: 'log out and back in; if it stays, check that Omarchy starts Hyprland with uwsm' } : { name: 'Desktop session', status: 'ok', detail: 'the service sees Hyprland' });

  // Omarchy's commands (S1) and the top bar button (S7).
  const gone: string[] = [];
  for (const c of OMARCHY_COMMANDS) if (!(await onPath(p, c))) gone.push(c);
  add(gone.length ? { name: 'Omarchy commands', status: 'fail', detail: `missing: ${gone.join(', ')}`, fix: `system controls that use them will fail; check the Omarchy version (${APP_NAME} targets Omarchy 4) and report it so ${APP_NAME} can follow the rename` } : { name: 'Omarchy commands', status: 'ok', detail: `all ${OMARCHY_COMMANDS.length} found` });
  const shell = await p.readFile(p.paths.shellJson);
  if (shell !== null) {
    const button = shell.includes(`"${BAR_ID}"`);
    add(button ? { name: 'Top bar button', status: 'ok', detail: 'the AI button is on the bar' } : { name: 'Top bar button', status: 'warn', detail: 'the AI button is not on the top bar (`omarchy bar defaults` removes it)', fix: `${SETUP_KIOSK}; Super+Shift+H works meanwhile` });
  }

  // Secrets: stored or not, never shown.
  if (config) {
    const refs = secretRefs(config);
    if ((await p.run('secret-tool', [])).code === 127) add({ name: 'Keyring', status: 'fail', detail: 'secret-tool is not installed', fix: 'install libsecret (`sudo pacman -S libsecret`)' });
    else {
      const missing: string[] = [];
      for (const r of refs) if (!(await p.hasSecret(r))) missing.push(r);
      add(missing.length ? { name: 'Keyring', status: 'fail', detail: `not stored: ${missing.join(', ')}`, fix: 'run `astra setup` and type them again (a restored backup never carries secrets)' } : { name: 'Keyring', status: 'ok', detail: `${refs.length} secrets stored` });
    }
  }

  // Optional programs, only for what the config turns on.
  if (config?.builder.enabled && !(await onPath(p, config.builder.command))) add({ name: 'Claude Code', status: 'warn', detail: `${config.builder.command} not found, so apps can't be built`, fix: 'install Claude Code and run `claude` once to sign in, or set [builder] enabled = false' });
  if (config?.docs.enabled) {
    const clis = [config.docs.wordCli, config.docs.sheetCli];
    const lost: string[] = [];
    for (const c of clis) if (!(await onPath(p, c))) lost.push(c);
    if (lost.length) add({ name: 'Word and Excel', status: 'warn', detail: `${lost.join(' and ')} not found`, fix: 'see "Word and Excel files" in the README, or set [docs] enabled = false' });
  }
  return out;
}

/** One line per check, for the terminal and the chat. */
export function formatChecks(checks: Check[]): string[] {
  const mark = { ok: '✓', warn: '!', fail: '✗' } as const;
  return checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}${c.fix && c.status !== 'ok' ? `. Fix: ${c.fix}` : ''}`);
}
