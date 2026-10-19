import { z } from 'zod';

/** Risk tiers are enforced by the approval broker (A5), not by prompts. */
export type RiskTier = 'read' | 'draft' | 'write';

export interface ToolDefinition<I extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  tier: RiskTier;
  input: I;
}

const def = <I extends z.ZodType>(d: ToolDefinition<I>) => d;

/** Alpha tool set (plan §4). Handlers arrive with their milestones; A1 only needs the shapes. */
export const ALPHA_TOOLS = [
  def({
    name: 'mail_search',
    tier: 'read',
    description: 'Search the mailbox. Returns snippets with stable message ids.',
    input: z.strictObject({
      query: z.string().describe('Free text matched against sender, subject and body'),
      since: z.string().optional().describe('ISO date (YYYY-MM-DD); only messages on or after it'),
      limit: z.int().min(1).max(50).optional(),
    }),
  }),
  def({
    name: 'mail_read',
    tier: 'read',
    description: 'Read one message: headers, plain-text body and attachment names.',
    input: z.strictObject({ id: z.string() }),
  }),
  def({
    name: 'mail_thread',
    tier: 'read',
    description: 'Read the whole thread a message belongs to.',
    input: z.strictObject({ id: z.string() }),
  }),
  def({
    name: 'mail_create_draft',
    tier: 'draft',
    description: 'Save a draft to the Drafts folder and show it to the user. Never sends.',
    input: z.strictObject({
      inReplyTo: z.string().optional().describe('Message id being replied to'),
      to: z.array(z.email()).min(1),
      subject: z.string(),
      body: z.string(),
    }),
  }),
  def({
    name: 'mail_send_draft',
    tier: 'write',
    description: 'Send a saved draft. Blocked until the user clicks Send on the draft card.',
    input: z.strictObject({ draftId: z.string() }),
  }),
  def({
    name: 'memory_propose',
    tier: 'draft',
    description:
      'Suggest something to remember long term: a fact (default) or a line for the user profile (standing instructions, preferences). The user sees a card and it is saved only if they click Save.',
    input: z.strictObject({
      fact: z.string().min(1).max(300),
      target: z.enum(['facts', 'profile']).optional().describe('"profile" for standing instructions and preferences; default "facts"'),
    }),
  }),
  def({
    name: 'open_app',
    tier: 'write',
    description: 'Open an allowlisted app (alpha: browser only). Requires approval.',
    input: z.strictObject({ name: z.enum(['browser']), url: z.url().optional() }),
  }),
  def({
    name: 'now',
    tier: 'read',
    description: 'Current date, time and timezone.',
    input: z.strictObject({}),
  }),
] as const;

export type AlphaToolName = (typeof ALPHA_TOOLS)[number]['name'];

export function toolByName(name: string): ToolDefinition | undefined {
  return ALPHA_TOOLS.find((t) => t.name === name);
}

/** Tool definitions in the shape the model adapter sends. */
export function toolSpecs(tools: readonly ToolDefinition[] = ALPHA_TOOLS): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return tools.map((t) => {
    const { $schema: _drop, ...parameters } = z.toJSONSchema(t.input, { target: 'draft-7' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
}
