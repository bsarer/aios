/**
 * The red circle in the bar's tray while an app the chat started is open (S3). It is a
 * standard StatusNotifierItem on the session bus, the same thing other apps' tray icons
 * are; Omarchy 4's bar (Quickshell's SystemTray) shows it and calls Activate on a left
 * click. Checked against Quickshell's src/services/status_notifier and Omarchy's
 * shell/plugins/bar/widgets/Tray.qml, October 2026:
 *
 * - the item registers its bus name with org.kde.StatusNotifierWatcher (the bar) and is
 *   read with Properties.GetAll on /StatusNotifierItem;
 * - Status "Passive" hides it from the bar, "Active" shows it; NewStatus says it changed;
 * - IconPixmap (ARGB32, network byte order) is drawn as is, so no icon theme is needed.
 *
 * Anything on the session bus can call Activate; all it does is show the chat.
 */
import { createRequire } from 'node:module';
import { TRAY_ITEM_ID } from '@aios/shared';

const ITEM_PATH = '/StatusNotifierItem';
const ITEM_IFACE = 'org.kde.StatusNotifierItem';
const WATCHER = 'org.kde.StatusNotifierWatcher';
const DBUS = 'org.freedesktop.DBus';
export const TRAY_ID = TRAY_ITEM_ID;

/** The little of @homebridge/dbus-native used here; its own typings don't cover the session bus. */
interface DbusBus {
  connection: { on(ev: 'error' | 'end', fn: (err?: Error) => void): void; end(): void };
  signals: { on(key: string, fn: (body: unknown[]) => void): void };
  invoke(msg: Record<string, unknown>, cb: (err: { name: string; message: string } | null, ...body: unknown[]) => void): void;
  requestName(name: string, flags: number, cb: (err: unknown, code: number) => void): void;
  exportInterface(impl: object, path: string, iface: { name: string; methods: object; properties: object; signals: object }): void;
  sendSignal(path: string, iface: string, member: string, signature: string, body: unknown[]): void;
  addMatch(rule: string, cb: (err: unknown) => void): void;
}
interface DbusNative {
  sessionBus(opts?: { busAddress?: string }): DbusBus;
}
const dbus = createRequire(import.meta.url)('@homebridge/dbus-native') as DbusNative;

/** A filled red circle, antialiased, as one ARGB32 pixmap in network byte order. */
export function circlePixmap(size: number): [number, number, Buffer] {
  const px = Buffer.alloc(size * size * 4);
  const r = size / 2 - 1;
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cover = Math.max(0, Math.min(1, r - d + 0.5));
      // A light spot towards the top left.
      const shine = Math.max(0, 1 - Math.hypot(x + 0.5 - c * 0.7, y + 0.5 - c * 0.6) / r) * 0.35;
      const i = (y * size + x) * 4;
      px[i] = Math.round(cover * 255);
      px[i + 1] = Math.round(0xe0 + (255 - 0xe0) * shine);
      px[i + 2] = Math.round(0x26 + (255 - 0x26) * shine);
      px[i + 3] = Math.round(0x2f + (255 - 0x2f) * shine);
    }
  }
  return [size, size, px];
}

export interface TrayOptions {
  /** Left or middle click on the circle. */
  onActivate: () => void;
  /** Problems worth an audit line; never fatal. */
  onError?: (what: string) => void;
  /** Default: $DBUS_SESSION_BUS_ADDRESS. */
  busAddress?: string;
}

export class TrayIcon {
  private bus: DbusBus | null = null;
  private status: 'Active' | 'Passive' = 'Passive';
  private readonly name = `org.kde.StatusNotifierItem-${process.pid}-1`;

  constructor(private readonly o: TrayOptions) {}

  /** Connects and registers with the bar. False when there is no session bus. */
  async start(): Promise<boolean> {
    const address = this.o.busAddress ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) return false;
    let bus: DbusBus;
    try {
      bus = dbus.sessionBus({ busAddress: address });
    } catch (err) {
      this.o.onError?.(`no session bus: ${(err as Error).message}`);
      return false;
    }
    this.bus = bus;
    bus.connection.on('error', (err) => this.o.onError?.(`session bus: ${err?.message ?? 'error'}`));
    const ok = await new Promise<boolean>((resolve) => {
      // 4: DBUS_NAME_FLAG_DO_NOT_QUEUE. 1 means we own it.
      bus.requestName(this.name, 4, (err, code) => resolve(!err && code === 1));
    });
    if (!ok) {
      this.o.onError?.(`could not own ${this.name}`);
      return false;
    }
    this.export(bus);
    // The bar may start after us, or restart: register whenever a watcher appears.
    bus.addMatch(`type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${WATCHER}'`, () => undefined);
    bus.signals.on(JSON.stringify({ path: '/org/freedesktop/DBus', interface: DBUS, member: 'NameOwnerChanged' }), (body) => {
      if (body[0] === WATCHER && body[2]) this.register();
    });
    this.register();
    return true;
  }

  get visible(): boolean {
    return this.status === 'Active';
  }

  setVisible(visible: boolean): void {
    const status = visible ? 'Active' : 'Passive';
    if (status === this.status) return;
    this.status = status;
    this.bus?.sendSignal(ITEM_PATH, ITEM_IFACE, 'NewStatus', 's', [status]);
  }

  stop(): void {
    this.bus?.connection.end();
    this.bus = null;
  }

  private register(): void {
    this.bus?.invoke(
      { destination: WATCHER, path: '/StatusNotifierWatcher', interface: WATCHER, member: 'RegisterStatusNotifierItem', signature: 's', body: [this.name] },
      // No bar yet is normal at login; NameOwnerChanged brings it.
      (err) => err && err.name !== 'org.freedesktop.DBus.Error.ServiceUnknown' && this.o.onError?.(`tray registration: ${err.message || err.name}`),
    );
  }

  private export(bus: DbusBus): void {
    const pixmaps = [16, 22, 24, 32, 48, 64].map(circlePixmap);
    const activate = () => {
      this.o.onActivate();
    };
    const props: Record<string, () => unknown> = {
      Category: () => 'ApplicationStatus',
      Id: () => TRAY_ID,
      Title: () => 'AI OS',
      Status: () => this.status,
      WindowId: () => 0,
      IconName: () => '',
      IconThemePath: () => '',
      IconPixmap: () => pixmaps,
      OverlayIconName: () => '',
      OverlayIconPixmap: () => [],
      AttentionIconName: () => '',
      AttentionIconPixmap: () => [],
      AttentionMovieName: () => '',
      ToolTip: () => ['', [], 'AI OS', 'Click to open the chat'],
      ItemIsMenu: () => false,
      Menu: () => '/NO_DBUSMENU',
    };
    const types: Record<string, string> = {
      Category: 's',
      Id: 's',
      Title: 's',
      Status: 's',
      WindowId: 'i',
      IconName: 's',
      IconThemePath: 's',
      IconPixmap: 'a(iiay)',
      OverlayIconName: 's',
      OverlayIconPixmap: 'a(iiay)',
      AttentionIconName: 's',
      AttentionIconPixmap: 'a(iiay)',
      AttentionMovieName: 's',
      ToolTip: '(sa(iiay)ss)',
      ItemIsMenu: 'b',
      Menu: 'o',
    };
    const methods: Record<string, [string, string]> = { Activate: ['ii', ''], SecondaryActivate: ['ii', ''], ContextMenu: ['ii', ''], Scroll: ['is', ''] };
    // No prototype, so no inherited names answer; read-only, so Properties.Set changes nothing.
    const impl = Object.create(null) as Record<string, unknown>;
    for (const [k, get] of Object.entries(props)) Object.defineProperty(impl, k, { get, set: () => undefined, enumerable: true });
    Object.assign(impl, { Activate: activate, SecondaryActivate: activate, ContextMenu: () => undefined, Scroll: () => undefined });
    bus.exportInterface(impl, ITEM_PATH, {
      name: ITEM_IFACE,
      // The library looks up methods[member] for any member impl has, properties included;
      // answering every name keeps a call to a property name from throwing in its event handler.
      methods: new Proxy(methods, { get: (t, k) => (typeof k === 'string' && Object.hasOwn(t, k) ? t[k] : ['', '']) }),
      properties: types,
      signals: { NewStatus: ['s', 'status'], NewIcon: ['', ''], NewTitle: ['', ''], NewToolTip: ['', ''] },
    });
  }
}
