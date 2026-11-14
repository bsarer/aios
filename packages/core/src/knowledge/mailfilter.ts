/**
 * K3: which emails the knowledge base reads, decided by code before any model sees one. A
 * personal inbox holds tens of thousands of messages, most of them shops, newsletters and
 * notifications: reading those costs money (or hours of local model time) and says little about
 * the user. Gmail's tabs are left out by the search itself (`MailClient.list`); this file skips
 * bulk and automated mail on any server by its headers, plus the user's own sender lists.
 *
 * The user's own sent mail is always read. Nothing here reads a body or calls a model.
 */
import type { KnowledgeConfig } from '@aios/shared';
import type { Address, BulkHeaders } from '../mail/imap.js';

/** Sender names that machines send from: noreply@, notifications@, mailer-daemon@ and the like. */
const AUTOMATED_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|notify|alerts?|mailer[-_.]?daemon|postmaster|bounces?|newsletters?|marketing)([-_.+].*)?$/i;

/** Bulk or automated mail by its headers or its sender's name. */
export function isAutomated(m: { from: Address | null; bulkHeaders: BulkHeaders }): boolean {
  const h = m.bulkHeaders;
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (h.precedence && /^(bulk|list|junk|auto_reply)$/i.test(h.precedence.trim())) return true;
  if (h['auto-submitted'] && !/^no\b/i.test(h['auto-submitted'].trim())) return true;
  const local = m.from?.address.split('@')[0] ?? '';
  return AUTOMATED_SENDER.test(local);
}

/** An address matches "ana@home.example" exactly, or "home.example" as its domain or a subdomain of it. */
export function senderMatches(address: string | undefined, patterns: readonly string[]): boolean {
  const a = (address ?? '').trim().toLowerCase();
  if (!a || !patterns.length) return false;
  const domain = a.split('@')[1] ?? '';
  return patterns.some((p) => (p.includes('@') ? a === p : domain === p || domain.endsWith(`.${p}`)));
}

export type SkipReason = 'automated' | 'sender';

/** Null to read it, or why it is skipped. `sent`: the user wrote it. */
export function skipReason(
  m: { from: Address | null; bulkHeaders: BulkHeaders },
  sent: boolean,
  c: Pick<KnowledgeConfig, 'skipAutomated' | 'skipSenders' | 'alwaysSenders'>,
): SkipReason | null {
  if (sent) return null;
  const from = m.from?.address;
  if (senderMatches(from, c.alwaysSenders)) return null;
  if (senderMatches(from, c.skipSenders)) return 'sender';
  if (c.skipAutomated && isAutomated(m)) return 'automated';
  return null;
}
