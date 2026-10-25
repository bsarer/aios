/**
 * Reads and changes this computer's settings through Omarchy 4's own commands (S1).
 * Output formats follow how Omarchy's scripts parse the same commands (checked against
 * omarchy 2fca7fe): pactl's first "N%" token and "Mute: yes", nmcli's terse mode with
 * "\:" escapes and "*" for the network in use, wpctl's "[MUTED]", "Powered: yes".
 *
 * Limits live here as well as in the tool schemas, so no caller can get around them.
 * Names that arrive over the air (network and device names) are cleaned before use and
 * are only ever matched against the computer's own lists.
 */
import { z } from 'zod';
import { type Run, SystemCommandError, runCommand } from './run.js';

export const LIMITS = {
  volume: { min: 0, max: 100 },
  brightness: { min: 5, max: 100 },
} as const;

export const POWER_PROFILES = ['power-saver', 'balanced', 'performance'] as const;
export type PowerProfile = (typeof POWER_PROFILES)[number];

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

/** Over-the-air names: printable characters only, short. */
export function cleanName(s: string): string {
  return s
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
}

const firstPercent = (s: string): number | null => {
  const m = /(\d{1,3})%/.exec(s);
  return m ? Number(m[1]) : null;
};

/** Splits one line of nmcli terse output on unescaped ':' and undoes the escapes. */
export function splitTerse(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '\\' && i + 1 < line.length) cur += line[++i];
    else if (c === ':') (out.push(cur), (cur = ''));
    else cur += c;
  }
  out.push(cur);
  return out;
}

export interface WifiState {
  radio: boolean | null;
  network: string | null;
}
export interface SavedNetwork {
  name: string;
  inRange: boolean;
  signal: number | null;
  inUse: boolean;
}
export interface BtDevice {
  address: string;
  name: string;
  paired: boolean;
  connected: boolean;
}
export interface VolumeState {
  percent: number | null;
  muted: boolean | null;
  output: string | null;
}
export interface AudioOutput {
  index: number;
  name: string;
  description: string;
  current: boolean;
}

const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i;

/** `bluetoothctl devices [filter]` lines: "Device AA:BB:CC:DD:EE:FF Name". */
export function parseBtDevices(out: string): { address: string; name: string }[] {
  return out.split('\n').flatMap((l) => {
    const m = /^Device ((?:[0-9A-F]{2}:){5}[0-9A-F]{2})(?: (.*))?$/i.exec(l.trim());
    return m ? [{ address: m[1]!.toUpperCase(), name: cleanName(m[2] ?? '') || m[1]!.toUpperCase() }] : [];
  });
}

const SinkList = z.array(
  z.looseObject({ index: z.number(), name: z.string(), description: z.string().optional(), properties: z.record(z.string(), z.unknown()).optional() }),
);
const NightLight = z.looseObject({ enabled: z.boolean() });

export class SystemControls {
  constructor(private readonly run: Run = runCommand) {}

  private async out(cmd: Parameters<Run>[0], args: string[], timeoutMs = 5000): Promise<string> {
    const r = await this.run(cmd, args, { timeoutMs });
    if (r.code !== 0) throw new SystemCommandError('failed', cmd, `${cmd} ${args[0] ?? ''} failed`.trim());
    return r.stdout;
  }

  /** For commands that change something: no stdout pipe, a failure is an error. */
  private async act(cmd: Parameters<Run>[0], args: string[], what: string, timeoutMs = 10_000): Promise<void> {
    const r = await this.run(cmd, args, { timeoutMs, capture: false });
    if (r.code !== 0) throw new SystemCommandError('failed', cmd, `couldn't ${what}`);
  }

  // ── Volume ──

  private async sink(): Promise<string> {
    const s = (await this.out('omarchy-audio-output-sink', [])).trim();
    if (!s) throw new SystemCommandError('failed', 'omarchy-audio-output-sink', 'no audio output found');
    return s;
  }

  async volume(): Promise<VolumeState> {
    const sink = await this.sink();
    const [vol, mute, outputs] = await Promise.all([
      this.out('pactl', ['get-sink-volume', sink]),
      this.out('pactl', ['get-sink-mute', sink]),
      this.outputs().catch(() => [] as AudioOutput[]),
    ]);
    return { percent: firstPercent(vol), muted: /yes\s*$/.test(mute.trim()), output: outputs.find((o) => o.current)?.description ?? null };
  }

  /** Through Omarchy's volume command, so the on-screen display shows. It also unmutes. */
  async setVolume(percent: number): Promise<VolumeState> {
    const target = clamp(percent, LIMITS.volume.min, LIMITS.volume.max);
    const old = await this.volume();
    if (old.percent === null) throw new SystemCommandError('failed', 'pactl', "couldn't read the current volume");
    const delta = target - old.percent;
    await this.act('omarchy-audio-output-volume', [delta >= 0 ? `+${delta}` : `-${-delta}`], 'change the volume');
    return this.volume();
  }

  async setMuted(muted: boolean): Promise<VolumeState> {
    const old = await this.volume();
    if (old.muted !== muted) await this.act('omarchy-audio-output-volume', ['mute-toggle'], muted ? 'mute' : 'unmute');
    return this.volume();
  }

  // ── Audio outputs and microphone ──

  async outputs(): Promise<AudioOutput[]> {
    const [json, current] = await Promise.all([this.out('pactl', ['-f', 'json', 'list', 'sinks']), this.out('pactl', ['get-default-sink'])]);
    const sinks = SinkList.parse(JSON.parse(json));
    return sinks.map((s) => ({
      index: s.index,
      name: s.name,
      description: cleanName(s.description ?? String(s.properties?.['device.description'] ?? s.name)),
      current: s.name === current.trim(),
    }));
  }

  /** `output` must match one of the computer's own outputs, by description or name. */
  async setOutput(output: string): Promise<AudioOutput> {
    const all = await this.outputs();
    const want = output.trim().toLowerCase();
    const o = all.find((x) => x.description.toLowerCase() === want || x.name.toLowerCase() === want);
    if (!o) throw new SystemCommandError('refused', 'pactl', `there is no audio output called "${cleanName(output)}". Outputs: ${all.map((x) => x.description).join(', ')}`);
    await this.act('omarchy-audio-output-set-default', [String(o.index), o.name], 'switch the audio output');
    return o;
  }

  async micMuted(): Promise<boolean> {
    return /MUTED/.test(await this.out('wpctl', ['get-volume', '@DEFAULT_AUDIO_SOURCE@']));
  }

  async setMicMuted(muted: boolean): Promise<boolean> {
    if ((await this.micMuted()) !== muted) await this.act('omarchy-audio-input-mute', [], muted ? 'mute the microphone' : 'unmute the microphone');
    return this.micMuted();
  }

  // ── Display ──

  async brightness(): Promise<number | null> {
    const r = await this.run('omarchy-brightness-display', [], { timeoutMs: 5000 });
    const m = /\d{1,3}/.exec(r.stdout);
    return r.code === 0 && m ? Number(m[0]) : null;
  }

  /** Never "off": that would blank the screen. The minimum keeps it readable. */
  async setBrightness(percent: number): Promise<number | null> {
    const target = clamp(percent, LIMITS.brightness.min, LIMITS.brightness.max);
    await this.act('omarchy-brightness-display', [`${target}%`], 'change the brightness of this display');
    return this.brightness();
  }

  async nightLight(): Promise<boolean> {
    return NightLight.parse(JSON.parse(await this.out('omarchy-toggle-nightlight', ['--status']))).enabled;
  }

  async setNightLight(on: boolean): Promise<boolean> {
    if ((await this.nightLight()) !== on) await this.act('omarchy-toggle-nightlight', [], `turn night light ${on ? 'on' : 'off'}`);
    return this.nightLight();
  }

  async doNotDisturb(): Promise<boolean> {
    return (await this.out('omarchy-shell', ['notifications', 'isDnd'])).trim() === 'on';
  }

  async setDoNotDisturb(on: boolean): Promise<boolean> {
    if ((await this.doNotDisturb()) !== on) await this.act('omarchy-toggle-notification-silencing', [], `turn do not disturb ${on ? 'on' : 'off'}`);
    return this.doNotDisturb();
  }

  async lock(): Promise<void> {
    await this.act('omarchy-system-lock', [], 'lock the screen');
  }

  async themes(): Promise<{ current: string; all: string[] }> {
    const [current, list] = await Promise.all([this.out('omarchy-theme-current', []), this.out('omarchy-theme-list', [])]);
    return { current: current.trim(), all: list.split('\n').map((l) => l.trim()).filter(Boolean) };
  }

  async setTheme(name: string): Promise<string> {
    const { all } = await this.themes();
    const t = all.find((x) => x.toLowerCase() === name.trim().toLowerCase());
    if (!t) throw new SystemCommandError('refused', 'omarchy-theme-list', `there is no theme called "${cleanName(name)}". Themes: ${all.join(', ')}`);
    await this.act('omarchy-theme-set', [t], 'change the theme', 14_000);
    return t;
  }

  // ── Power ──

  async powerProfile(): Promise<{ current: PowerProfile | null; available: PowerProfile[] }> {
    const lines = (await this.out('omarchy-powerprofiles-list', ['--active-state'])).split('\n').map((l) => l.trim().split('\t'));
    const known = (p: string | undefined): p is PowerProfile => (POWER_PROFILES as readonly string[]).includes(p ?? '');
    const available = lines.map((l) => l[0]).filter(known);
    return { current: lines.find((l) => l[1] === '1' && known(l[0]))?.[0] as PowerProfile | undefined ?? null, available };
  }

  async setPowerProfile(profile: PowerProfile): Promise<PowerProfile | null> {
    const { available } = await this.powerProfile();
    if (!available.includes(profile)) throw new SystemCommandError('refused', 'omarchy-powerprofiles-set', `this computer has no ${profile} profile (it has ${available.join(', ')})`);
    // autodetect: remembered for whichever of AC or battery the computer is on now, as Omarchy's own menu does.
    await this.act('omarchy-powerprofiles-set', ['autodetect', profile], 'change the power profile');
    return (await this.powerProfile()).current;
  }

  async batteryText(): Promise<string | null> {
    const s = (await this.out('omarchy-battery-status', [])).trim();
    return s ? cleanName(s) : null;
  }

  async stats(): Promise<{ cpu: string | null; memory: string | null }> {
    const rows = new Map((await this.out('omarchy-system-stats', [])).split('\n').map((l) => l.split('\t') as [string, string]));
    return { cpu: rows.get('cpu')?.trim() ?? null, memory: rows.get('memory')?.trim() ?? null };
  }

  // ── Wi-Fi ──

  async wifi(): Promise<WifiState> {
    const [radio, active] = await Promise.all([
      this.out('nmcli', ['radio', 'wifi']).then((s) => s.trim() === 'enabled'),
      this.out('nmcli', ['-t', '-f', 'ACTIVE,SSID', 'device', 'wifi']).catch(() => ''),
    ]);
    const line = active.split('\n').find((l) => l.startsWith('yes:'));
    return { radio, network: line ? cleanName(splitTerse(line)[1] ?? '') || null : null };
  }

  async setWifiRadio(on: boolean): Promise<WifiState> {
    await this.act('nmcli', ['radio', 'wifi', on ? 'on' : 'off'], `turn Wi-Fi ${on ? 'on' : 'off'}`);
    return this.wifi();
  }

  /**
   * Saved networks only, with whether each is in range. Networks that were never saved are
   * counted, not named: their names are chosen by strangers, and joining a new one (which
   * needs its password) happens in Omarchy's Network panel, not in the chat.
   */
  async savedNetworks(): Promise<{ saved: SavedNetwork[]; othersNearby: number }> {
    const [conns, scan] = await Promise.all([
      this.out('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show']),
      this.out('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL', 'device', 'wifi', 'list', '--rescan', 'auto'], 12_000).catch(() => ''),
    ]);
    const names = conns
      .split('\n')
      .map(splitTerse)
      .filter((f) => f[1] === '802-11-wireless' && f[0])
      .map((f) => f[0]!);
    const seen = new Map<string, { signal: number | null; inUse: boolean }>();
    for (const line of scan.split('\n').filter(Boolean)) {
      const [inUse = '', ssid = '', signal = ''] = splitTerse(line);
      if (!ssid) continue;
      const prev = seen.get(ssid);
      const s = Number(signal);
      if (!prev || (Number.isFinite(s) && s > (prev.signal ?? -1)) || inUse.trim() === '*') {
        seen.set(ssid, { signal: Number.isFinite(s) ? s : null, inUse: inUse.trim() === '*' || (prev?.inUse ?? false) });
      }
    }
    const saved = [...new Set(names)].map((name) => {
      const s = seen.get(name);
      return { name: cleanName(name), inRange: !!s, signal: s?.signal ?? null, inUse: s?.inUse ?? false };
    });
    const othersNearby = [...seen.keys()].filter((ssid) => !names.includes(ssid)).length;
    return { saved, othersNearby };
  }

  /** Connects only to a network this computer has already saved; never asks for a password. */
  async connectSaved(name: string): Promise<WifiState> {
    const { saved } = await this.savedNetworks();
    const n = saved.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!n) throw new SystemCommandError('refused', 'nmcli', `"${cleanName(name)}" is not a saved network. New networks are joined in Omarchy's Network panel (Super+Ctrl+N)`);
    await this.act('nmcli', ['connection', 'up', 'id', n.name], `connect to ${n.name}`, 30_000);
    return this.wifi();
  }

  // ── Bluetooth ──

  async bluetoothOn(): Promise<boolean> {
    return (await this.run('omarchy-bluetooth-power', ['is-on'], { timeoutMs: 5000 })).code === 0;
  }

  async setBluetooth(on: boolean): Promise<boolean> {
    await this.act('omarchy-bluetooth-power', [on ? 'on' : 'off'], `turn Bluetooth ${on ? 'on' : 'off'}`);
    return this.bluetoothOn();
  }

  /** Known devices; with scan, also looks for new ones nearby for a few seconds first. */
  async bluetoothDevices(opts: { scan?: boolean } = {}): Promise<BtDevice[]> {
    if (opts.scan) await this.run('bluetoothctl', ['--timeout', '8', 'scan', 'on'], { timeoutMs: 12_000, capture: false });
    const [all, paired, connected] = await Promise.all([
      this.out('bluetoothctl', ['devices']),
      this.out('bluetoothctl', ['devices', 'Paired']),
      this.out('bluetoothctl', ['devices', 'Connected']),
    ]);
    const p = new Set(parseBtDevices(paired).map((d) => d.address));
    const c = new Set(parseBtDevices(connected).map((d) => d.address));
    return parseBtDevices(all).map((d) => ({ ...d, paired: p.has(d.address), connected: c.has(d.address) }));
  }

  /** A device from the computer's own list, by address or exact name. */
  async findDevice(query: string, want: 'paired' | 'unpaired'): Promise<BtDevice> {
    const q = query.trim();
    const all = await this.bluetoothDevices();
    const matches = all.filter((d) => (MAC.test(q) ? d.address === q.toUpperCase() : d.name.toLowerCase() === q.toLowerCase()));
    const d = matches.find((x) => (want === 'paired' ? x.paired : !x.paired));
    if (!d) {
      const list = all.filter((x) => (want === 'paired' ? x.paired : !x.paired)).map((x) => x.name);
      throw new SystemCommandError('refused', 'bluetoothctl', `no ${want} device called "${cleanName(q)}"${list.length ? `. ${want === 'paired' ? 'Paired' : 'Found'}: ${list.join(', ')}` : ''}`);
    }
    if (matches.length > 1 && !MAC.test(q)) throw new SystemCommandError('refused', 'bluetoothctl', `more than one device is called "${d.name}"`);
    return d;
  }

  async bluetoothDevice(action: 'connect' | 'disconnect' | 'pair' | 'forget', d: BtDevice): Promise<BtDevice | null> {
    if (!MAC.test(d.address)) throw new SystemCommandError('refused', 'bluetoothctl', 'not a device address');
    // Omarchy's command never fails on its own (it ignores bluetoothctl errors), so read the result back.
    await this.act('omarchy-bluetooth-device', [action, d.address], `${action} ${d.name}`, 60_000);
    return (await this.bluetoothDevices()).find((x) => x.address === d.address) ?? null;
  }
}
