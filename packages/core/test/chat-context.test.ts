/**
 * The chat's token budget never drops what the model is still working from, and an earlier
 * knowledge base or email read is folded into its note before the budget is counted, so a
 * long result can't push the user's earlier question out of view.
 *
 * Found in use: "who is Olga?" (a knowledge search) then "what did I email her?" got "Her who?",
 * and "is there somebody named Candy?" searched six times and gave up, because the 8000-token
 * budget dropped the search result each step.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent, MAX_ITERATIONS } from '../src/agent.js';
import { AuditLog } from '../src/audit.js';
import { MemoryFiles } from '../src/memory/files.js';
import { Memory, assembleContext, estimateTokens } from '../src/memory/memory.js';
import type { Delta, ModelRequest, ModelResult, ToolCall } from '../src/model.js';
import { chatSystemPrompt } from '../src/prompts.js';
import { Store } from '../src/store.js';
import { toolByName } from '../src/tools/definitions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { sanitize, wrapUntrusted } from '../src/untrusted.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aios-ctx-'));
const done = (r: Partial<ModelResult>): ModelResult => ({ content: '', toolCalls: [], finishReason: null, usage: null, model: null, provider: null, generationId: null, latencyMs: 0, ttftMs: null, attempts: 1, ...r });
const search = (id: string, query: string): ToolCall => ({ id, name: 'knowledge_search', arguments: JSON.stringify({ query }) });

/** A knowledge_search result as long as the real one can be (14,000 characters of page text). */
const bigResult = (name: string) => `Knowledge base results for "${name}" (1 pages).\n${wrapUntrusted('knowledge', 'search', sanitize({ text: `# ${name}\n${'- emailed about lab results (unconfirmed)\n'.repeat(330)}` }, { maxChars: 14_000 }))}`;

function rig(script: ((req: ModelRequest) => ModelResult)[]) {
  const store = new Store(':memory:');
  const audit = new AuditLog(join(tmp(), 'audit.jsonl'));
  const tools = new ToolRegistry(audit).register({
    def: toolByName('knowledge_search')!,
    label: 'Looking in your knowledge base…',
    untrustedOutput: true,
    handler: async (args) => bigResult((args as { query: string }).query),
  });
  // As in use: 8000 tokens, about 5,300 of them the full system prompt, left ~2,500 for the
  // conversation. This registry has one tool, so its prompt is shorter: keep the same room.
  const room = estimateTokens(chatSystemPrompt({ userName: 'John', now: 'now', knowledgeSearch: true })) + 2_500;
  const memory = new Memory(new MemoryFiles(tmp(), 'John'), store, room);
  const requests: ModelRequest[] = [];
  const model = {
    async *stream(req: ModelRequest): AsyncGenerator<Delta, ModelResult> {
      requests.push(req);
      const next = script[requests.length - 1];
      const result = next ? next(req) : done({ content: '(no script)' });
      if (result.content) yield { type: 'text', text: result.content };
      yield { type: 'done', result };
      return result;
    },
  };
  const agent = new Agent({ model, tools, store, memory, userName: 'John', timeZone: 'UTC', emit: () => undefined });
  return { agent, requests, store };
}

describe('the chat context budget', () => {
  it('a long search result stays in view for the next step, so the model answers instead of searching again', async () => {
    const r = rig([
      () => done({ toolCalls: [search('c1', 'Candy')] }),
      // The pretend model searches again whenever it can't see a result, as Haiku did.
      (req) => (req.messages.some((m) => m.role === 'tool') ? done({ content: 'Yes, Candy is in your notes.' }) : done({ toolCalls: [search('c2', 'Candy')] })),
    ]);
    await r.agent.run('is there somebody named Candy in my knowledge base', new AbortController().signal);
    // (Model-side expects would be swallowed by the agent's error handling, so check afterwards.)
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]!.messages.some((m) => m.role === 'tool' && m.name === 'knowledge_search')).toBe(true);
    expect(r.store.recentItems().some((i) => i.kind === 'notice' && i.text.includes(`${MAX_ITERATIONS} steps`))).toBe(false);
  });

  it('after a knowledge search, the follow-up still sees the earlier question, with a knowledge note in place of the result', async () => {
    const r = rig([
      () => done({ toolCalls: [search('o1', 'Olga')] }),
      () => done({ content: 'Olga Kozel is someone you emailed on 17 Nov.' }),
      () => done({ content: 'Looking.' }),
    ]);
    await r.agent.run('who is Olga?', new AbortController().signal);
    await r.agent.run('what did I email her?', new AbortController().signal);
    expect(r.requests).toHaveLength(3);
    const text = r.requests[2]!.messages.map((m) => m.content ?? '');
    expect(text).toContain('who is Olga?');
    expect(text.at(-1)).toBe('what did I email her?');
    const note = text.find((c) => c.startsWith('(Answering this, I looked in the knowledge base.'));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/I read (an )?email/);
    // The earlier result and the answer written from it stay out of view, as before.
    expect(text.some((c) => c.includes('<untrusted source='))).toBe(false);
    expect(text.some((c) => c.includes('Olga Kozel'))).toBe(false);
  });

  it('keeps the whole request being answered even past the budget, and drops older turns first', () => {
    const system = chatSystemPrompt({ userName: 'John', now: 'now', knowledge: true, knowledgeSearch: true });
    const turns = [
      { role: 'user' as const, content: 'older question' },
      { role: 'assistant' as const, content: 'older answer' },
      { role: 'user' as const, content: 'is there somebody named Candy' },
      { role: 'assistant' as const, content: null, toolCalls: [search('c1', 'Candy')] },
      { role: 'tool' as const, toolCallId: 'c1', name: 'knowledge_search', content: bigResult('Candy') },
      { role: 'assistant' as const, content: null, toolCalls: [search('c2', 'Candice')] },
      { role: 'tool' as const, toolCallId: 'c2', name: 'knowledge_search', content: bigResult('Candice') },
    ];
    const msgs = assembleContext({ system, profile: '', recalled: [], turns, budgetTokens: 8000 });
    expect(msgs.slice(1)).toEqual(turns.slice(2));
  });

  it('the default budget leaves room for a few long results and earlier turns', async () => {
    const { AiosConfig } = await import('@aios/shared');
    expect(AiosConfig.shape.memory.parse(undefined).contextTokens).toBe(32_000);
  });
});

describe('email ids from earlier notes', () => {
  // Found in use: "who is Olga?" was answered with an unrelated email's id (a Chromium bug notice)
  // taken from an older note, and "show me the attachment" then opened it.
  it('a note says its id is only for the question above it', async () => {
    const { quarantineNote } = await import('../src/agent.js');
    for (const note of [quarantineNote(['INBOX:179310']), quarantineNote(['INBOX:1'], true), quarantineNote(['INBOX:1'], false, true)]) {
      expect(note).toContain('only for the question just above; for a different person or subject, search again instead of reusing it.');
    }
    expect(quarantineNote([])).not.toContain('only for the question');
  });

  it('the chat rules say to find a person\'s email by searching, and to say so when the opened one is about something else', () => {
    const p = chatSystemPrompt({ userName: 'John', now: 'now' });
    expect(p).toContain('An id in a note belongs only to the question just above that note');
    expect(p).toMatch(/only call an email theirs if its From or To shows them/);
    expect(p).toMatch(/if the email you opened is about something else, say so and search/);
  });

  it('mail search puts emails to or from the name above ones that only mention it', async () => {
    const { rankSearch } = await import('../src/mail/imap.js');
    const at = (d: string) => new Date(`2026-11-${d}T12:00:00Z`);
    const found = [
      { id: 'INBOX:179310', date: at('23') }, // a bug notice whose text has "olga" in it somewhere
      { id: 'Sent:812', date: at('17') }, // to Olga Kozel
      { id: 'INBOX:179001', date: at('20') },
      { id: 'Sent:640', date: at('01') }, // to Olga Kozel
    ];
    expect(rankSearch(found, new Set(['Sent:812', 'Sent:640']), 3).map((m) => m.id)).toEqual(['Sent:812', 'Sent:640', 'INBOX:179310']);
  });
});
