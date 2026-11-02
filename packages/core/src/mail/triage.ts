/**
 * Triage worker (plan §5): classifies new mail with one structured call per batch.
 * It has no tools, by construction: the request it builds has no `tools` field and
 * the model client it gets can only make structured calls.
 */
import { TriageBatch, type TriageItem } from '@aios/shared';
import type { ModelRole } from '@aios/shared';
import type { ModelClient, ModelRequest } from '../model.js';
import { TRIAGE_SYSTEM_PROMPT } from '../prompts.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import type { MailEvent } from './state.js';

export type TriageModel = Pick<ModelClient, 'structured'>;

/** `role` is 'triage', or 'local' when assistant.localTasks lists mailTriage (L1). */
export function triageRequest(events: MailEvent[], role: ModelRole = 'triage'): ModelRequest {
  const blocks = events.map((e) =>
    wrapUntrusted(
      'email',
      e.mailId,
      sanitize({ text: `From: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date ? new Date(e.date).toISOString() : 'unknown'}\n\n${e.body}` }, { maxChars: 2600 }),
    ),
  );
  return {
    role,
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
      { role: 'user', content: `Triage these ${events.length} new message(s). Use each id exactly as given.\n\n${blocks.join('\n\n')}` },
    ],
  };
}

/** One TriageItem per event, in order. Items the model skipped or invented are replaced or dropped. */
export async function triage(model: TriageModel, events: MailEvent[], role: ModelRole = 'triage'): Promise<TriageItem[]> {
  const { value } = await model.structured(triageRequest(events, role), 'triage', TriageBatch);
  const byId = new Map(value.items.map((i) => [i.id, i]));
  return events.map((e) => byId.get(e.mailId) ?? fallbackItem(e));
}

/** Used when the model skipped a message or triage keeps failing. */
export function fallbackItem(e: MailEvent): TriageItem {
  return {
    id: e.mailId,
    urgency: 'normal',
    summary: `New email: ${e.subject.slice(0, 120) || '(no subject)'}`,
    needs_reply: false,
    suggested_action: 'read',
    category: 'other',
  };
}
