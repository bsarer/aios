/**
 * mail_trash and mail_unsubscribe (draft tier, like mail_create_draft): each only puts a card
 * in the chat, or for an unsubscribe email a draft card, and returns no email text. The action
 * itself runs from the card's click (MailActions.confirm, audited as write tier), so text in an
 * email can at most make a card appear; when one is asked for while outside text is in view and
 * the user's own message doesn't ask for it, code adds a warning to the card.
 */
import { toolByName } from '../tools/definitions.js';
import type { RegisteredTool, ToolContext } from '../tools/registry.js';
import type { MailActions } from './actions.js';

const TRASH_WORDS = /\b(delete|deleting|trash|bin|remove|removing|get rid|clear out|clean up|throw away)\b/i;
const UNSUBSCRIBE_WORDS = /\b(unsubscribe|unsub|opt out|stop (sending|getting|receiving|emails?|these)|mailing list|newsletter)/i;

/** Written by code: the card was asked for while outside text was in view, and the user's message doesn't ask for it. */
export function steeredWarning(op: 'trash' | 'unsubscribe', ctx: Pick<ToolContext, 'userText' | 'untrustedInContext'>): string[] {
  if (!ctx.untrustedInContext) return [];
  if ((op === 'trash' ? TRASH_WORDS : UNSUBSCRIBE_WORDS).test(ctx.userText)) return [];
  return [op === 'trash' ? "Suggested while an email was in view, and your message doesn't ask to delete anything. Check these are emails you want gone." : "Suggested while an email was in view, and your message doesn't ask to unsubscribe. Check this is what you want."];
}

export function mailActionTools(o: { actions: Pick<MailActions, 'proposeTrash' | 'proposeUnsubscribe'>; userName: string }): RegisteredTool[] {
  return [
    {
      def: toolByName('mail_trash')!,
      label: 'Getting the emails…',
      async handler(args, ctx) {
        const { ids } = args as { ids: string[] };
        const { item, missing } = await o.actions.proposeTrash(ids, steeredWarning('trash', ctx), ctx.signal);
        const notFound = missing.length ? ` There is no email with id ${missing.join(', ')}.` : '';
        if (!item) return { content: `Error: no card was made.${notFound}`, audit: { missing: missing.length } };
        return {
          content: `A card listing ${item.mails.length} email${item.mails.length === 1 ? '' : 's'} is in the chat with Move to Trash and Discard buttons.${notFound} Nothing has been deleted: only ${o.userName}'s click does that. Say so in one line.`,
          audit: { itemId: item.id, mails: item.mails.length, missing: missing.length },
        };
      },
    },
    {
      def: toolByName('mail_unsubscribe')!,
      label: 'Checking how to unsubscribe…',
      async handler(args, ctx) {
        const { id } = args as { id: string };
        const r = await o.actions.proposeUnsubscribe(id, steeredWarning('unsubscribe', ctx), ctx.signal);
        switch (r.kind) {
          case 'missing':
            return `Error: no message with id ${id}.`;
          case 'none':
            return { content: `That email has no unsubscribe link or address in its headers, so Astra can't unsubscribe from it. Say so in one line, and offer to move it to Trash (mail_trash) instead.`, audit: { way: 'none' } };
          case 'draft':
            return { content: `This list unsubscribes by email: a draft to ${r.to} is in the chat as a card (${r.draftId}). Nothing is sent until ${o.userName} clicks Send on it. Say so in one line.`, audit: { way: 'email', draftId: r.draftId } };
          case 'card':
            return {
              content:
                r.item.method === 'one_click'
                  ? `A card to unsubscribe from ${r.item.site} is in the chat. Nothing has been sent: only ${o.userName}'s click on Unsubscribe does that. Say so in one line.`
                  : `A card is in the chat whose button opens the unsubscribe page on ${r.item.site}; ${o.userName} finishes there. Nothing has happened yet. Say so in one line.`,
              audit: { way: r.item.method, itemId: r.item.id },
            };
        }
      },
    },
  ];
}
