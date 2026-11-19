import { describe, expect, it } from 'vitest';
import { chatSystemPrompt } from '../src/prompts.js';
import { ALPHA_TOOLS } from '../src/tools/definitions.js';

const NOW = 'Wednesday, 18 November 2026, 21:30 (America/New_York, UTC-05:00)';

// "Do I have any appointments tomorrow?" with no calendar connected went round between the
// knowledge base and mail. Without the calendar the prompt has to say so outright.
describe('chat prompt and the calendar', () => {
  it('says the calendar is not connected, and where to connect it, when its tools are missing', () => {
    const p = chatSystemPrompt({ userName: 'Baris', now: NOW, knowledge: true, knowledgeSearch: true });
    expect(p).toContain("Calendar: not connected");
    expect(p).toContain('the Settings gear');
    expect(p).toContain("Don't look for events in mail or the knowledge base");
    expect(p).not.toContain('use calendar_list');
  });

  it('gives the calendar rules, not the not-connected line, when the calendar is there', () => {
    const p = chatSystemPrompt({ userName: 'Baris', now: NOW, calendar: true, knowledge: true });
    expect(p).toContain('use calendar_list');
    expect(p).not.toContain('Calendar: not connected');
  });

  it('never offers the knowledge base as a calendar', () => {
    const p = chatSystemPrompt({ userName: 'Baris', now: NOW, knowledge: true });
    expect(p).not.toMatch(/upcoming events/);
    expect(p).toContain('It is not the calendar');
    const kb = ALPHA_TOOLS.find((t) => t.name === 'knowledge_read');
    expect(kb?.description).not.toMatch(/upcoming events/);
    expect(kb?.description).toContain('Not a calendar');
  });

  it('asks for each thing to be looked up once', () => {
    expect(chatSystemPrompt({ userName: 'Baris', now: NOW })).toContain('Look each thing up once');
  });
});
