/**
 * Chat tools for system controls (S1). Reads are `read`; small reversible changes are
 * `device` (the registry hides them while email is in context, refuses them while paused
 * and rate limits them); Wi-Fi off, switching networks and pairing or forgetting devices
 * are `write` and only ever show a card (SystemActions). Every change reads the setting
 * before and after, and both values go in the audit log.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolResult } from '../tools/registry.js';
import type { SystemActions } from './actions.js';
import type { PowerProfile, SystemControls } from './controls.js';

/** Pair cards a single scan may post. */
export const MAX_PAIR_CARDS = 6;

const q = (s: string) => `“${s}”`;
const onOff = (b: boolean | null | undefined) => (b === null || b === undefined ? 'unknown' : b ? 'on' : 'off');
const pct = (n: number | null | undefined) => (n === null || n === undefined ? 'unknown' : `${n}%`);

export function systemTools(o: { controls: SystemControls; actions: SystemActions }): RegisteredTool[] {
  const c = o.controls;
  const tool = (name: string, label: string, handler: RegisteredTool['handler']): RegisteredTool => ({ def: toolByName(name)!, label, handler });
  const change = <T>(content: string, old: T, now: T): ToolResult => ({ content, audit: { old, new: now } });
  // The registry never calls a write-tier handler; reaching one is a bug.
  const neverRuns = async (): Promise<string> => {
    throw new Error('write-tier system actions run only from a click on their card');
  };
  const cardTool = (name: string, label: string, propose: NonNullable<RegisteredTool['propose']>): RegisteredTool => ({
    def: toolByName(name)!,
    label,
    handler: neverRuns,
    propose,
  });
  const CARD_SHOWN = 'A card now asks the user to confirm. Nothing has changed yet, and only their click can change it, so do not say it is done.';

  return [
    tool('system_status', 'Checking the computer…', async () => {
      const get = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
      const [wifi, bt, vol, mic, bright, night, dnd, power, battery, stats, theme] = await Promise.all([
        get(c.wifi()),
        get(c.bluetoothOn()),
        get(c.volume()),
        get(c.micMuted()),
        get(c.brightness()),
        get(c.nightLight()),
        get(c.doNotDisturb()),
        get(c.powerProfile()),
        get(c.batteryText()),
        get(c.stats()),
        get(c.themes()),
      ]);
      return [
        `Wi-Fi: ${wifi ? `${onOff(wifi.radio)}${wifi.network ? `, connected to ${q(wifi.network)}` : ', not connected'}` : 'unknown'}`,
        `Bluetooth: ${onOff(bt)}`,
        `Volume: ${vol ? `${pct(vol.percent)}${vol.muted ? ' (muted)' : ''}${vol.output ? `, output ${q(vol.output)}` : ''}` : 'unknown'}`,
        `Microphone: ${mic === null ? 'unknown' : mic ? 'muted' : 'on'}`,
        `Brightness: ${pct(bright)}`,
        `Night light: ${onOff(night)}`,
        `Do not disturb: ${onOff(dnd)}`,
        `Power profile: ${power?.current ?? 'unknown'}${power?.available.length ? ` (available: ${power.available.join(', ')})` : ''}`,
        `Battery: ${battery ?? 'none or unknown'}`,
        `CPU: ${stats?.cpu ?? 'unknown'}; memory: ${stats?.memory ?? 'unknown'}`,
        `Theme: ${theme?.current ?? 'unknown'}`,
      ].join('\n');
    }),

    tool('wifi_networks', 'Looking at Wi-Fi networks…', async () => {
      const [{ saved, othersNearby }, wifi] = await Promise.all([c.savedNetworks(), c.wifi()]);
      const lines = saved.map((n) => `- ${q(n.name)}: ${n.inUse ? 'connected' : n.inRange ? `in range${n.signal !== null ? ` (signal ${n.signal}%)` : ''}` : 'not in range'}`);
      return [
        `Wi-Fi is ${onOff(wifi.radio)}.`,
        saved.length ? `Saved networks:\n${lines.join('\n')}` : 'No saved networks.',
        `${othersNearby} other network${othersNearby === 1 ? '' : 's'} nearby. Joining a new network happens in Omarchy's Network panel (Super+Ctrl+N), not in this chat.`,
      ].join('\n');
    }),

    tool('bluetooth_devices', 'Looking at Bluetooth devices…', async () => {
      const [on, devices] = await Promise.all([c.bluetoothOn(), c.bluetoothDevices()]);
      const paired = devices.filter((d) => d.paired);
      return [
        `Bluetooth is ${onOff(on)}.`,
        paired.length ? `Paired devices:\n${paired.map((d) => `- ${q(d.name)} (${d.address}): ${d.connected ? 'connected' : 'not connected'}`).join('\n')}` : 'No paired devices.',
      ].join('\n');
    }),

    tool('audio_outputs', 'Looking at audio outputs…', async () => {
      const outs = await c.outputs();
      return outs.length ? outs.map((x) => `- ${q(x.description)}${x.current ? ' (in use)' : ''}`).join('\n') : 'No audio outputs found.';
    }),

    tool('theme_list', 'Looking at themes…', async () => {
      const t = await c.themes();
      return `Current theme: ${t.current}\nInstalled: ${t.all.join(', ')}`;
    }),

    tool('volume_set', 'Changing the volume…', async (args) => {
      const a = args as { percent?: number; muted?: boolean };
      const old = await c.volume();
      let now = old;
      if (a.percent !== undefined) now = await c.setVolume(a.percent);
      if (a.muted !== undefined) now = await c.setMuted(a.muted);
      return change(`Volume is now ${pct(now.percent)}${now.muted ? ', muted' : ''} (was ${pct(old.percent)}${old.muted ? ', muted' : ''}).`, old, now);
    }),

    tool('brightness_set', 'Changing the brightness…', async (args) => {
      const old = await c.brightness();
      const now = await c.setBrightness((args as { percent: number }).percent);
      return change(`Brightness is now ${pct(now)} (was ${pct(old)}).`, old, now);
    }),

    tool('wifi_on', 'Turning Wi-Fi on…', async () => {
      const old = await c.wifi();
      const now = old.radio ? old : await c.setWifiRadio(true);
      return change(old.radio ? 'Wi-Fi was already on.' : `Wi-Fi is now ${onOff(now.radio)}. It will join a saved network by itself if one is in range.`, old, now);
    }),

    cardTool('wifi_off', 'Asking to turn Wi-Fi off…', async () => {
      if ((await c.wifi()).radio === false) return 'Wi-Fi is already off.';
      o.actions.propose({ action: 'wifi_off' });
      return CARD_SHOWN;
    }),

    cardTool('wifi_connect', 'Asking to switch networks…', async (args) => {
      const want = (args as { network: string }).network.trim().toLowerCase();
      const { saved } = await c.savedNetworks();
      const n = saved.find((s) => s.name.toLowerCase() === want);
      if (!n) return `Error: that is not a saved network. Saved: ${saved.map((s) => q(s.name)).join(', ') || 'none'}. New networks are joined in Omarchy's Network panel (Super+Ctrl+N).`;
      if (n.inUse) return `Already connected to ${q(n.name)}.`;
      o.actions.propose({ action: 'wifi_connect', network: n.name });
      return CARD_SHOWN;
    }),

    tool('bluetooth_power', 'Changing Bluetooth…', async (args) => {
      const on = (args as { on: boolean }).on;
      const old = await c.bluetoothOn();
      const now = old === on ? old : await c.setBluetooth(on);
      return change(old === on ? `Bluetooth was already ${onOff(on)}.` : `Bluetooth is now ${onOff(now)}.`, old, now);
    }),

    tool('bluetooth_connection', 'Changing a Bluetooth connection…', async (args) => {
      const a = args as { device: string; action: 'connect' | 'disconnect' };
      const d = await c.findDevice(a.device, 'paired');
      if (d.connected === (a.action === 'connect')) return `${q(d.name)} is already ${a.action === 'connect' ? 'connected' : 'disconnected'}.`;
      const now = await c.bluetoothDevice(a.action, d);
      const ok = now?.connected === (a.action === 'connect');
      return change(
        ok ? `${q(d.name)} is ${a.action === 'connect' ? 'connected' : 'disconnected'}.` : `Error: ${q(d.name)} did not ${a.action}. If it is off or out of range, turn it on and try again.`,
        d,
        now,
      );
    }),

    tool('bluetooth_scan', 'Looking for Bluetooth devices…', async () => {
      if (!(await c.bluetoothOn())) await c.setBluetooth(true);
      const found = (await c.bluetoothDevices({ scan: true })).filter((d) => !d.paired).slice(0, MAX_PAIR_CARDS);
      // Names here are chosen by whoever owns the device. They go on cards for the user to
      // read, never back to the model.
      for (const d of found) o.actions.propose({ action: 'bluetooth_pair', address: d.address, name: d.name });
      return found.length
        ? `Found ${found.length} device${found.length === 1 ? '' : 's'}; each is on a card with a Pair button. You cannot see their names. Ask the user to click Pair on the right one.`
        : 'No new devices found. Ask the user to put the device in pairing mode and try again.';
    }),

    cardTool('bluetooth_forget', 'Asking to forget a device…', async (args) => {
      const d = await c.findDevice((args as { device: string }).device, 'paired');
      o.actions.propose({ action: 'bluetooth_forget', address: d.address, name: d.name });
      return CARD_SHOWN;
    }),

    tool('night_light', 'Changing night light…', async (args) => {
      const on = (args as { on: boolean }).on;
      const old = await c.nightLight();
      const now = await c.setNightLight(on);
      return change(`Night light is now ${onOff(now)}${old === now ? ' (no change)' : ''}.`, old, now);
    }),

    tool('do_not_disturb', 'Changing do not disturb…', async (args) => {
      const on = (args as { on: boolean }).on;
      const old = await c.doNotDisturb();
      const now = await c.setDoNotDisturb(on);
      return change(`Do not disturb is now ${onOff(now)}${old === now ? ' (no change)' : ''}.`, old, now);
    }),

    tool('audio_output_set', 'Switching audio output…', async (args) => {
      const old = (await c.outputs()).find((x) => x.current)?.description ?? null;
      const now = (await c.setOutput((args as { output: string }).output)).description;
      return change(`Sound now plays through ${q(now)}.`, old, now);
    }),

    tool('microphone_mute', 'Changing the microphone…', async (args) => {
      const muted = (args as { muted: boolean }).muted;
      const old = await c.micMuted();
      const now = await c.setMicMuted(muted);
      return change(`The microphone is now ${now ? 'muted' : 'on'}${old === now ? ' (no change)' : ''}.`, old, now);
    }),

    tool('power_profile_set', 'Changing the power profile…', async (args) => {
      const old = (await c.powerProfile()).current;
      const now = await c.setPowerProfile((args as { profile: PowerProfile }).profile);
      return change(`Power profile is now ${now ?? 'unknown'} (was ${old ?? 'unknown'}).`, old, now);
    }),

    tool('screen_lock', 'Locking the screen…', async () => {
      await c.lock();
      return change('The screen is locked.', 'unlocked', 'locked');
    }),

    tool('theme_set', 'Changing the theme…', async (args) => {
      const old = (await c.themes()).current;
      const now = await c.setTheme((args as { name: string }).name);
      return change(`The theme is now ${now} (was ${old}).`, old, now);
    }),
  ];
}
