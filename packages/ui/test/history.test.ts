/** Up/Down in the message box (history.ts): shell-style recall of what the user sent. */
import { describe, expect, it } from 'vitest';
import { MAX_ENTRIES, down, edited, emptyRecall, onFirstLine, onLastLine, remember, seed, up } from '../src/history';

const sent = (...texts: string[]) => texts.reduce(remember, emptyRecall());

describe('message history', () => {
  it('steps back from the newest with Up and forward with Down, then gives the draft back', () => {
    let r = sent('hello', '/feedback list', 'what is on tomorrow?');
    const a = up(r, 'half typed');
    expect(a?.text).toBe('what is on tomorrow?');
    r = a!.recall;
    const b = up(r, a!.text);
    expect(b?.text).toBe('/feedback list');
    r = b!.recall;
    const c = up(r, b!.text);
    expect(c?.text).toBe('hello');
    r = c!.recall;
    expect(up(r, 'hello')).toBeNull(); // nothing older: the box stays as it is
    r = down(r)!.recall;
    r = down(r)!.recall;
    const back = down(r);
    expect(back?.text).toBe('half typed');
    expect(back?.recall.at).toBeNull();
    expect(down(back!.recall)).toBeNull(); // not browsing: Down does nothing
  });

  it('does nothing with no history', () => {
    expect(up(emptyRecall(), '')).toBeNull();
    expect(down(emptyRecall())).toBeNull();
  });

  it('keeps a repeated message once, skips blanks, and caps the list', () => {
    expect(sent('a', 'a', '  ', 'b', 'a').entries).toEqual(['a', 'b', 'a']);
    const many = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `m${i}`);
    const r = sent(...many);
    expect(r.entries).toHaveLength(MAX_ENTRIES);
    expect(r.entries.at(-1)).toBe(`m${MAX_ENTRIES + 4}`);
  });

  it('puts the chat as loaded before what was sent from the page', () => {
    expect(seed(sent('new'), ['old 1', 'old 2', 'old 2']).entries).toEqual(['old 1', 'old 2', 'new']);
  });

  it('starts again from the newest once the recalled text is edited, with the edit as the draft', () => {
    let r = up(sent('one', 'two'), '')!.recall;
    r = edited(r);
    const a = up(r, 'two, edited');
    expect(a?.text).toBe('two');
    expect(down(a!.recall)?.text).toBe('two, edited');
  });

  it('takes over Up only on the first line and Down only on the last', () => {
    const text = 'line one\nline two';
    expect(onFirstLine(text, 3)).toBe(true);
    expect(onFirstLine(text, 12)).toBe(false);
    expect(onLastLine(text, 12)).toBe(true);
    expect(onLastLine(text, 3)).toBe(false);
  });
});
