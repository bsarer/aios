/**
 * The core shell: owns the agent, pause state, status and the set of connected UIs.
 * Transport-agnostic; server.ts wires it to WebSockets.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChatItem, type ClientMessage, type ServerEvent, type Status, type Theme } from '@aios/shared';
import { Agent } from './agent.js';
import type { AuditLog } from './audit.js';
import { HELP_TEXT, parseCommand } from './commands.js';
import { type FileIndexer, indexStatusText } from './files/indexer.js';
import { cleanFact } from './memory/files.js';
import type { CalendarActions } from './calendar/actions.js';
import type { DocActions } from './docs/actions.js';
import type { FileActions } from './files/actions.js';
import type { AttachmentFiles } from './mail/attachments.js';
import type { DocumentFiles } from './docs/viewer.js';
import type { ApprovalBroker } from './mail/approvals.js';
import type { Memory } from './memory/memory.js';
import { localDate } from './memory/nightly.js';
import { memoryProposeTool } from './memory/tool.js';
import type { ModelClient } from './model.js';
import { type Store, startOfDay } from './store.js';
import type { Battery, Wifi } from './status/system.js';
import type { SystemActions } from './system/actions.js';
import type { ToolRegistry } from './tools/registry.js';
import { WIDGET_TITLES, type WidgetBoard, widgetByName } from './widgets/widgets.js';
import { isWarm, type Personality, TONE_LINES, TONE_NAMES, toneByName } from './personality.js';

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
  /** Calendar change cards and their clicks (C1). Without it, event messages are ignored. */
  calendarActions?: CalendarActions;
  /** Word and Excel change cards and their clicks (D2). Without it, doc_change messages are ignored. */
  docActions?: DocActions;
  /** File change cards and their clicks (F1). Without it, file_change messages are ignored. */
  fileActions?: FileActions;
  /** The file index (F2). Without it, /reindex says file search is off. */
  fileIndex?: Pick<FileIndexer, 'reindex' | 'status'>;
  /** Save buttons on attachment cards (F1). Without it, attachment_save is ignored. */
  attachments?: Pick<AttachmentFiles, 'save'>;
  /** D3: Edit on a document card. Without it, document_edit is ignored. */
  documents?: Pick<DocumentFiles, 'edit'>;
  /** S7: where apps open now, for the status strip's hint. Without it, the hint is left out. */
  chatWindow?: { readonly appsAt: 'screen' | 'workspace' | null };
  /** V2: the microphone button is on, with this longest recording. Without it, the button stays off. */
  voice?: { maxSeconds: number };
  /** Open on a finished build's message (S4): opens the app that Build card built. */
  openBuiltApp?: (actionId: string) => Promise<void>;
  /** L1: the morning review's buttons and /checkup. Without it, cleanup clicks are ignored and /checkup says the assistant is off. */
  cleanup?: { act: (id: string, list: 'file' | 'app', n: number, action: 'trash' | 'close' | 'keep', hash: string) => Promise<void>; run: () => Promise<'nothing' | 'posted'> };
  /** T1: to-do cards' buttons. Without it, todo_action messages are ignored. */
  todos?: { act: (id: string, todoId: string, action: 'done' | 'reopen' | 'remove' | 'snooze', hash: string) => void; listCard?: () => unknown };
  /** W1: tiles along the bottom of the chat screen. Without it, there are none and /pin says they are off. */
  widgets?: Pick<WidgetBoard, 'current' | 'refresh' | 'setPinned' | 'pinned'>;
  /** T2: the morning brief, checked whenever AI OS is in use, and /brief. Without it, /brief says it is off. */
  brief?: { runIfDue: () => Promise<unknown>; run: () => Promise<unknown> };
  /** V1: /play. Picks the video from the user's words; the play itself goes through the registry's video_play. */
  video?: { pick: (text: string) => Promise<{ args: { path: string } | { url: string } } | { error: string }> };
  /** K1: /knowledge shows the knowledge base and /knowledge update updates it. Without it, /knowledge says it is off. */
  knowledge?: { view: () => string; run: () => Promise<{ by: 'model' | 'code'; error?: string } | null> };
  /** L1: the system numbers, written by code, for /checkup. */
  resources?: () => Promise<string[]>;
  /** Long-term memory (A3). Without it, /memory and friends say memory is off. */
  memory?: Memory;
  /** P1: the assistant's name and tone, and /tone. Without it, the chat is Astra, friendly, and /tone says so. */
  personality?: Pick<Personality, 'voice' | 'tone' | 'setTone'>;
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
    const personality = o.personality;
    this.agent = new Agent({
      model: o.model,
      tools: o.tools,
      store: o.store,
      userName: o.userName,
      timeZone: o.timeZone,
      emit: (ev) => this.broadcast(ev),
      clock: this.clock,
      ...(o.memory ? { memory: o.memory } : {}),
      ...(personality ? { voice: () => personality.voice() } : {}),
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
    l({ type: 'hello', userName: this.o.userName, items: this.o.store.recentItems(), status: this.status(), theme: this.theme, ...(this.o.widgets ? { widgets: this.o.widgets.current() } : {}) });
    void this.o.widgets?.refresh();
    // T2: a chat window opening counts as AI OS being in use.
    this.briefIfDue();
    return () => this.listeners.delete(l);
  }

  /** T2: posts today's brief if it is due; never in the way of anything else. */
  briefIfDue(): void {
    void this.o.brief?.runIfDue().catch((err: unknown) => this.o.audit.append({ kind: 'brief', event: 'error', error: (err as Error).message.slice(0, 200) }));
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
      ...(this.o.chatWindow?.appsAt ? { appsAt: this.o.chatWindow.appsAt } : {}),
      ...(this.o.voice ? { voice: { maxSeconds: this.o.voice.maxSeconds } } : {}),
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
    if (msg.type === 'event_confirm' || msg.type === 'event_discard') return this.calendarAction(msg);
    if (msg.type === 'doc_change_confirm' || msg.type === 'doc_change_discard') return this.docChangeAction(msg);
    if (msg.type === 'file_change_confirm' || msg.type === 'file_change_discard') return this.fileChangeAction(msg);
    // The user's own click on Save, so like Send on a draft it works while paused.
    if (msg.type === 'attachment_save') return void (await this.o.attachments?.save(msg.id, msg.folder));
    // D3: the user's own click on Edit; the card's file is checked again before its app opens. Works while paused.
    if (msg.type === 'document_edit') return this.o.documents?.edit(msg.id);
    // L1: the user's own click on a morning review row; the review checks its hash and the file or window first.
    if (msg.type === 'cleanup_action') return this.o.cleanup?.act(msg.id, msg.list, msg.n, msg.action, msg.hash);
    // T1: the user's own click on a to-do row; checked against its hash and the list first. Works while paused.
    if (msg.type === 'todo_action') return this.o.todos?.act(msg.id, msg.todoId, msg.action, msg.hash);
    if (msg.type === 'action_confirm' || msg.type === 'action_cancel' || msg.type === 'action_stop') return this.systemAction(msg);
    // W1: the user's own click on a tile, or on its pin buttons. Nothing else reaches setPinned.
    if (msg.type === 'widget_pin') {
      if (!this.o.widgets) return;
      this.o.widgets.setPinned(msg.widget, msg.pinned, 'click');
      return;
    }
    if (msg.type === 'widget_open') {
      this.o.audit.append({ kind: 'widgets', event: 'open', widget: msg.widget });
      return this.command({ name: msg.widget });
    }
    // The user's own click on a build they started, so it works while paused.
    if (msg.type === 'app_open') return this.o.openBuiltApp?.(msg.actionId);
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
    this.briefIfDue();
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
      else await broker.edit(msg.id, { to: msg.to, subject: msg.subject, body: msg.body, keep: msg.keep });
    } catch (err) {
      this.agent.notice('error', `I couldn't update the draft: ${(err as Error).message}`);
    }
  }

  /**
   * Clicks on a calendar card (C1). The user's own action, so like Send on a draft it works
   * while paused; the broker checks the card's hash and state before anything changes.
   */
  private async calendarAction(msg: Extract<ClientMessage, { type: 'event_confirm' | 'event_discard' }>): Promise<void> {
    const actions = this.o.calendarActions;
    if (!actions) return;
    if (msg.type === 'event_discard') {
      actions.discard(msg.id);
      return;
    }
    await actions.confirm(msg.id, msg.hash);
  }

  /**
   * Clicks on a document change card (D2). The user's own action, so it works while paused;
   * the broker checks the card's hash and state, and that the file is unchanged, first.
   */
  private async docChangeAction(msg: Extract<ClientMessage, { type: 'doc_change_confirm' | 'doc_change_discard' }>): Promise<void> {
    const actions = this.o.docActions;
    if (!actions) return;
    if (msg.type === 'doc_change_discard') {
      actions.discard(msg.id);
      return;
    }
    await actions.confirm(msg.id, msg.hash);
  }

  /** Clicks on a file change card (F1): the user's own action; the broker checks hash, state and the file. */
  private async fileChangeAction(msg: Extract<ClientMessage, { type: 'file_change_confirm' | 'file_change_discard' }>): Promise<void> {
    const actions = this.o.fileActions;
    if (!actions) return;
    if (msg.type === 'file_change_discard') {
      actions.discard(msg.id);
      return;
    }
    await actions.confirm(msg.id, msg.hash);
  }

  /**
   * Clicks on a system action card. The broker checks the hash and the state, and refuses
   * while paused, before anything changes.
   */
  private async systemAction(msg: Extract<ClientMessage, { type: 'action_confirm' | 'action_cancel' | 'action_stop' }>): Promise<void> {
    const actions = this.o.systemActions;
    if (!actions) return;
    if (msg.type === 'action_cancel') {
      actions.cancel(msg.id);
      return;
    }
    if (msg.type === 'action_stop') {
      actions.stop(msg.id);
      return;
    }
    await actions.confirm(msg.id, msg.hash, msg.choice);
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

  /** P1: the warmer wording for code-written lines under the friendly and playful tones. */
  private warm(friendly: string, plain: string): string {
    return isWarm(this.o.personality?.tone() ?? 'friendly') ? friendly : plain;
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
        say(this.warm("Taking a breather. I won't call the model or any tools until you type /resume.", 'Paused. I will not call the model or any tools until you type /resume.'));
        return this.pushStatus();
      case 'resume':
        this.o.store.setSetting('paused', '0');
        say(this.warm("I'm back.", 'Resumed.'));
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
      case 'reindex': {
        const idx = this.o.fileIndex;
        if (!idx) return say('File search is off. Turn it on with index = true under [files] in your config.');
        void idx.reindex();
        return say(`Reading your files again in the background. ${indexStatusText(idx.status())}`);
      }
      case 'checkup': {
        if (!this.o.resources && !this.o.cleanup) return say('The system assistant is off. Turn it on with enabled = true under [assistant] in your config.');
        const lines = (await this.o.resources?.()) ?? [];
        if (lines.length) say(lines.join('\n'));
        if (!this.o.cleanup) return;
        if (this.paused) return say('I am paused, so the tidy-up suggestions wait. Type /resume to continue.');
        const r = await this.o.cleanup.run();
        if (r === 'nothing') say(this.warm('All tidy! No big unused files in your folders and no idle windows right now.', 'Nothing to tidy up right now: no big unused files in your folders and no idle windows.'));
        return;
      }
      case 'brief': {
        if (!this.o.brief) return say('The morning brief is off. Turn it on with enabled = true under [brief] in your config.');
        if (this.paused) return say('I am paused, so the brief waits. Type /resume to continue.');
        await this.o.brief.run();
        return;
      }
      case 'play': {
        if (!this.o.video || !this.o.tools.has('video_play')) return say('Videos are off. Turn them on with enabled = true under [video] in your config.');
        const picked = await this.o.video.pick(cmd.text);
        if ('error' in picked) return say(picked.error);
        // The user's own typed command, so nothing untrusted is in view: audited and rate limited like any device change.
        const r = await this.o.tools.execute(
          { id: `play-${Date.now()}`, name: 'video_play', arguments: JSON.stringify(picked.args) },
          { signal: AbortSignal.timeout(30_000), untrustedInContext: false, userText: `/play ${cmd.text}` },
        );
        // Refusals (not a video, a bad link) come back as text starting with "Error:".
        if (!r.ok || r.content.startsWith('Error:')) return say(r.content.replace(/^Error: /, ''));
        return say('path' in picked.args ? `Playing ${picked.args.path.split('/').pop()} in mpv.` : 'Playing the link in mpv. It can take a few seconds to load.');
      }
      case 'todos': {
        if (!this.o.todos?.listCard) return say('To-dos are off. Turn them on with enabled = true under [todos] in your config.');
        this.o.todos.listCard();
        return;
      }
      case 'pin':
      case 'unpin': {
        const w = this.o.widgets;
        if (!w) return say('Widgets are off. Turn them on with enabled = true under [widgets] in your config.');
        const pinned = w.pinned();
        const all = Object.keys(WIDGET_TITLES) as (keyof typeof WIDGET_TITLES)[];
        if (!cmd.text.trim()) {
          const free = all.filter((k) => !pinned.includes(k));
          const now = pinned.length ? `Pinned now: ${pinned.join(', ')}.` : 'Nothing is pinned.';
          return say(cmd.name === 'pin' ? `${now} ${free.length ? `You can pin: ${free.join(', ')}. For example /pin ${free[0]}.` : 'Everything is pinned.'}` : `${now} For example /unpin ${pinned[0] ?? 'todos'}.`);
        }
        const widget = widgetByName(cmd.text);
        if (!widget) return say(`I can pin ${all.join(', ')}. For example /${cmd.name} todos.`);
        return say(w.setPinned(widget, cmd.name === 'pin', 'command'));
      }
      case 'knowledge': {
        const k = this.o.knowledge;
        if (!k) return say('The knowledge base is off. Turn it on with enabled = true under [knowledge] in your config.');
        if (!cmd.update) return say(k.view());
        if (this.paused) return say('I am paused, so the knowledge base waits. Type /resume to continue.');
        say('Updating your knowledge base. This can take a few minutes.');
        const r = await k.run();
        if (!r) return say('An update is already running; type /knowledge in a minute to see it.');
        if (r.error) say(`I couldn't reach the model this time (${r.error}), so I'll carry on at the next update. What was read so far is in the file.`);
        return say(k.view());
      }
      case 'tone': {
        const p = this.o.personality;
        const list = TONE_NAMES.map((t) => `- ${t}: ${TONE_LINES[t]}`).join('\n');
        if (!p) return say(`I'm friendly, and the tone can't be changed here.`);
        if (!cmd.text.trim()) return say(`My tone is ${p.tone()}. You can pick:\n${list}\nFor example /tone playful.`);
        const tone = toneByName(cmd.text);
        if (!tone) return say(`I know these tones:\n${list}\nFor example /tone playful.`);
        return say(p.setTone(tone));
      }
      case 'unknown':
        return say(`I don't know ${cmd.raw.split(/\s/)[0]}. Type /help for the list.`);
    }
  }
}
