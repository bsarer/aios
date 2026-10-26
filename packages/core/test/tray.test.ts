import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TRAY_ID, TrayIcon, circlePixmap } from '../src/apps/tray.js';

const hasDbus = (() => {
  try {
    execFileSync('dbus-daemon', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// any: the library's own typings don't cover what the test's pretend bar uses; tray.ts types what production uses.
type Bus = any;
const dbus = createRequire(import.meta.url)('@homebridge/dbus-native') as { sessionBus(o: { busAddress: string }): Bus };

describe('circle pixmap', () => {
  it('is an opaque red circle with transparent corners, ARGB in network order', () => {
    const [w, h, px] = circlePixmap(22);
    expect([w, h, px.length]).toEqual([22, 22, 22 * 22 * 4]);
    expect(px[0]).toBe(0);
    const mid = (11 * 22 + 11) * 4;
    expect(px[mid]).toBe(255);
    expect(px[mid + 1]).toBeGreaterThan(200);
    expect(px[mid + 2]).toBeLessThan(120);
  });
});

describe.skipIf(!hasDbus)('tray icon on a session bus', () => {
  let daemon: ChildProcess;
  let address = '';
  let watcher: Bus;
  const registered: string[] = [];

  const call = (bus: Bus, msg: Record<string, unknown>) =>
    new Promise<{ err: { name: string } | null; body: unknown[] }>((resolve) => bus.invoke(msg, (err: { name: string } | null, ...body: unknown[]) => resolve({ err, body })));

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aios-dbus-'));
    address = `unix:path=${join(dir, 'bus')}`;
    daemon = spawn('dbus-daemon', ['--session', '--nofork', `--address=${address}`, '--print-address'], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((r) => daemon.stdout!.once('data', () => r()));
    // A pretend bar: owns the watcher name and records registrations.
    watcher = dbus.sessionBus({ busAddress: address });
    await new Promise<void>((r) => watcher.requestName('org.kde.StatusNotifierWatcher', 4, () => r()));
    watcher.exportInterface({ RegisterStatusNotifierItem: (name: string) => void registered.push(name) }, '/StatusNotifierWatcher', {
      name: 'org.kde.StatusNotifierWatcher',
      methods: { RegisterStatusNotifierItem: ['s', ''] },
      properties: {},
      signals: {},
    });
  });

  afterAll(() => {
    watcher?.connection.end();
    daemon?.kill();
  });

  it('registers with the bar, starts hidden, shows when asked and opens the chat on a click', async () => {
    let clicks = 0;
    const errors: string[] = [];
    const tray = new TrayIcon({ onActivate: () => clicks++, onError: (e) => errors.push(e), busAddress: address });
    expect(await tray.start()).toBe(true);
    await vi.waitFor(() => expect(registered).toEqual([`org.kde.StatusNotifierItem-${process.pid}-1`]));
    const item = { destination: registered[0], path: '/StatusNotifierItem' };
    const props = (await call(watcher, { ...item, interface: 'org.freedesktop.DBus.Properties', member: 'GetAll', signature: 's', body: ['org.kde.StatusNotifierItem'] })).body[0] as [string, [unknown, unknown[]]][];
    const get = (k: string) => props.find(([n]) => n === k)?.[1][1][0];
    expect([get('Id'), get('Title'), get('Status'), get('ItemIsMenu')]).toEqual([TRAY_ID, 'AI OS', 'Passive', false]);

    const statuses: unknown[] = [];
    await new Promise<void>((r) => watcher.addMatch("type='signal',interface='org.kde.StatusNotifierItem',member='NewStatus'", () => r()));
    watcher.signals.on(JSON.stringify({ path: '/StatusNotifierItem', interface: 'org.kde.StatusNotifierItem', member: 'NewStatus' }), (body: unknown[]) => statuses.push(body[0]));
    tray.setVisible(true);
    await vi.waitFor(() => expect(statuses).toEqual(['Active']));

    expect((await call(watcher, { ...item, interface: 'org.kde.StatusNotifierItem', member: 'Activate', signature: 'ii', body: [0, 0] })).err).toBeNull();
    expect(clicks).toBe(1);
    // Nothing on the bus can change it or crash it: Set is ignored, a property called as a method is an error.
    await call(watcher, { ...item, interface: 'org.freedesktop.DBus.Properties', member: 'Set', signature: 'ssv', body: ['org.kde.StatusNotifierItem', 'Status', ['s', 'Passive']] });
    expect((await call(watcher, { ...item, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: ['org.kde.StatusNotifierItem', 'Status'] })).body[0]).toEqual([expect.anything(), ['Active']]);
    expect((await call(watcher, { ...item, interface: 'org.kde.StatusNotifierItem', member: 'Title', signature: '', body: [] })).err).not.toBeNull();
    expect((await call(watcher, { ...item, interface: 'org.kde.StatusNotifierItem', member: 'toString', signature: '', body: [] })).err?.name).toBe('org.freedesktop.DBus.Error.UnknownMethod');
    expect((await call(watcher, { ...item, interface: 'org.kde.StatusNotifierItem', member: 'SecondaryActivate', signature: 'ii', body: [0, 0] })).err).toBeNull();
    expect(clicks).toBe(2);
    expect(errors).toEqual([]);
    tray.stop();
  });

  it('is off without a session bus', async () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      expect(await new TrayIcon({ onActivate: () => undefined }).start()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });
});
