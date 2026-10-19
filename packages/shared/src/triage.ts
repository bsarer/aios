import { z } from 'zod';

/** Structured output of the triage worker, one entry per new message (plan §5). */
export const TriageItem = z.strictObject({
  id: z.string().min(1),
  urgency: z.enum(['low', 'normal', 'high']),
  summary: z.string().min(1).max(400),
  needs_reply: z.boolean(),
  suggested_action: z.enum(['read', 'reply', 'ignore', 'archive', 'schedule', 'pay', 'review']),
  category: z.enum(['work', 'personal', 'finance', 'notification', 'newsletter', 'promotion', 'security', 'other']),
});
export type TriageItem = z.infer<typeof TriageItem>;

export const TriageBatch = z.strictObject({ items: z.array(TriageItem) });
export type TriageBatch = z.infer<typeof TriageBatch>;
