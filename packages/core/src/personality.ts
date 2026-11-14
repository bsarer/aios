/**
 * P1: the assistant's name and tone. The name comes from `[personality] name`. The tone starts
 * from `[personality] tone` and then follows the user's own /tone command, kept in the store like
 * the pinned widgets. Only Shell calls setTone, for /tone typed in the chat: there is no tool for
 * it, so nothing in an email, invite or document can change how the assistant talks
 * (test: packages/core/test/personality.test.ts).
 */
import { PERSONALITY_TONES, type PersonalityConfig, Tone } from '@aios/shared';
import type { AuditLog } from './audit.js';
import type { Store } from './store.js';

export interface Voice {
  name: string;
  tone: Tone;
}

export interface PersonalityOptions {
  defaults: PersonalityConfig;
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  audit: AuditLog;
}

const SETTING = 'personality.tone';

/** One line each, for /tone with no argument. */
export const TONE_LINES: Record<Tone, string> = {
  friendly: 'warm and plain, with a light touch of fun',
  playful: 'friendly with more wit, and the odd emoji',
  neutral: 'clear and polite, no small talk',
  concise: 'results only, as few words as possible',
};

/** The tone a /tone argument names, or null. */
export function toneByName(text: string): Tone | null {
  const parsed = Tone.safeParse(text.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

/** True for the tones that get the warmer wording in code-written lines. */
export function isWarm(tone: Tone): boolean {
  return tone === 'friendly' || tone === 'playful';
}

export class Personality {
  constructor(private readonly o: PersonalityOptions) {}

  get name(): string {
    return this.o.defaults.name;
  }

  /** The user's saved choice, or the config's default. */
  tone(): Tone {
    const parsed = Tone.safeParse(this.o.store.getSetting(SETTING));
    return parsed.success ? parsed.data : this.o.defaults.tone;
  }

  voice(): Voice {
    return { name: this.name, tone: this.tone() };
  }

  /** Changes the tone. Only Shell calls this, for /tone: the user's own typing. Returns a line for the chat. */
  setTone(tone: Tone): string {
    if (tone === this.tone()) return `I'm already ${tone}.`;
    this.o.store.setSetting(SETTING, tone);
    this.o.audit.append({ kind: 'personality', event: 'tone', tone, via: 'command' });
    return toneChangedLine(tone);
  }
}

function toneChangedLine(tone: Tone): string {
  switch (tone) {
    case 'friendly':
      return "Friendly it is. I'll keep things warm and simple.";
    case 'playful':
      return "Playful mode on. I'll keep it fun, and I'll still be serious when it counts.";
    case 'neutral':
      return 'Tone set to neutral.';
    case 'concise':
      return 'Tone set to concise.';
  }
}

export const TONE_NAMES: readonly Tone[] = PERSONALITY_TONES;
