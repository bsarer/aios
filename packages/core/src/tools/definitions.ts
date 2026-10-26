import { z } from 'zod';

/**
 * Risk tiers are enforced in code (registry and approval brokers), not by prompts.
 * `device` (S1): small, reversible changes to this computer within fixed limits; never
 * offered or run while untrusted content is in context, and rate limited.
 */
export type RiskTier = 'read' | 'draft' | 'device' | 'write';

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
    description: 'Read one message: headers, plain-text body and a numbered list of its attachments.',
    input: z.strictObject({ id: z.string() }),
  }),
  def({
    name: 'mail_thread',
    tier: 'read',
    description: 'Read the whole thread a message belongs to.',
    input: z.strictObject({ id: z.string() }),
  }),
  def({
    name: 'mail_recent',
    tier: 'read',
    description:
      'The emails from recent new-mail notifications, newest first, with the priority triage gave each (high, normal, low), its category and summary. Use when the user refers to an email from a notification, e.g. "that low-priority email" or "the receipt that just came in".',
    input: z.strictObject({ limit: z.int().min(1).max(30).optional() }),
  }),
  def({
    name: 'mail_attachment_read',
    tier: 'read',
    description: 'Read the text of one attachment of a message (a PDF or text file), numbered as mail_read lists them. Images cannot be read.',
    input: z.strictObject({
      id: z.string().describe('Message id, e.g. INBOX:37'),
      attachment: z.int().min(1).max(50).describe('Attachment number from mail_read, starting at 1'),
    }),
  }),
  def({
    name: 'mail_attachment_show',
    tier: 'read',
    description: 'Show one attachment of a message (a PDF, text file or image) to the user as a card with an Open button, so they can look at it. Use when the user wants to open, see or view an attachment.',
    input: z.strictObject({
      id: z.string().describe('Message id, e.g. INBOX:37'),
      attachment: z.int().min(1).max(50).describe('Attachment number from mail_read, starting at 1'),
    }),
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
  // ── Apps (S3) ──
  def({
    name: 'apps_list',
    tier: 'read',
    description: 'Apps installed on this computer (from their desktop entries), with the id open_app takes. Give a query to narrow it, e.g. "browser" or "music".',
    input: z.strictObject({ query: z.string().max(100).optional().describe('Words matched against name, description, keywords and category') }),
  }),
  def({
    name: 'open_app',
    tier: 'device',
    description:
      'Start an installed app, by its id from apps_list or its exact name. It opens in its own window; the chat steps aside, with a red circle in the bar tray, and comes back when the app is closed. Apps start without files, links or options.',
    input: z.strictObject({ app: z.string().min(1).max(200).describe('App id from apps_list, e.g. "firefox", or its exact name') }),
  }),
  // ── System controls (S1) ──
  def({
    name: 'system_status',
    tier: 'read',
    description:
      'Current state of this computer: Wi-Fi, Bluetooth, volume, audio output, microphone, brightness, night light, do not disturb, power profile, battery, CPU and memory, theme.',
    input: z.strictObject({}),
  }),
  def({
    name: 'wifi_networks',
    tier: 'read',
    description: 'Saved Wi-Fi networks and whether each is in range. New networks are joined in Omarchy\'s Network panel (Super+Ctrl+N), not here.',
    input: z.strictObject({}),
  }),
  def({
    name: 'bluetooth_devices',
    tier: 'read',
    description: 'Paired Bluetooth devices and which are connected.',
    input: z.strictObject({}),
  }),
  def({
    name: 'audio_outputs',
    tier: 'read',
    description: 'Audio outputs (speakers, headphones, HDMI) and which one is in use.',
    input: z.strictObject({}),
  }),
  def({
    name: 'theme_list',
    tier: 'read',
    description: 'Installed Omarchy themes and the current one.',
    input: z.strictObject({}),
  }),
  def({
    name: 'volume_set',
    tier: 'device',
    description: 'Set the output volume (0-100%) and/or mute or unmute. Setting a level also unmutes.',
    input: z
      .strictObject({ percent: z.int().min(0).max(100).optional(), muted: z.boolean().optional() })
      .refine((a) => a.percent !== undefined || a.muted !== undefined, 'give percent or muted'),
  }),
  def({
    name: 'brightness_set',
    tier: 'device',
    description: 'Set the brightness of the focused display (5-100%).',
    input: z.strictObject({ percent: z.int().min(5).max(100) }),
  }),
  def({
    name: 'wifi_on',
    tier: 'device',
    description: 'Turn Wi-Fi on. (Turning it off is wifi_off, which needs the user to confirm.)',
    input: z.strictObject({}),
  }),
  def({
    name: 'wifi_off',
    tier: 'write',
    description: 'Ask to turn Wi-Fi off. Shows a card; nothing changes until the user clicks Turn off.',
    input: z.strictObject({}),
  }),
  def({
    name: 'wifi_connect',
    tier: 'write',
    description: 'Ask to switch to a saved Wi-Fi network (from wifi_networks). Shows a card; nothing changes until the user clicks Connect.',
    input: z.strictObject({ network: z.string().min(1).max(64) }),
  }),
  def({
    name: 'bluetooth_power',
    tier: 'device',
    description: 'Turn Bluetooth on or off.',
    input: z.strictObject({ on: z.boolean() }),
  }),
  def({
    name: 'bluetooth_connection',
    tier: 'device',
    description: 'Connect or disconnect a paired Bluetooth device, by its name or address from bluetooth_devices.',
    input: z.strictObject({ device: z.string().min(1).max(64), action: z.enum(['connect', 'disconnect']) }),
  }),
  def({
    name: 'bluetooth_scan',
    tier: 'device',
    description:
      'Look for new Bluetooth devices nearby for a few seconds and show each one to the user on a card with a Pair button. You do not see their names; the user picks.',
    input: z.strictObject({}),
  }),
  def({
    name: 'bluetooth_forget',
    tier: 'write',
    description: 'Ask to forget (unpair) a paired Bluetooth device. Shows a card; nothing changes until the user clicks Forget.',
    input: z.strictObject({ device: z.string().min(1).max(64) }),
  }),
  def({
    name: 'night_light',
    tier: 'device',
    description: 'Turn night light (warmer screen colours) on or off.',
    input: z.strictObject({ on: z.boolean() }),
  }),
  def({
    name: 'do_not_disturb',
    tier: 'device',
    description: 'Turn do not disturb (silenced desktop notifications) on or off.',
    input: z.strictObject({ on: z.boolean() }),
  }),
  def({
    name: 'audio_output_set',
    tier: 'device',
    description: 'Switch sound to another output, by its description from audio_outputs.',
    input: z.strictObject({ output: z.string().min(1).max(128) }),
  }),
  def({
    name: 'microphone_mute',
    tier: 'device',
    description: 'Mute or unmute the microphone.',
    input: z.strictObject({ muted: z.boolean() }),
  }),
  def({
    name: 'power_profile_set',
    tier: 'device',
    description: 'Set the power profile.',
    input: z.strictObject({ profile: z.enum(['power-saver', 'balanced', 'performance']) }),
  }),
  def({
    name: 'screen_lock',
    tier: 'device',
    description: 'Lock the screen now.',
    input: z.strictObject({}),
  }),
  def({
    name: 'theme_set',
    tier: 'device',
    description: 'Switch to another installed Omarchy theme, by its name from theme_list.',
    input: z.strictObject({ name: z.string().min(1).max(64) }),
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
