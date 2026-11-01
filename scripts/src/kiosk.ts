/**
 * Kiosk integration (plan §8, A6): a systemd --user service for aios-core, a launcher
 * script that opens, focuses or force-closes the chat window, and a Hyprland Lua file
 * with the window rule, autostart and the exit/relaunch keys.
 *
 * Targets Omarchy 4 / Hyprland 0.55+, which configure Hyprland in Lua
 * (~/.config/hypr/hyprland.lua; user modules are require("hypr.<name>")). Checked
 * against Omarchy's quattro branch and Hyprland's Lua bindings, October 2026.
 *
 * Everything here is pure text or file edits on paths passed in, so it is testable
 * without a desktop. install/uninstall are idempotent and undo each other.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CHAT_APP_CLASS, CHAT_CLASS_PATTERN, MONITOR_NAME } from '@aios/shared';

export const APP_CLASS = CHAT_APP_CLASS;
export const CLASS_PATTERN = CHAT_CLASS_PATTERN;
export const EXIT_KEYS = 'SUPER + SHIFT + ESCAPE';
export const OPEN_KEYS = 'SUPER + SHIFT + H';

/** The line added to the user's hyprland.lua. It tolerates aios.lua being deleted by hand. */
export const REQUIRE_LINE =
  'do local f = io.open((os.getenv("HOME") or "") .. "/.config/hypr/aios.lua") if f then f:close() require("hypr.aios") end end -- AI OS (pnpm run setup)';

export interface KioskPaths {
  hyprDir: string;
  hyprlandLua: string;
  aiosLua: string;
  launcher: string;
  unitDir: string;
  unit: string;
  profileDir: string;
}

export function kioskPaths(env: NodeJS.ProcessEnv = process.env): KioskPaths {
  const home = env.HOME ?? '';
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const hyprDir = join(config, 'hypr');
  const unitDir = join(config, 'systemd', 'user');
  return {
    hyprDir,
    hyprlandLua: join(hyprDir, 'hyprland.lua'),
    aiosLua: join(hyprDir, 'aios.lua'),
    launcher: join(home, '.local', 'bin', 'aios-kiosk'),
    unitDir,
    unit: join(unitDir, 'aios-core.service'),
    profileDir: join(data, 'aios', 'chromium'),
  };
}

/** systemd --user unit. `node` is an absolute path: user units don't see mise's shims. */
export function unitFile(o: { node: string; coreDir: string }): string {
  return `# AI OS core. Written by \`pnpm run setup\`; removed by \`pnpm --filter @aios/scripts uninstall\`.
[Unit]
Description=AI OS core (chat, mail watcher, memory)
After=graphical-session.target
PartOf=graphical-session.target
# The keyring may still be locked right after login; keep retrying for a while.
StartLimitIntervalSec=300
StartLimitBurst=30

[Service]
Type=simple
WorkingDirectory=${o.coreDir}
ExecStart=${o.node} --import tsx src/main.ts
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=graphical-session.target
`;
}

const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * `aios-kiosk open|exit`. Exit closes the window through Hyprland, then kills the
 * browser by its dedicated profile if it is still there 0.5 s later (a hung app).
 * AIOS_KIOSK=0 opens a normal browser window instead of the fullscreen app window.
 */
export function launcherScript(o: { port: number; profileDir: string }): string {
  return `#!/usr/bin/env bash
# AI OS chat window: open (or focus), or exit. Written by \`pnpm run setup\`.
#   aios-kiosk open    open the chat, or focus it if it is already open
#   aios-kiosk exit    close the chat; force-kill it if it does not close (hung)
#   AIOS_KIOSK=0 aios-kiosk open   open in a normal window (development)
set -u
URL=${sh(`http://127.0.0.1:${o.port}/`)}
PROFILE=${sh(o.profileDir)}
CLASS=${sh(APP_CLASS)}
PATTERN=${sh(CLASS_PATTERN)}

window_open() {
  local clients
  clients=$(hyprctl clients -j 2>/dev/null) || return 1
  if command -v jq >/dev/null; then
    jq -e --arg p "$PATTERN" 'any(.[]; .class | test($p))' <<<"$clients" >/dev/null
  else
    grep -Eq 'org[.]aios[.]home|127[.]0[.]0[.]1__' <<<"$clients"
  fi
}

browser_running() {
  pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null
}

case "\${1:-open}" in
  open)
    if window_open; then
      hyprctl dispatch "hl.dsp.focus({ window = [[class:$PATTERN]] })" >/dev/null 2>&1 ||
        hyprctl dispatch focuswindow "class:$PATTERN" >/dev/null 2>&1
      exit 0
    fi
    # Give aios-core up to 30 s to come up; the page reconnects by itself after that.
    UP=0
    for _ in $(seq "\${AIOS_KIOSK_WAIT:-150}"); do
      curl -fsS -o /dev/null "\${URL}healthz" && { UP=1; break; }
      sleep 0.2
    done
    if [ "$UP" = 0 ]; then
      # Never open a full-screen error page: say why in a notification instead.
      WHY=$(journalctl --user -u aios-core -n 40 -o cat 2>/dev/null | awk '/aios-core failed to start/{f=1; b=""} f{b=b $0 "\\n"} END{printf "%s", b}' | head -c 600)
      MSG="\${WHY:-AI OS did not start. See: journalctl --user -u aios-core -n 20}"
      command -v notify-send >/dev/null && notify-send -u critical "AI OS" "$MSG"
      echo "aios-kiosk: $MSG" >&2
      exit 1
    fi
    BROWSER="\${AIOS_BROWSER:-}"
    for b in chromium google-chrome-stable brave; do
      [ -z "$BROWSER" ] && command -v "$b" >/dev/null && BROWSER="$b"
    done
    [ -z "$BROWSER" ] && { echo "aios-kiosk: no Chromium-based browser found (set AIOS_BROWSER)" >&2; exit 1; }
    ARGS=(--user-data-dir="$PROFILE" --class="$CLASS" --no-first-run --no-default-browser-check --disable-session-crashed-bubble)
    if [ "\${AIOS_KIOSK:-1}" = 0 ]; then ARGS+=(--new-window "$URL"); else ARGS+=(--app="$URL"); fi
    if command -v uwsm-app >/dev/null; then exec uwsm-app -- "$BROWSER" "\${ARGS[@]}"; fi
    exec "$BROWSER" "\${ARGS[@]}"
    ;;
  exit)
    hyprctl dispatch "hl.dsp.window.close({ window = [[class:$PATTERN]] })" >/dev/null 2>&1 ||
      hyprctl dispatch closewindow "class:$PATTERN" >/dev/null 2>&1
    for _ in 1 2 3 4 5; do
      browser_running || exit 0
      sleep 0.1
    done
    pkill -KILL -f -- "--user-data-dir=$PROFILE"
    exit 0
    ;;
  *)
    echo "usage: aios-kiosk open|exit" >&2
    exit 2
    ;;
esac
`;
}

const lua = (s: string) => JSON.stringify(s);

/**
 * ~/.config/hypr/aios.lua: Hyprland 0.55+ Lua API (hl.window_rule, hl.workspace_rule, hl.on,
 * hl.bind, hl.dsp.exec_cmd). S5: with a monitor (config [screen] monitor), the chat's
 * workspace 1 lives on that screen and the chat window opens there.
 */
export function hyprlandModule(o: { launcher: string; autostart: boolean; monitor?: string }): string {
  const open = lua(`${o.launcher} open`);
  const exit = lua(`${o.launcher} exit`);
  if (o.monitor && !MONITOR_NAME.test(o.monitor)) throw new Error(`${JSON.stringify(o.monitor)} is not a monitor name`);
  const screen = o.monitor
    ? `
-- AI OS owns ${o.monitor}: workspace 1 stays on it, and the chat opens there.
hl.workspace_rule({ workspace = "1", monitor = ${lua(o.monitor)}, default = true, persistent = true })
`
    : '';
  return `-- AI OS kiosk. Written by \`pnpm run setup\`; removed by \`pnpm --filter @aios/scripts uninstall\`.
-- Edits here are overwritten when setup runs again.
${screen}
-- The chat window is fullscreen on workspace 1.
hl.window_rule({
  name = "aios-kiosk",
  match = { class = ${lua(CLASS_PATTERN)} },
  fullscreen = true,
  workspace = "1",${o.monitor ? `
  monitor = ${lua(o.monitor)},` : ''}
})
${o.autostart ? `\n-- Open the chat at login.\nhl.on("hyprland.start", function()\n  hl.exec_cmd(${open})\nend)\n` : ''}
-- Handled by the compositor, so they work even when the chat is hung.
hl.bind(${lua(EXIT_KEYS)}, hl.dsp.exec_cmd(${exit}), { description = "Exit AI OS" })
hl.bind(${lua(OPEN_KEYS)}, hl.dsp.exec_cmd(${open}), { description = "Open AI OS" })
`;
}

/** S5: a screen setup can offer AI OS, from `hyprctl -j monitors`. */
export interface ScreenChoice {
  name: string;
  width: number;
  height: number;
  focused: boolean;
}

/** The enabled monitors in `hyprctl -j monitors` output with names Hyprland dispatches accept; [] for anything else. */
export function parseMonitors(json: string): ScreenChoice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: unknown) => {
    if (!m || typeof m !== 'object') return [];
    const r = m as Record<string, unknown>;
    if (typeof r.name !== 'string' || !MONITOR_NAME.test(r.name) || r.disabled === true) return [];
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return [{ name: r.name, width: n(r.width), height: n(r.height), focused: r.focused === true }];
  });
}

/** hyprland.lua with REQUIRE_LINE appended once. */
export function addRequire(content: string): string {
  if (content.split('\n').some((l) => l.trim() === REQUIRE_LINE)) return content;
  return `${content.replace(/\n*$/, '\n')}\n${REQUIRE_LINE}\n`;
}

/** hyprland.lua without REQUIRE_LINE, and without the blank line addRequire put before it. */
export function removeRequire(content: string): string {
  for (const added of [`\n\n${REQUIRE_LINE}\n`, `\n${REQUIRE_LINE}\n`]) {
    if (content.includes(added)) return content.replace(added, '\n');
  }
  return content.replace(REQUIRE_LINE, '');
}

export type Run = (cmd: string, args: string[]) => Promise<void>;

export interface InstallOptions {
  node: string;
  coreDir: string;
  port: number;
  /** Open the chat at login (config [ui] kiosk). */
  autostart: boolean;
  /** Edit hyprland.lua. False leaves Hyprland untouched and only prints what to add. */
  hyprland: boolean;
  /** S5: the screen AI OS owns (config [screen] monitor); empty for the one it opens on. */
  monitor?: string;
}

/** What install did, for setup to print. */
export interface InstallReport {
  written: string[];
  notes: string[];
}

async function writeIfChanged(path: string, content: string, mode: number, report: InstallReport): Promise<void> {
  const old = existsSync(path) ? await readFile(path, 'utf8') : null;
  if (old === content) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  report.written.push(path);
}

export async function installKiosk(p: KioskPaths, o: InstallOptions, run: Run): Promise<InstallReport> {
  const report: InstallReport = { written: [], notes: [] };
  await writeIfChanged(p.unit, unitFile({ node: o.node, coreDir: o.coreDir }), 0o644, report);
  await writeIfChanged(p.launcher, launcherScript({ port: o.port, profileDir: p.profileDir }), 0o755, report);
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', 'aios-core.service']);

  if (!existsSync(p.hyprlandLua)) {
    report.notes.push(
      existsSync(join(p.hyprDir, 'hyprland.conf'))
        ? 'Hyprland uses hyprland.conf here; the kiosk needs Hyprland 0.55+ with hyprland.lua (Omarchy 4). Skipped the window rule and keys.'
        : `No ${p.hyprlandLua}; skipped the window rule and keys.`,
    );
    return report;
  }
  await writeIfChanged(p.aiosLua, hyprlandModule({ launcher: p.launcher, autostart: o.autostart, ...(o.monitor ? { monitor: o.monitor } : {}) }), 0o644, report);
  if (!o.hyprland) {
    report.notes.push(`Add this line to the end of ${p.hyprlandLua} to turn the kiosk on:\n  ${REQUIRE_LINE}`);
    return report;
  }
  const before = await readFile(p.hyprlandLua, 'utf8');
  const after = addRequire(before);
  if (after !== before) {
    await writeFile(`${p.hyprlandLua}.aios-backup`, before);
    await writeFile(p.hyprlandLua, after);
    report.written.push(p.hyprlandLua);
    report.notes.push(`Backed up the previous version to ${p.hyprlandLua}.aios-backup.`);
  }
  return report;
}

/** Undo installKiosk. Stops the service and closes the window first. */
export async function uninstallKiosk(p: KioskPaths, run: Run): Promise<string[]> {
  const removed: string[] = [];
  if (existsSync(p.launcher)) await run(p.launcher, ['exit']).catch(() => undefined);
  if (existsSync(p.unit)) {
    await run('systemctl', ['--user', 'disable', '--now', 'aios-core.service']).catch(() => undefined);
  }
  if (existsSync(p.hyprlandLua)) {
    const before = await readFile(p.hyprlandLua, 'utf8');
    const after = removeRequire(before);
    if (after !== before) {
      await writeFile(p.hyprlandLua, after);
      removed.push(`AI OS line in ${p.hyprlandLua}`);
    }
  }
  for (const f of [p.aiosLua, p.launcher, p.unit]) {
    if (existsSync(f)) {
      await rm(f);
      removed.push(f);
    }
  }
  if (removed.includes(p.unit)) await run('systemctl', ['--user', 'daemon-reload']).catch(() => undefined);
  return removed;
}
