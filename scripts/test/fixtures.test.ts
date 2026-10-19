import { describe, expect, it } from 'vitest';
import { fixtures } from '../../fixtures/mail.js';
import { composeFixture } from '../src/compose.js';

const byKey = new Map(fixtures.map((f) => [f.key, f]));

describe('mail fixtures', () => {
  it('has ~40 messages with unique keys', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(38);
    expect(byKey.size).toBe(fixtures.length);
  });

  it('covers threads, attachments and every hostile kind', () => {
    expect(fixtures.filter((f) => f.inReplyTo).length).toBeGreaterThanOrEqual(6);
    expect(fixtures.filter((f) => f.attachments?.length).length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(fixtures.flatMap((f) => (f.hostile ? [f.hostile.kind] : [])));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
  });

  it('only references threads that exist', () => {
    for (const f of fixtures) if (f.inReplyTo) expect(byKey.has(f.inReplyTo), f.key).toBe(true);
  });

  it('composes RFC 822 with threading headers and attachments', async () => {
    const mail = byKey.get('budget-4')!;
    const { raw } = await composeFixture(mail, byKey, new Date('2026-10-19T00:00:00Z'));
    const text = raw.toString('utf8');
    expect(text).toContain('Message-ID: <budget-4@fixtures.aios.test>');
    expect(text).toContain('In-Reply-To: <budget-3@fixtures.aios.test>');
    expect(text).toMatch(/References: <budget-1@[^>]+> <budget-2@[^>]+>\s+<budget-3@/);
    expect(text).toContain('filename=cloud-spend-q4.csv');
  });
});
