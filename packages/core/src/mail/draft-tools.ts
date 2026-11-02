/**
 * mail_create_draft (draft tier) and mail_send_draft (write tier). Drafting saves to the
 * Drafts folder and shows a card; it never sends. mail_send_draft is registered so the
 * model gets a clear answer and the attempt is audited, but the registry refuses every
 * write-tier call: mail goes out only through ApprovalBroker.approveSend on a Send click.
 * M1: a draft can carry files from the allowed folders; the card lists them and Send
 * reads them again, so a file is only ever sent by the same click as the text.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext } from '../tools/registry.js';
import type { ApprovalBroker } from './approvals.js';
import type { FullMessage, MailClient } from './imap.js';
import type { OutgoingAttachment, OutgoingFiles } from './outgoing-files.js';

const norm = (a: string) => a.trim().toLowerCase();

/**
 * Recipients that came from neither the user's own message nor the email being replied
 * to: an address the model guessed, or the shape of an injected "also send this to
 * attacker@…". Written by code; shown on the card.
 */
export function recipientWarnings(to: string[], ctx: Pick<ToolContext, 'userText'>, original: FullMessage | null, self: string): string[] {
  const known = new Set(
    original ? [original.from, ...original.replyTo, ...original.to, ...original.cc].flatMap((a) => (a ? [norm(a.address)] : [])) : [],
  );
  known.add(norm(self));
  for (const typed of ctx.userText.match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[a-z]{2,}/gi) ?? []) known.add(norm(typed));
  return to
    .filter((a) => !known.has(norm(a)))
    .map((a) => `${a} is not in your message or in the email being replied to. Check this address before sending.`);
}

/** Words of a file name that would show the user named it: `lease-2026 final.pdf` → lease, final. */
const nameWords = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w));

/**
 * Files attached while text from an email (or a calendar event or a document) is in view,
 * that the user's own message doesn't name: the shape of an injected "attach your tax
 * return". Written by code; shown on the card next to the file. The Send click is still the
 * only way anything goes out.
 */
export function attachmentWarning(a: Pick<OutgoingAttachment, 'name' | 'display'>, ctx: Pick<ToolContext, 'userText' | 'untrustedInContext'>): string | undefined {
  if (!ctx.untrustedInContext) return undefined;
  const typed = ctx.userText.toLowerCase();
  const said = new Set(typed.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const named = typed.includes(a.name.toLowerCase()) || nameWords(a.name).some((w) => said.has(w) || [...said].some((s) => s.length >= 4 && w.startsWith(s)));
  return named ? undefined : `${a.display} was attached while an email or other outside text was in view, and your message doesn't name it. Make sure you want to send this file.`;
}

export function draftTools(o: {
  broker: ApprovalBroker;
  mail: Pick<MailClient, 'read'>;
  userName: string;
  selfAddress: string;
  /** M1: files from the allowed folders. Without it, drafts can't carry files. */
  files?: Pick<OutgoingFiles, 'pick'>;
}): RegisteredTool[] {
  return [
    {
      def: toolByName('mail_create_draft')!,
      label: 'Writing a draft…',
      async handler(args, ctx) {
        const a = args as { inReplyTo?: string; to: string[]; subject: string; body: string; attachments?: string[] };
        const original = a.inReplyTo ? await o.mail.read(a.inReplyTo) : null;
        if (a.inReplyTo && !original) return `Error: no message with id ${a.inReplyTo}.`;
        let files: Awaited<ReturnType<OutgoingFiles['pick']>> | undefined;
        if (a.attachments?.length) {
          if (!o.files) return 'Error: files cannot be attached because file access is turned off in the config ([files] enabled = false). Say so; no draft was made.';
          try {
            files = await o.files.pick(a.attachments);
          } catch (err) {
            return `Error: ${(err as Error).message}. No draft was made.`;
          }
          for (const f of files.attachments) {
            const warning = attachmentWarning(f, ctx);
            if (warning) f.warning = warning;
          }
        }
        const reply = original?.messageId ? { inReplyTo: original.messageId, references: original.references } : null;
        const d = await o.broker.create({
          to: a.to,
          subject: a.subject,
          body: a.body,
          inReplyTo: original ? original.id : null,
          reply,
          warnings: recipientWarnings(a.to, ctx, original, o.selfAddress),
          ...(files ? { files } : {}),
        });
        const n = d.attachments.length;
        const withFiles = n ? ` with ${n} attached file${n === 1 ? '' : 's'}` : '';
        return `Draft ${d.id}${withFiles} is saved in Drafts and shown to ${o.userName} with Send, Edit and Discard buttons. It has NOT been sent. Only ${o.userName} can send it, by clicking Send.`;
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
