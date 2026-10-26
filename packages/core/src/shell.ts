/**
 * The core shell: owns the agent, pause state, status and the set of connected UIs.
 * Transport-agnostic; server.ts wires it to WebSockets.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChatItem, type ClientMessage, type ServerEvent, type Status, type Theme, type WindowMode } from '@aios/shared';
import { Agent } from './agent.js';
import type { AuditLog } from './audit.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import { cleanFact } from './memory/files.js';
import type { ApprovalBroker } from './mail/approvals.js';
import type { Memory } from './memory/memory.js';
import { localDate } from './memory/nightly.js';
import { memoryProposeTool } from './memory/tool.js';
import type { ModelClient } from './model.js';
import { type Store, startOfDay } from './store.js';
import type { Battery, Wifi } from './status/system.js';
import type { SystemActions } from './system/actions.js';
import type { ToolRegistry } from './tools/registry.js';

export interface ShellOptions {
  store: Store;
  model: Pick<ModelClient, 'stream'>;
  tools: ToolRegistry;
  audit: AuditLog;
  userName: string;
  timeZone: string;
  modelName: string;
  costCapUsd: number;
  readBattery: () => Promise<Battery | null>;
  readWifi: () => Promise<Wifi | null>;
  theme?: Theme;
  /** Called after /resume, so queued work (mail triage) can catch up. */
  onResume?: () => void;
  /** Called when the user clicks Ignore on a mail in a notification. */
  onIgnoreMail?: (mailId: string) => void;
  /** Draft cards and the Send click (A5). Without it, draft messages are ignored. */
  approvals?: ApprovalBroker;
  /** Cards for system changes that need a click (S1). Without it, action messages are ignored. */
  systemActions?: SystemActions;
  /** Where the chat window sits (S3). Without it, window messages are ignored and the chat stays full screen. */
  chatWindow?: { readonly mode: WindowMode; request: (mode: WindowMode) => Promise<void> };
  /** Long-term memory (A3). Without it, /memory and friends say memory is off. */
  memory?: Memory;
  /** Where /export writes. Default: the memory folder. */
  exportDir?: string;
  clock?: () => Date;
}

type Listener = (ev: ServerEvent) => void;

export class Shell {
  readonly agent: Agent;
  private readonly listeners = new Set<Listener>();
  private running: AbortController | null = null;
  private battery: Battery | null = null;
  private wifi: Wifi | null = null;
  private theme: Theme;
  private mail: Status['mail'] = 'not_configured';
  private readonly clock: () => Date;

  constructor(private readonly o: ShellOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.theme = o.theme ?? {};
    this.agent = new Agent({
      model: o.model,
      tools: o.tools,
      store: o.store,
      userName: o.userName,
      timeZone: o.timeZone,
      emit: (ev) => this.broadcast(ev),
      clock: this.clock,
      ...(o.memory ? { memory: o.memory } : {}),
    });
    if (o.memory) o.tools.register(memoryProposeTool({ memory: o.memory, post: (item) => this.agent.post(item), clock: this.clock }));
  }

  get paused(): boolean {
    return this.o.store.getSetting('paused') === '1';
  }

  get busy(): boolean {
    return this.running !== null;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l({ type: 'hello', userName: this.o.userName, items: this.o.store.recentItems(), status: this.status(), theme: this.theme, window: this.o.chatWindow?.mode ?? 'full' });
    return () => this.listeners.delete(l);
  }

  broadcast(ev: ServerEvent): void {
    for (const l of this.listeners) l(ev);
  }

  status(): Status {
    const since = startOfDay(this.clock().getTime(), this.o.timeZone);
    return {
      battery: this.battery,
      wifi: this.wifi,
      mail: this.mail,
      agent: this.paused ? 'paused' : this.busy ? 'working' : 'idle',
      costTodayUsd: this.o.store.usageSince(since).costUsd,
      costCapUsd: this.o.costCapUsd,
      model: this.o.modelName,
    };
  }

  pushStatus(): void {
    this.broadcast({ type: 'status', status: this.status() });
  }

  /** Save and re-render an existing chat item. */
  patchItem(item: ChatItem): void {
    this.o.store.saveItem(item);
    this.broadcast({ type: 'patch', id: item.id, item });
  }

  setMailStatus(mail: Status['mail']): void {
    if (mail === this.mail) return;
    this.mail = mail;
    this.pushStatus();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.broadcast({ type: 'theme', theme });
  }

  async refreshSystemStatus(): Promise<void> {
    [this.battery, this.wifi] = await Promise.all([this.o.readBattery(), this.o.readWifi()]);
    this.pushStatus();
  }

  /** Time-aware greeting shown when the daemon starts. The mail catch-up joins it in A4. */
  greet(): void {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.o.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(this.clock()));
    const part = hour < 5 ? 'Hello' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
    this.agent.post({
      kind: 'assistant',
      id: randomUUID(),
      text: `${part}, ${this.o.userName}. What can I do for you?`,
      at: this.clock().getTime(),
      streaming: false,
    });
  }

  /** Handle a validated client message. Returns when any resulting work is finished. */
  async handle(msg: ClientMessage): Promise<void> {
    if (msg.type === 'stop') {
      this.running?.abort();
      return;
    }
    if (msg.type === 'memory') return this.decideMemory(msg.id, msg.decision);
    if (msg.type === 'mail_ignore') return this.ignoreMail(msg.itemId, msg.mailId);
    if (msg.type === 'draft_send' || msg.type === 'draft_edit' || msg.type === 'draft_discard') return this.draftAction(msg);
    if (msg.type === 'action_confirm' || msg.type === 'action_cancel') return this.systemAction(msg);
    // The user's own click, so it works while paused; it only moves the chat window.
    if (msg.type === 'window') return this.o.chatWindow?.request(msg.mode);
    const cmd = parseCommand(msg.text);
    if (cmd) return this.command(cmd);
    if (this.paused) {
      this.agent.notice('info', 'I am paused. Type /resume to continue.');
      return;
    }
    if (this.running) {
      this.agent.notice('info', 'Still working on the last request. Press Esc to stop it.');
      return;
    }
    const ac = new AbortController();
    this.running = ac;
    this.pushStatus();
    try {
      await this.agent.run(msg.text, ac.signal);
    } finally {
      this.running = null;
      this.pushStatus();
    }
  }

  /**
   * The only code path that writes long-term memory. Reached solely by a Save click on a
   * pending memory card (a UI message); nothing the model or a tool returns can call it.
   */
  private decideMemory(id: string, decision: 'save' | 'skip'): void {
    const memory = this.o.memory;
    const item = this.o.store.getItem(id);
    if (!memory || item?.kind !== 'memory' || item.state !== 'pending') return;
    let text = item.text;
    if (decision === 'save') {
      text =
        item.target === 'profile'
          ? memory.files.addToProfile(item.text)
          : memory.files.addFact(item.text, localDate(this.clock().getTime(), this.o.timeZone), item.source);
      memory.reindex();
    }
    this.o.audit.append({ kind: 'memory', decision, target: item.target, source: item.source, itemId: id });
    const updated = { ...item, text, state: decision === 'save' ? 'saved' : 'skipped' } as const;
    this.o.store.saveItem(updated);
    this.broadcast({ type: 'patch', id, item: updated });
  }

  /**
   * Clicks on a draft card. These are the user's own actions, so they work while paused;
   * the broker checks the card's hash and the draft's state before anything is sent.
   */
  private async draftAction(msg: Extract<ClientMessage, { type: 'draft_send' | 'draft_edit' | 'draft_discard' }>): Promise<void> {
    const broker = this.o.approvals;
    if (!broker) return;
    try {
      if (msg.type === 'draft_send') await broker.approveSend(msg.id, msg.hash);
      else if (msg.type === 'draft_discard') await broker.discard(msg.id);
      else await broker.edit(msg.id, { to: msg.to, subject: msg.subject, body: msg.body });
    } catch (err) {
      this.agent.notice('error', `I couldn't update the draft: ${(err as Error).message}`);
    }
  }

  /**
   * Clicks on a system action card. The broker checks the hash and the state, and refuses
   * while paused, before anything changes.
   */
  private async systemAction(msg: Extract<ClientMessage, { type: 'action_confirm' | 'action_cancel' }>): Promise<void> {
    const actions = this.o.systemActions;
    if (!actions) return;
    if (msg.type === 'action_cancel') {
      actions.cancel(msg.id);
      return;
    }
    await actions.confirm(msg.id, msg.hash);
    // Wi-Fi changes show in the status strip straight away rather than at the next refresh.
    await this.refreshSystemStatus();
  }

  private ignoreMail(itemId: string, mailId: string): void {
    const item = this.o.store.getItem(itemId);
    if (item?.kind !== 'notification' || !item.mails?.some((m) => m.id === mailId)) return;
    const updated: ChatItem = { ...item, mails: item.mails.map((m) => (m.id === mailId ? { ...m, ignored: true } : m)) };
    this.o.store.saveItem(updated);
    this.broadcast({ type: 'patch', id: itemId, item: updated });
    this.o.onIgnoreMail?.(mailId);
  }

  private memoryCommand(
    cmd: { name: 'memory' } | { name: 'forget'; text: string } | { name: 'export' } | { name: 'remember'; text: string },
    say: (t: string) => void,
  ): void {
    const memory = this.o.memory;
    if (!memory) return say('Memory is turned off.');
    const f = memory.files;
    if (cmd.name === 'remember') {
      const text = cleanFact(cmd.text);
      if (!text) return say('Tell me what to remember, for example: /remember Sara prefers short emails');
      // Typed by the user, so it is chat-sourced; it still needs the Save click like any other card.
      this.agent.post({ kind: 'memory', id: randomUUID(), text, target: 'facts', source: 'chat', state: 'pending', at: this.clock().getTime() });
      return;
    }
    if (cmd.name === 'forget') {
      if (!cmd.text.trim()) return say('Tell me what to forget, for example: /forget Sara prefers short emails');
      const r = f.forget(cmd.text);
      if (r.removed) {
        memory.reindex();
        this.o.audit.append({ kind: 'memory', decision: 'forget' });
        return say(`Forgotten: ${r.removed}`);
      }
      if (r.candidates.length) return say(`Several facts match. Type more of the one you mean:\n${r.candidates.map((c) => `- ${c}`).join('\n')}`);
      return say(`I have no fact matching "${cmd.text.trim()}". Your profile is edited by hand: ${f.profilePath}`);
    }
    const facts = f.facts();
    const dates = f.summaryDates();
    const all = [
      `Profile (${f.profilePath}):`,
      f.profile().trim(),
      '',
      `Facts (${f.factsPath}):`,
      facts.length ? facts.map((x) => `- ${x.text}${x.source === 'email' ? ' (suggested while reading an email)' : ''}`).join('\n') : 'None yet.',
      '',
      `Daily summaries (${f.summariesDir}): ${dates.length ? `${dates.length}, latest ${dates.at(-1)}` : 'none yet'}`,
    ].join('\n');
    if (cmd.name === 'memory') return say(all);
    const dir = this.o.exportDir ?? f.dir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `memory-export-${localDate(this.clock().getTime(), this.o.timeZone)}.md`);
    const summaries = dates.map((d) => f.summary(d) ?? '').join('\n');
    writeFileSync(path, `# AI OS memory export\n\n${all}\n\n${summaries}`, { mode: 0o600 });
    this.o.audit.append({ kind: 'memory', decision: 'export' });
    return say(`Exported to ${path}`);
  }

  private async command(cmd: NonNullable<ReturnType<typeof parseCommand>>): Promise<void> {
    this.o.audit.append({ kind: 'command', command: cmd.name });
    const say = (text: string) => this.agent.notice('info', text);
    switch (cmd.name) {
      case 'help':
        return say(HELP_TEXT);
      case 'pause':
        this.o.store.setSetting('paused', '1');
        this.running?.abort();
        say('Paused. I will not call the model or any tools until you type /resume.');
        return this.pushStatus();
      case 'resume':
        this.o.store.setSetting('paused', '0');
        say('Resumed.');
        this.o.onResume?.();
        return this.pushStatus();
      case 'cost': {
        const u = this.o.store.usageSince(startOfDay(this.clock().getTime(), this.o.timeZone));
        const capped = u.costUsd >= this.o.costCapUsd ? " The cap is reached, so I won't call the model again until tomorrow. Raise cost.dailyCapUsd in your config to change it." : '';
        return say(`Today: $${u.costUsd.toFixed(4)} across ${u.calls} model calls (${u.tokens} tokens). Daily cap: $${this.o.costCapUsd.toFixed(2)}.${capped}`);
      }
      case 'memory':
      case 'forget':
      case 'export':
      case 'remember':
        return this.memoryCommand(cmd, say);
      case 'unknown':
        return say(`I don't know ${cmd.raw.split(/\s/)[0]}. Type /help for the list.`);
    }
  }
}
