/**
 * The core shell: owns the agent, pause state, status and the set of connected UIs.
 * Transport-agnostic; server.ts wires it to WebSockets.
 */
import { randomUUID } from 'node:crypto';
import { type ClientMessage, type ServerEvent, type Status, type Theme } from '@aios/shared';
import { Agent } from './agent.js';
import type { AuditLog } from './audit.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import type { ModelClient } from './model.js';
import { type Store, startOfDay } from './store.js';
import type { Battery, Wifi } from './status/system.js';
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
    });
  }

  get paused(): boolean {
    return this.o.store.getSetting('paused') === '1';
  }

  get busy(): boolean {
    return this.running !== null;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l({ type: 'hello', userName: this.o.userName, items: this.o.store.recentItems(), status: this.status(), theme: this.theme });
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
      mail: 'not_configured', // A4
      agent: this.paused ? 'paused' : this.busy ? 'working' : 'idle',
      costTodayUsd: this.o.store.usageSince(since).costUsd,
      costCapUsd: this.o.costCapUsd,
      model: this.o.modelName,
    };
  }

  pushStatus(): void {
    this.broadcast({ type: 'status', status: this.status() });
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
        return this.pushStatus();
      case 'cost': {
        const u = this.o.store.usageSince(startOfDay(this.clock().getTime(), this.o.timeZone));
        return say(`Today: $${u.costUsd.toFixed(4)} across ${u.calls} model calls (${u.tokens} tokens). Daily cap: $${this.o.costCapUsd.toFixed(2)}.`);
      }
      case 'memory':
      case 'forget':
        return say('Memory is not built yet. It arrives in the next milestone.');
      case 'unknown':
        return say(`I don't know ${cmd.raw.split(/\s/)[0]}. Type /help for the list.`);
    }
  }
}
