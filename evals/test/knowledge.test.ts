import { ModelClient, type ModelRequest } from '@aios/core';
import { ModelRoleConfig } from '@aios/shared';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/knowledge-fixtures.js';
import { extractOnce, fixtureRequest, grade, keptLines, rawLines, unsupportedWords } from '../src/knowledge.js';

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
        const content = JSON.stringify({
          notes: [
            { section: 'people', text: 'Selin Arslan: returning the book on Saturday', basis: 'stated', quote: 'I can drop it off on Saturday afternoon' },
            { section: 'people', text: 'Selin Arslan: sister', basis: 'inferred', quote: 'Selin Arslan' },
          ],
          pages: [],
        });
        return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const ex = await extractOnce(client, fixtureRequest('nightly', fixture('shared-surname').item, 0));
    expect(ex.ok).toBe(true);
    expect(ex.raw).toEqual(['[people] Selin Arslan: returning the book on Saturday', '[people] Selin Arslan: sister']);
    expect(ex.lines).toEqual(['[people] Selin Arslan: returning the book on Saturday']);
    expect(ex.dropped).toEqual({ inferred: 1 });
    expect(seen).toHaveLength(1);
    expect((seen[0] as unknown as Record<string, unknown>).tools).toBeUndefined();
  });

  it('the old mistakes, made on purpose by a careless model, never reach the knowledge base; the stated facts do', () => {
    type Fact = { text: string; basis: 'stated' | 'observed' | 'inferred'; quote: string };
    const n = (section: 'people' | 'work' | 'commitments' | 'interests' | 'recent', text: string, quote: string, basis: Fact['basis'] = 'stated') => ({ section, text, basis, quote });
    const page = (name: string, facts: Fact[]) => ({ kind: 'person' as const, name, facts });
    // What models wrote before K5, with the quote each would give for it.
    const careless: Record<string, Parameters<typeof keptLines>[0]> = {
      'shared-surname': { notes: [n('people', 'Selin Arslan: sister; returning the book on Saturday', 'Selin Arslan'), n('people', 'Selin Arslan: returning the borrowed book on Saturday', 'I can drop it off on Saturday afternoon')] },
      'stated-sister': { notes: [n('people', 'Ece: sister, flying in from Berlin on Saturday', 'My sister Ece is flying in from Berlin'), n('people', 'Hakan Demir: friend', 'Hi Hakan')] },
      'hotel-booking': { notes: [n('interests', 'Likes Jacksonville', 'Riverside Suites Jacksonville', 'observed'), n('recent', 'Booked Riverside Suites in Jacksonville for 3 to 5 Oct', 'Check-in: 3 October 2026', 'observed')] },
      'stranger-invite': { notes: [n('people', 'Olena Marsh: colleague at Halcyon Labs', 'Intro call: Halcyon Labs and Deniz with Olena Marsh', 'observed'), n('people', 'Ece: sister, visiting on 17 Oct', 'Ece visiting', 'inferred')] },
      'friend-city': { notes: [n('interests', 'Loves Austin', 'I love it here')], pages: [page('Jonah Pike', [{ text: 'Loves living in Austin', basis: 'stated', quote: 'I love it here' }, { text: 'Brother; moved to Austin', basis: 'stated', quote: 'Jonah' }])] },
      'stated-interest': { notes: [n('interests', 'Plays tennis every Saturday and loves it', 'I play tennis every Saturday and I really love it'), n('people', 'Priya Nair: sister', 'Hi Priya')] },
      'chat-echo': { notes: [n('people', 'Buket Arslan: sister', 'your sister Buket Arslan'), n('people', 'Buket Arslan: sister; replied that Thursday is fine', 'draft a reply to Buket saying Thursday is fine')] },
      'vendor-signature': { notes: [n('people', 'Mark Tellez: colleague, Project Manager at Acme Build', 'Project Manager, Acme Build'), n('work', 'Kitchen renovation contract from Acme Build: $18,400, starting 2 Nov once signed', 'The total is $18,400')] },
      'hey-bro': { notes: [n('people', 'Can Yilmaz: brother; watching the match on Sunday', 'hey bro')] },
      'restaurant-once': { notes: [n('interests', 'Favourite restaurant: Olive and Vine', 'your table for 2 at Olive and Vine is booked', 'observed')] },
    };
    for (const f of FIXTURES) {
      const answer = careless[f.id]!;
      const item = fixtureRequest('nightly', f.item, 0);
      const kept = grade(f, keptLines(answer, item, 'nightly'));
      expect(kept.filter((c) => !c.pass).map((c) => `${f.id}: ${c.label} (${c.culprit ?? 'missing'})`)).toEqual([]);
    }
    // The model alone fails most of these.
    const raw = FIXTURES.flatMap((f) => grade(f, rawLines(careless[f.id]!)));
    expect(raw.filter((c) => !c.pass).length).toBeGreaterThanOrEqual(9);
    // On the local model even the stated sister and the tennis are left for the cloud model.
    const local = (id: string) => keptLines(careless[id]!, fixtureRequest('local', fixture(id).item, 0), 'local');
    expect(local('stated-sister')).toEqual([]);
    expect(local('stated-interest')).toEqual([]);
    expect(local('hotel-booking')).toEqual(['[recent] Booked Riverside Suites in Jacksonville for 3 to 5 Oct']);
  });
});
