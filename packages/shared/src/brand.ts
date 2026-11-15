/**
 * R1: the app's name and the names it uses on disk, in the keyring and in systemd. A new install
 * is Astra (`~/.config/astra`, `astra.service`, keyring service `astra`). An install made before
 * R1 (a `~/.config/aios/config.toml` and no `~/.config/astra`) keeps its AI OS names, so pulling
 * this change never strands a working setup. Only node code imports this (it reads the disk).
 */
import { existsSync } from 'node:fs';

export const APP_NAME = 'Astra';
/** A new install's port. Not 7777, so Astra and an AI OS install on another account of the same computer can't clash. */
export const DEFAULT_PORT = 7780;

export interface AppIds {
  /** Folder name under ~/.config and ~/.local/share. */
  dir: string;
  /** The systemd --user unit. */
  service: string;
  /** libsecret `service` attribute. */
  keyring: string;
  /** The per-user launcher in ~/.local/bin. */
  kiosk: string;
  /** The Hyprland module, ~/.config/hypr/<name>.lua. */
  hyprModule: string;
  legacy: boolean;
}

export const ASTRA_IDS: AppIds = { dir: 'astra', service: 'astra.service', keyring: 'astra', kiosk: 'astra-kiosk', hyprModule: 'astra', legacy: false };
export const LEGACY_IDS: AppIds = { dir: 'aios', service: 'aios-core.service', keyring: 'aios', kiosk: 'aios-kiosk', hyprModule: 'aios', legacy: true };

/**
 * Which names this process uses. The Astra package (/usr/bin/astra and the astra.service it writes
 * set ASTRA_PACKAGED=1) is always Astra. A source checkout is AI OS while ~/.config/aios/config.toml
 * exists, even after Astra is set up too, so an AI OS kept for falling back never reads Astra's
 * config, keyring or data; otherwise it is Astra.
 */
export function appIds(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): AppIds {
  if (env.ASTRA_PACKAGED === '1') return ASTRA_IDS;
  const base = env.XDG_CONFIG_HOME || `${env.HOME ?? ''}/.config`;
  return exists(`${base}/${LEGACY_IDS.dir}/config.toml`) ? LEGACY_IDS : ASTRA_IDS;
}
