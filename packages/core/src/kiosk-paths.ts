/**
 * Where the kiosk (A6) and the top bar button (S7) live on disk, shared by setup, uninstall and
 * the doctor (P1). Pure paths from the environment; nothing is read here.
 */
import { join } from 'node:path';

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
  /** S7: Omarchy 4's shell config, where the top bar's layout lives. */
  shellJson: string;
  /** S7: Omarchy's own defaults for it, used when the user has no shell.json yet. */
  shellDefaults: string;
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
    shellJson: join(config, 'omarchy', 'shell.json'),
    shellDefaults: join(env.OMARCHY_PATH || join(data, 'omarchy'), 'config', 'omarchy', 'shell.json'),
  };
}


/** S7: the top bar entry's id in Omarchy's shell.json. */
export const BAR_ID = 'aios-home';
