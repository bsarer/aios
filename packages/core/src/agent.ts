/**
 * The chat agent loop (plan §4): build context → call model → validate and run tool
 * calls through the registry → repeat (max 6 iterations) → stream the final answer.
 * Every chat item it produces is persisted and emitted to connected UIs.
 */
import { randomUUID } from 'node:crypto';
import type { ChatItem, ServerEvent } from '@aios/shared';
import type { Memory } from './memory/memory.js';
import { type ChatMessage, type ModelClient, ModelError, type ModelResult } from './model.js';
import { chatSystemPrompt } from './prompts.js';
import type { Store } from './store.js';
import { formatNow } from './tools/now.js';
import type { ToolRegistry } from './tools/registry.js';

export const MAX_ITERATIONS = 6;
const CONTEXT_TURNS = 30;
/** With memory, the token budget trims the window; this only bounds the query. */
const CONTEXT_TURNS_BUDGETED = 120;

/** Marks content that came from an untrusted source (see untrusted.ts wrapUntrusted). */
const UNTRUSTED_MARK = /<untrusted source=/;

export interface AgentOptions {
  model: Pick<ModelClient, 'stream'>;
  tools: ToolRegistry;
  store: Store;
  userName: string;
  timeZone: string;
  emit: (ev: ServerEvent) => void;
  /** Profile, recalled facts and summaries, and a token-budgeted window (A3). */
  memory?: Memory;
  clock?: () => Date;
  newId?: () => string;
}

export class Agent {
  private readonly clock: () => Date;
  private readonly newId: () => string;

  constructor(private readonly o: AgentOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.newId = o.newId ?? (() => randomUUID());
  }

  /** Show and persist a chat item. */
  post(item: ChatItem): void {
    this.o.store.saveItem(item);
    this.o.emit({ type: 'item', item });
  }

  private patch(item: ChatItem): void {
    this.o.store.saveItem(item);
    this.o.emit({ type: 'patch', id: item.id, item });
  }

  notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.post({ kind: 'notice', id: this.newId(), level, text, at: this.clock().getTime() });
  }

  /** Handle one user message. Resolves when the turn is finished, stopped or failed. */
  async run(text: string, signal: AbortSignal): Promise<void> {
    const { store, tools, model } = this.o;
    const at = () => this.clock().getTime();
    this.post({ kind: 'user', id: this.newId(), text, at: at() });
    store.saveTurn({ role: 'user', content: text }, at());

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const system = chatSystemPrompt({ userName: this.o.userName, now: formatNow(this.clock(), this.o.timeZone) });
      const messages: ChatMessage[] = this.o.memory
        ? this.o.memory.context(system, text, store.recentTurns(CONTEXT_TURNS_BUDGETED))
        : [{ role: 'system', content: system }, ...store.recentTurns(CONTEXT_TURNS)];
      // Decided in code from what the model can see, so an email cannot talk its way out of it.
      const untrustedInContext = messages.some(
        (m) => (m.role === 'tool' && tools.returnsUntrusted(m.name)) || UNTRUSTED_MARK.test(m.content ?? ''),
      );

      let item: Extract<ChatItem, { kind: 'assistant' }> | null = null;
      let reply = '';
      let result: ModelResult | undefined;
      try {
        for await (const d of model.stream({ role: 'chat', messages, tools: tools.specs(), toolChoice: 'auto', signal })) {
          if (d.type === 'text') {
            if (!item) {
              item = { kind: 'assistant', id: this.newId(), text: '', at: at(), streaming: true };
              this.post(item);
            }
            reply += d.text;
            this.o.emit({ type: 'delta', id: item.id, text: d.text });
          } else if (d.type === 'done') {
            result = d.result;
          }
        }
      } catch (err) {
        const stopped = signal.aborted;
        if (item) this.patch({ ...item, text: reply, streaming: false, ...(stopped ? { stopped: true } : {}) });
        // Keep what was shown so the next turn's context matches the screen.
        if (reply) store.saveTurn({ role: 'assistant', content: reply }, at());
        if (!stopped) this.notice('error', err instanceof ModelError ? err.userMessage : 'Something went wrong talking to the model.');
        else if (!item) this.notice('info', 'Stopped.');
        return;
      }

      if (!result) return;
      if (item) this.patch({ ...item, text: result.content, streaming: false });
      store.saveTurn(
        { role: 'assistant', content: result.content || null, ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}) },
        at(),
      );
      if (!result.toolCalls.length) return;

      for (const call of result.toolCalls) {
        const toolItem: ChatItem = { kind: 'tool', id: this.newId(), label: tools.label(call.name), state: 'running', at: at() };
        this.post(toolItem);
        const outcome = await tools.execute(call, { signal, untrustedInContext });
        this.patch({ ...toolItem, state: outcome.ok ? 'done' : 'failed' });
        store.saveTurn({ role: 'tool', toolCallId: call.id, name: call.name, content: outcome.content }, at());
        if (signal.aborted) {
          this.notice('info', 'Stopped.');
          return;
        }
      }
    }
    this.notice('warning', `I stopped after ${MAX_ITERATIONS} steps without finishing. Try a more specific request.`);
  }
}
