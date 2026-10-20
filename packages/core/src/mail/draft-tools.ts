/**
 * mail_create_draft (draft tier) and mail_send_draft (write tier). Drafting saves to the
 * Drafts folder and shows a card; it never sends. mail_send_draft is registered so the
 * model gets a clear answer and the attempt is audited, but the registry refuses every
 * write-tier call: mail goes out only through ApprovalBroker.approveSend on a Send click.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext } from '../tools/registry.js';
import type { ApprovalBroker } from './approvals.js';
import type { FullMessage, MailClient } from './imap.js';

const norm = (a: string) => a.trim().toLowerCase();

/**
 * Recipients that came from neither the user's own message nor the email being replied
 * to, while email text was in the model's context: the shape of an injected "also send
 * this to attacker@…". Written by code; shown on the card.
 */
export function recipientWarnings(to: string[], ctx: Pick<ToolContext, 'untrustedInContext' | 'userText'>, original: FullMessage | null, self: string): string[] {
  if (!ctx.untrustedInContext) return [];
  const known = new Set(
    original ? [original.from, ...original.replyTo, ...original.to, ...original.cc].flatMap((a) => (a ? [norm(a.address)] : [])) : [],
  );
  known.add(norm(self));
  for (const typed of ctx.userText.match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi) ?? []) known.add(norm(typed));
  return to
    .filter((a) => !known.has(norm(a)))
    .map((a) => `${a} is not in the email being replied to or in your message. Check this address before sending.`);
}

export function draftTools(o: { broker: ApprovalBroker; mail: Pick<MailClient, 'read'>; userName: string; selfAddress: string }): RegisteredTool[] {
  return [
    {
      def: toolByName('mail_create_draft')!,
      label: 'Writing a draft…',
      async handler(args, ctx) {
        const a = args as { inReplyTo?: string; to: string[]; subject: string; body: string };
        const original = a.inReplyTo ? await o.mail.read(a.inReplyTo) : null;
        if (a.inReplyTo && !original) return `Error: no message with id ${a.inReplyTo}.`;
        const reply = original?.messageId ? { inReplyTo: original.messageId, references: original.references } : null;
        const d = await o.broker.create({
          to: a.to,
          subject: a.subject,
          body: a.body,
          inReplyTo: original ? original.id : null,
          reply,
          warnings: recipientWarnings(a.to, ctx, original, o.selfAddress),
        });
        return `Draft ${d.id} is saved in Drafts and shown to ${o.userName} with Send, Edit and Discard buttons. It has NOT been sent. Only ${o.userName} can send it, by clicking Send.`;
      },
    },
    {
      def: toolByName('mail_send_draft')!,
      label: 'Sending…',
      // The registry refuses write-tier calls before a handler runs; reaching this is a bug.
      handler: async () => {
        throw new Error('mail_send_draft cannot run from a model call');
      },
      deniedMessage: `Error: you cannot send mail. ${o.userName} sends a draft by clicking Send on its card. Tell them the draft is waiting there.`,
    },
  ];
}
