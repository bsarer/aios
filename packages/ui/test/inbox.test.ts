/** Calm mail alerts: what the side rail's inbox lists, counts and peeks for, read from notification items. */
import type { ChatItem, MailRow } from '@aios/shared/protocol';
import { describe, expect, it } from 'vitest';
import { QUIET_MS, counts, groups, inboxRows, isNew, peekFor, rowTime, senderName } from '../src/inbox';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 16, 14, 0);

const mail = (id: string, urgency: MailRow['urgency'], extra: Partial<MailRow> = {}): MailRow => ({
  id,
  from: `Sender ${id} <s@x.example>`,
  subject: `Subject ${id}`,
  summary: `Summary ${id}`,
  urgency,
  needsReply: false,
  ...extra,
});
const note = (id: string, at: number, mails: MailRow[], catchUp?: boolean): ChatItem => ({
  kind: 'notification',
  id,
  text: `${mails.length} new emails.`,
  at,
  mails,
  ...(catchUp ? { catchUp } : {}),
});

describe('inbox rows', () => {
  it("orders by each email's own date and shows it, not the notification's time", () => {
    const items: ChatItem[] = [
      note('batch', NOW - HOUR, [mail('INBOX:1', 'normal', { date: NOW - 3 * HOUR }), mail('INBOX:2', 'normal', { date: NOW - 90 * 60_000 })]),
      note('later', NOW - 30 * 60_000, [mail('INBOX:3', 'normal', { date: NOW - 2 * HOUR })]),
    ];
    const rows = inboxRows(items, NOW);
    expect(rows.map((r) => r.id)).toEqual(['INBOX:2', 'INBOX:3', 'INBOX:1']);
    const times = rows.filter((r) => r.itemId === 'batch').map((r) => rowTime(r, NOW));
    expect(new Set(times).size).toBe(2);
    // A row without a date (posted before rows carried one) shows the notification's time.
    const old = inboxRows([note('n', NOW - HOUR, [mail('INBOX:9', 'normal')])], NOW)[0]!;
    expect(rowTime(old, NOW)).toBe(new Date(NOW - HOUR).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    // Yesterday's mail names the day too.
    expect(rowTime({ ...old, date: NOW - 30 * HOUR }, NOW)).toContain(',');
  });

  it('lists the last day of mail, newest notification first, each mail once', () => {
    const items: ChatItem[] = [
      note('old', NOW - 25 * HOUR, [mail('INBOX:1', 'normal')]),
      note('a', NOW - 2 * HOUR, [mail('INBOX:2', 'high'), mail('INBOX:3', 'low')]),
      { kind: 'user', id: 'u', text: 'hi', at: NOW - HOUR },
      // Mail re-posted later (e.g. a catch-up) is listed once, with the newer notification.
      note('b', NOW - HOUR, [mail('INBOX:4', 'normal'), mail('INBOX:3', 'low')], true),
    ];
    const rows = inboxRows(items, NOW);
    expect(rows.map((r) => [r.id, r.itemId])).toEqual([
      ['INBOX:4', 'b'],
      ['INBOX:3', 'b'],
      ['INBOX:2', 'a'],
    ]);
    const g = groups(rows);
    expect(g.needs.map((r) => r.id)).toEqual(['INBOX:2']);
    expect(g.others.map((r) => r.id)).toEqual(['INBOX:4']);
    expect(g.low.map((r) => r.id)).toEqual(['INBOX:3']);
  });

  it('counts new mail after the inbox was last opened, leaving ignored mail out', () => {
    const rows = inboxRows(
      [
        note('a', NOW - 3 * HOUR, [mail('INBOX:1', 'high')]),
        note('b', NOW - HOUR, [mail('INBOX:2', 'high'), mail('INBOX:3', 'normal'), mail('INBOX:4', 'normal', { ignored: true })]),
      ],
      NOW,
    );
    expect(counts(rows, NOW - 2 * HOUR)).toEqual({ fresh: 2, urgent: 1 });
    expect(counts(rows, NOW)).toEqual({ fresh: 0, urgent: 0 });
    expect(isNew(rows.find((r) => r.id === 'INBOX:4')!, 0)).toBe(false);
  });

  it('keeps the sender name without the address', () => {
    expect(senderName('Dana Ortiz <dana@x.example>')).toBe('Dana Ortiz');
    expect(senderName('<only@x.example>')).toBe('<only@x.example>');
  });
});

describe('urgent peek', () => {
  const opened = NOW - HOUR;
  it('peeks only for urgent mail that arrived after the page opened, once', () => {
    const items = [note('history', opened - 1, [mail('INBOX:1', 'high')]), note('calm', NOW, [mail('INBOX:2', 'normal')]), note('live', NOW, [mail('INBOX:3', 'high')])];
    expect(peekFor(items, opened, new Set(), 0, NOW)?.id).toBe('INBOX:3');
    expect(peekFor(items, opened, new Set(['live']), 0, NOW)).toBeNull();
  });

  it('does not peek for ignored mail or while quiet', () => {
    expect(peekFor([note('n', NOW, [mail('INBOX:1', 'high', { ignored: true })])], opened, new Set(), 0, NOW)).toBeNull();
    const items = [note('n', NOW, [mail('INBOX:1', 'high')])];
    expect(peekFor(items, opened, new Set(), NOW + QUIET_MS, NOW)).toBeNull();
    expect(peekFor(items, opened, new Set(), NOW - 1, NOW)?.id).toBe('INBOX:1');
    // Core marks mail quiet in quiet hours or over the hourly limit: listed, never peeking.
    const quiet: ChatItem = { kind: 'notification', id: 'q', text: '1 new email.', at: NOW, mails: [mail('INBOX:9', 'high')], quiet: true };
    expect(peekFor([quiet], opened, new Set(), 0, NOW)).toBeNull();
    expect(inboxRows([quiet], NOW).map((r) => r.id)).toEqual(['INBOX:9']);
  });
});
