import { ModelClient, type ModelRequest } from '@aios/core';
import { ModelRoleConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/knowledge-fixtures.js';
import { extractOnce, grade, unsupportedWords } from '../src/knowledge.js';

const fixture = (id: string) => FIXTURES.find((f) => f.id === id)!;

describe('knowledge bake-off checks', () => {
  it('catches the guesses from the report: a surname sister, an echoed sister, a liked city, a stranger colleague', () => {
    expect(grade(fixture('shared-surname'), ['Selin Arslan (person): Sister; returning the book on Saturday'])[0]!.pass).toBe(false);
    expect(grade(fixture('chat-echo'), ['[people] Buket Arslan: sister; replied that Thursday is fine'])[0]!.pass).toBe(false);
    expect(grade(fixture('hotel-booking'), ['[interests] Likes Jacksonville'])[0]!.pass).toBe(false);
    expect(grade(fixture('stranger-invite'), ['[people] Olena Marsh: colleague at Halcyon Labs'])[0]!.pass).toBe(false);
  });

  it('passes grounded notes and keeps stated facts', () => {
    expect(grade(fixture('shared-surname'), ['[people] Selin Arslan: returning a borrowed book on Saturday afternoon']).every((c) => c.pass)).toBe(true);
    expect(grade(fixture('stated-sister'), ['[people] Ece: sister, flying in from Berlin on Saturday']).every((c) => c.pass)).toBe(true);
    expect(grade(fixture('stated-sister'), ['[recent] Picking someone up at the airport'])[0]!.pass).toBe(false);
    // The friend's own liking is fine; the user's isn't.
    expect(grade(fixture('friend-city'), ['Jonah Pike (person): Loves living in Austin'])[0]!.pass).toBe(true);
    expect(grade(fixture('friend-city'), ['[interests] Loves Austin'])[0]!.pass).toBe(false);
  });

  it('flags relationship and liking words the source never uses', () => {
    expect(unsupportedWords('[people] Buket Sarer: sister', 'Hi, can we talk Thursday? Buket')).toEqual(['sister']);
    expect(unsupportedWords('[people] Ece: sister', 'my sister Ece is flying in')).toEqual([]);
    expect(unsupportedWords('[interests] Loves tennis', 'I really love it')).toEqual([]);
    expect(unsupportedWords('[people] Olga: co-worker', 'see you at the meeting')).toEqual(['coworker']);
  });

  it('sends the knowledge requests with no tools and reads a structured answer', async () => {
    const seen: ModelRequest[] = [];
    const role = ModelRoleConfig.parse({ baseUrl: 'http://127.0.0.1:9/v1', model: 'pretend', apiKeyRef: 'keyring:aios-test' });
    const client = new ModelClient({
      models: { chat: role, triage: role, nightly: role },
      resolveKey: async () => ({ reveal: () => 'x' }) as never,
      fetch: (async (_url: string, init: { body: string }) => {
        seen.push(JSON.parse(init.body) as ModelRequest);
        const content = JSON.stringify({ notes: [{ section: 'people', text: 'Selin Arslan: returning the book on Saturday' }], pages: [] });
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const { mailRequest } = await import('@aios/core');
    const f = fixture('shared-surname');
    if (f.item.kind !== 'mail') throw new Error('mail fixture');
    const ex = await extractOnce(client, mailRequest('nightly', 'Deniz Arslan', { id: 'x', sentByUser: false, from: f.item.from, to: f.item.to, date: f.item.date, subject: f.item.subject, body: { text: f.item.text } }));
    expect(ex.ok).toBe(true);
    expect(ex.lines).toEqual(['[people] Selin Arslan: returning the book on Saturday']);
    expect(seen).toHaveLength(1);
    expect((seen[0] as unknown as Record<string, unknown>).tools).toBeUndefined();
  });
});
