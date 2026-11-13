/**
 * Where the kiosk (A6) and the top bar button (S7) live on disk, shared by setup, uninstall and
 * the doctor (P1). Pure paths from the environment; nothing is read here.
 */
import { join } from 'node:path';
import { appIds } from '@aios/shared';

/** The line added to the user's hyprland.lua for a module (astra, or aios before R1). It tolerates the module being deleted by hand. */
export function requireLine(module: string): string {
  return `do local f = io.open((os.getenv("HOME") or "") .. "/.config/hypr/${module}.lua") if f then f:close() require("hypr.${module}") end end -- ${module === 'aios' ? 'AI OS (pnpm run setup)' : 'Astra (astra setup)'}`;
}

/** The line an AI OS install made before R1 added. */
export const REQUIRE_LINE = requireLine('aios');

export interface KioskPaths {
  /** The systemd --user unit's name, e.g. astra.service. */
  service: string;
  /** The line in hyprland.lua that loads the module (aiosLua). */
  requireLine: string;
  hyprDir: string;
  hyprlandLua: string;
  /** The Hyprland module: astra.lua (aios.lua before R1). */
  aiosLua: string;
  launcher: string;
  unitDir: string;
  unit: string;
  profileDir: string;
  /** S7: Omarchy 4's shell config, where the top bar's layout lives. */
  shellJson: string;
  /** S7: Omarchy's own defaults for it, used when the user has no shell.json yet. */
  shellDefaults: string;
}

export function kioskPaths(env: NodeJS.ProcessEnv = process.env): KioskPaths {
  const home = env.HOME ?? '';
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const ids = appIds(env);
  const hyprDir = join(config, 'hypr');
  const unitDir = join(config, 'systemd', 'user');
  return {
    service: ids.service,
    requireLine: requireLine(ids.hyprModule),
    hyprDir,
    hyprlandLua: join(hyprDir, 'hyprland.lua'),
    aiosLua: join(hyprDir, `${ids.hyprModule}.lua`),
    launcher: join(home, '.local', 'bin', ids.kiosk),
    unitDir,
    unit: join(unitDir, ids.service),
    profileDir: join(data, ids.dir, 'chromium'),
    shellJson: join(config, 'omarchy', 'shell.json'),
    shellDefaults: join(env.OMARCHY_PATH || join(data, 'omarchy'), 'config', 'omarchy', 'shell.json'),
  };
}


/** S7: the top bar entry's id in Omarchy's shell.json. */
export const BAR_ID = 'aios-home';
