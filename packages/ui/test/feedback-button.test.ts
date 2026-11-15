/** The floating Feedback button sends only `/feedback <kind>: <text>`, like typing it. */
import { describe, expect, it } from 'vitest';
import { FEEDBACK_MAX, feedbackCommand } from '../src/components/FeedbackButton';

describe('feedbackCommand', () => {
  it('prefixes the kind and keeps the text as typed', () => {
    expect(feedbackCommand('idea', '  Show the weather\non the brief ')).toBe('/feedback Idea: Show the weather\non the brief');
    expect(feedbackCommand('problem', 'x')).toBe('/feedback Problem: x');
    expect(feedbackCommand('like', 'x')).toBe('/feedback Like: x');
  });

  it('sends nothing for blank text and stays under the /feedback limit', () => {
    expect(feedbackCommand('idea', '   ')).toBeNull();
    const cmd = feedbackCommand('idea', 'y'.repeat(10_000)) ?? '';
    expect(cmd.length).toBeLessThanOrEqual('/feedback Problem: '.length + FEEDBACK_MAX);
    // The saved idea (everything after "/feedback ") must fit FEEDBACK_MAX_CHARS (4000) in core.
    expect(cmd.slice('/feedback '.length).length).toBeLessThanOrEqual(4000);
  });
});
