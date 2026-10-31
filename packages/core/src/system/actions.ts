/**
 * The approval broker for system changes that could cut the user off or are hard to undo
 * (S1, write tier): Wi-Fi off, switching networks, pairing and forgetting Bluetooth devices;
 * device-tier changes asked for while an email was in the model's view; and building an app
 * with Claude Code (S4).
 * A model call can only create a pending card (the tool's `propose`). The change runs from
 * confirm(), reached solely by a click on that card carrying the hash the card showed.
 *
 *   pending ──confirm click (hash matches)──▶ running ──▶ done | failed
 *      └──── cancel ──▶ cancelled
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ChatItem } from '@aios/shared';
import type { AuditLog } from '../audit.js';
import type { Store } from '../store.js';
import { type BtDevice, type SystemControls, cleanName } from './controls.js';
import { SystemCommandError } from './run.js';

export type SystemAction =
  | { action: 'wifi_off' }
  | { action: 'wifi_connect'; network: string }
  | { action: 'bluetooth_pair'; address: string; name: string }
  | { action: 'bluetooth_forget'; address: string; name: string }
  /** A device-tier change asked for while an email was in view: runs only after a click. */
  | { action: 'device'; tool: string; args: unknown; summary: string }
  /** S4: build or change an app. `request` is the user's own words; audits get its length only. */
  | { action: 'build_app'; name: string; slug: string; request: string; update: boolean };

/** Builds the app a Build card names; set by buildAppTool. Returns the card's result text and audit fields. */
export type AppBuildRunner = (a: Extract<SystemAction, { action: 'build_app' }>) => Promise<{ result: string; audit?: Record<string, unknown> }>;

/** What audits record of an action: never the words of a build request. */
function auditable(a: SystemAction): Record<string, unknown> {
  if (a.action !== 'build_app') return a;
  const { request, ...rest } = a;
  return { ...rest, requestChars: request.length };
}

/** Runs a device-tier tool by name; set by systemTools. Returns the text and audit fields. */
export type DeviceRunner = (tool: string, args: unknown) => Promise<{ content: string; audit?: Record<string, unknown> }>;

type ActionItem = Extract<ChatItem, { kind: 'action' }>;
type ActionState = ActionItem['state'];

interface Row {
  id: string;
  spec: string;
  title: string;
  confirm: string;
  hash: string;
  state: ActionState;
  result: string | null;
  created_at: number;
}

export interface SystemActionsOptions {
  store: Store;
  controls: SystemControls;
  audit: AuditLog;
  show: (item: ChatItem, isNew: boolean) => void;
  notice: (level: 'info' | 'warning' | 'error', text: string) => void;
  isPaused?: () => boolean;
  clock?: () => number;
  newId?: () => string;
}

export type ConfirmResult = 'done' | 'failed' | 'refused';

/** One short reason for a failed system command. */
export function describeSystemError(err: unknown): string {
  if (err instanceof SystemCommandError) return err.message;
  return ((err as Error)?.message ?? 'unknown error').slice(0, 200);
}

const q = (s: string) => `“${s}”`;

function card(a: SystemAction): { title: string; confirm: string } {
  switch (a.action) {
    case 'wifi_off':
      return { title: "Turn Wi-Fi off? This computer will be offline until it's turned back on.", confirm: 'Turn off' };
    case 'wifi_connect':
      return { title: `Switch Wi-Fi to ${q(a.network)}?`, confirm: 'Connect' };
    case 'bluetooth_pair':
      return { title: `Pair with ${q(a.name)} (${a.address})? Put it in pairing mode first.`, confirm: 'Pair' };
    case 'bluetooth_forget':
      return { title: `Forget ${q(a.name)} (${a.address})? It will need pairing again to use it.`, confirm: 'Forget' };
    case 'device':
      return { title: `${a.summary}? This was asked for while I was reading an email, so I'm checking with you first.`, confirm: 'Do it' };
    case 'build_app': {
      const req = a.request.length > 300 ? `${a.request.slice(0, 300)}…` : a.request;
      return a.update
        ? { title: `Change the app ${q(a.name)}? Claude Code will edit it as you asked: ${q(req)}. It takes a few minutes and only touches that app's folder.`, confirm: 'Change' }
        : { title: `Build a new app, ${q(a.name)}? Claude Code will write it from your request: ${q(req)}. It takes a few minutes and only touches that app's own folder.`, confirm: 'Build' };
    }
  }
}

export class SystemActions {
  private readonly clock: () => number;
  private readonly newId: () => string;
  private deviceRunner: DeviceRunner | null = null;
  private appBuilder: AppBuildRunner | null = null;

  constructor(private readonly o: SystemActionsOptions) {
    this.clock = o.clock ?? Date.now;
    this.newId = o.newId ?? (() => `action-${randomUUID().slice(0, 8)}`);
  }

  setDeviceRunner(run: DeviceRunner): void {
    this.deviceRunner = run;
  }

  setAppBuilder(run: AppBuildRunner): void {
    this.appBuilder = run;
  }

  private get db() {
    return this.o.store.db;
  }

  private row(id: string): Row | null {
    return (this.db.prepare('SELECT * FROM system_actions WHERE id = ?').get(id) as Row | undefined) ?? null;
  }

  private item(r: Row): ActionItem {
    return { kind: 'action', id: r.id, title: r.title, confirm: r.confirm, hash: r.hash, state: r.state, ...(r.result ? { result: r.result } : {}), at: r.created_at };
  }

  private refresh(id: string): void {
    const r = this.row(id);
    if (r) this.o.show(this.item(r), false);
  }

  private transition(id: string, from: ActionState[], to: ActionState, result: string | null = null): boolean {
    const r = this.db
      .prepare(`UPDATE system_actions SET state = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
      .run(to, result, this.clock(), id, ...from);
    return r.changes === 1;
  }

  /** Show a card asking for the change. Changes nothing. */
  propose(a: SystemAction): ActionItem {
    const clean: SystemAction =
      a.action === 'wifi_off' || a.action === 'device' || a.action === 'build_app'
        ? a
        : a.action === 'wifi_connect'
          ? { ...a, network: cleanName(a.network) }
          : { ...a, name: cleanName(a.name) };
    const id = this.newId();
    const spec = JSON.stringify(clean);
    const hash = createHash('sha256').update(`${id}\n${spec}`).digest('hex');
    const { title, confirm } = card(clean);
    const now = this.clock();
    this.db
      .prepare(`INSERT INTO system_actions (id, spec, title, confirm, hash, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, spec, title, confirm, hash, now, now);
    this.o.audit.append({ kind: 'system', event: 'action_proposed', actionId: id, ...auditable(clean) });
    const item = this.item(this.row(id)!);
    this.o.show(item, true);
    return item;
  }

  /** The confirm click. Runs only a pending action whose hash matches what the card showed. */
  async confirm(id: string, shownHash: string): Promise<ConfirmResult> {
    const r = this.row(id);
    const spec = r ? (JSON.parse(r.spec) as SystemAction) : null;
    const audit = (entry: Record<string, unknown>) =>
      this.o.audit.append({
        kind: 'tool',
        tool: spec?.action === 'device' ? spec.tool : (spec?.action ?? 'unknown'),
        tier: spec?.action === 'device' ? 'device' : 'write',
        actionId: id,
        via: 'click',
        ...entry,
      });
    if (!r || !spec) {
      audit({ decision: 'denied', reason: 'unknown action' });
      return 'refused';
    }
    if (r.hash !== shownHash) {
      audit({ decision: 'denied', reason: 'hash does not match the card' });
      this.refresh(id);
      return 'refused';
    }
    if (this.o.isPaused?.()) {
      audit({ decision: 'denied', reason: 'paused' });
      this.o.notice('info', 'I am paused, so I changed nothing. Type /resume, then click again.');
      return 'refused';
    }
    if (!this.transition(id, ['pending'], 'running')) {
      audit({ decision: 'denied', reason: `action is ${r.state}` });
      return 'refused';
    }
    audit({ decision: 'approved', ...auditable(spec) });
    this.refresh(id);
    try {
      const { result, old, now, extra } = await this.run(spec);
      this.transition(id, ['running'], 'done', result);
      audit({ decision: 'approved', ok: true, old, new: now, ...extra });
      this.refresh(id);
      return 'done';
    } catch (err) {
      const why = describeSystemError(err);
      this.transition(id, ['running'], 'failed', `Didn't work: ${why}.`);
      audit({ decision: 'approved', ok: false, error: why });
      this.refresh(id);
      return 'failed';
    }
  }

  cancel(id: string): boolean {
    if (!this.transition(id, ['pending'], 'cancelled')) return false;
    this.o.audit.append({ kind: 'system', event: 'action_cancelled', actionId: id });
    this.refresh(id);
    return true;
  }

  /** At startup: an action left running by a crash is shown as unknown, never re-run. */
  recover(): void {
    const stuck = this.db.prepare("SELECT id FROM system_actions WHERE state = 'running'").all() as { id: string }[];
    for (const { id } of stuck) {
      this.transition(id, ['running'], 'failed', 'The app stopped while doing this. Check the setting before trying again.');
      this.refresh(id);
    }
  }

  private async run(a: SystemAction): Promise<{ result: string; old: unknown; now: unknown; extra?: Record<string, unknown> | undefined }> {
    const c = this.o.controls;
    switch (a.action) {
      case 'build_app': {
        if (!this.appBuilder) throw new Error('building apps is not set up');
        const r = await this.appBuilder(a);
        return { result: r.result, old: undefined, now: undefined, extra: r.audit };
      }
      case 'device': {
        if (!this.deviceRunner) throw new Error('device changes are not set up');
        const r = await this.deviceRunner(a.tool, a.args);
        if (r.content.startsWith('Error:')) throw new Error(r.content.slice(7).trim().replace(/\.$/, ''));
        return { result: r.content, old: r.audit?.old, now: r.audit?.new };
      }
      case 'wifi_off': {
        const old = await c.wifi();
        const now = await c.setWifiRadio(false);
        if (now.radio) throw new SystemCommandError('failed', 'nmcli', 'Wi-Fi is still on');
        return { result: 'Wi-Fi is off. Ask me to turn it back on any time.', old, now };
      }
      case 'wifi_connect': {
        const old = await c.wifi();
        // nmcli exits non-zero when the connection does not come up, so getting here means it did.
        const now = await c.connectSaved(a.network);
        return { result: `Connected to ${q(a.network)}.`, old, now };
      }
      case 'bluetooth_pair':
      case 'bluetooth_forget': {
        const pair = a.action === 'bluetooth_pair';
        const all = await c.bluetoothDevices();
        const d: BtDevice | undefined = all.find((x) => x.address === a.address);
        if (!d) throw new SystemCommandError('refused', 'bluetoothctl', `${a.name} is no longer in the device list`);
        if (pair === d.paired) return { result: pair ? `${q(d.name)} was already paired.` : `${q(d.name)} was already forgotten.`, old: d, now: d };
        const now = await c.bluetoothDevice(pair ? 'pair' : 'forget', d);
        if (pair && !now?.paired) throw new SystemCommandError('failed', 'bluetoothctl', 'it did not pair. Check that it is in pairing mode and close by');
        if (!pair && now?.paired) throw new SystemCommandError('failed', 'bluetoothctl', 'it is still paired');
        return { result: pair ? `Paired with ${q(d.name)}${now?.connected ? ' and connected' : ''}.` : `Forgot ${q(d.name)}.`, old: d, now };
      }
    }
  }
}
