/**
 * Focus sounds: rain, waves or brown noise in the background while the user works. The chat page
 * makes the sound itself with Web Audio (packages/ui/src/focus.ts), so there are no audio files
 * and nothing is downloaded; aios-core only keeps which sound is on and how loud, and tells every
 * open chat.
 *
 * Only the user's own typing (/focus) and clicks on the Focus tile change it, both through
 * Shell.handle; there is no tool for it, so neither the model nor text from an email, invite or
 * document can start, stop or change a sound (test: packages/core/test/focus.test.ts). The sound
 * itself is never saved: after a restart nothing plays until the user picks one. The volume is
 * kept.
 */
import { FOCUS_LABELS, FOCUS_SOUNDS, type Focus, FocusSound } from '@aios/shared';
import type { AuditLog } from './audit.js';
import type { Store } from './store.js';
import type { Glance } from './widgets/widgets.js';

const VOLUME_SETTING = 'focus.volume';
export const DEFAULT_FOCUS_VOLUME = 40;
const STEP = 10;

/** The words /focus takes for each sound. */
const NAMES: Record<string, FocusSound> = {
  rain: 'rain',
  'rain sounds': 'rain',
  rainfall: 'rain',
  waves: 'waves',
  wave: 'waves',
  ocean: 'waves',
  sea: 'waves',
  beach: 'waves',
  brown: 'brown',
  'brown noise': 'brown',
  noise: 'brown',
};
const STOP = new Set(['stop', 'off', 'pause', 'quiet', 'silence', 'end', 'none']);
const LOUDER = new Set(['louder', 'up', '+']);
const SOFTER = new Set(['quieter', 'softer', 'down', 'lower', '-']);

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/** The sound a /focus argument names, or null. */
export function focusByName(text: string): FocusSound | null {
  const parsed = FocusSound.safeParse(NAMES[norm(text)]);
  return parsed.success ? parsed.data : null;
}

const clampVolume = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export interface FocusOptions {
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  audit: AuditLog;
  /** Sends the new state to every open chat. */
  broadcast: (focus: Focus) => void;
  /** After a change, e.g. to refresh the Focus tile. */
  onChange?: () => void;
}

export class FocusSounds {
  private sound: FocusSound | null = null;

  constructor(private readonly o: FocusOptions) {}

  private volume(): number {
    const raw = this.o.store.getSetting(VOLUME_SETTING);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : DEFAULT_FOCUS_VOLUME;
  }

  current(): Focus {
    return { sound: this.sound, volume: this.volume() };
  }

  /**
   * Starts, stops or changes the sound and/or the volume. Only Shell calls this, for /focus and
   * the Focus tile: the user's typing or clicks.
   */
  set(change: { sound?: FocusSound | null; volume?: number }, via: 'command' | 'click'): Focus {
    const before = this.current();
    if (change.sound !== undefined) this.sound = change.sound;
    if (change.volume !== undefined) this.o.store.setSetting(VOLUME_SETTING, String(clampVolume(change.volume)));
    const now = this.current();
    if (now.sound === before.sound && now.volume === before.volume) return now;
    this.o.audit.append({ kind: 'focus', event: now.sound === null ? 'stop' : before.sound === now.sound ? 'volume' : 'play', sound: now.sound, volume: now.volume, via });
    this.o.broadcast(now);
    this.o.onChange?.();
    return now;
  }

  /** The Focus tile: what is playing and how loud, written by code. */
  glance(): Glance {
    const f = this.current();
    return { lines: f.sound ? [FOCUS_LABELS[f.sound], `${f.volume}%`] : ['Off'], attention: false };
  }

  /** /focus <words>: the user's own typing. Returns a line for the chat. */
  command(text: string): string {
    const t = norm(text);
    const names = FOCUS_SOUNDS.map((s) => FOCUS_LABELS[s].toLowerCase()).join(', ');
    const usage = `/focus ${FOCUS_SOUNDS.join(', /focus ')} starts one, /focus 30 sets the volume, /focus stop ends it. The Focus tile at the bottom does the same.`;
    if (!t) {
      const f = this.current();
      return f.sound ? `Playing ${FOCUS_LABELS[f.sound].toLowerCase()} at ${f.volume}%. ${usage}` : `No focus sound is playing. There are three: ${names}. ${usage}`;
    }
    if (STOP.has(t)) {
      if (!this.sound) return 'No focus sound is playing.';
      this.set({ sound: null }, 'command');
      return 'Stopped the focus sound.';
    }
    if (LOUDER.has(t) || SOFTER.has(t)) {
      const f = this.set({ volume: this.volume() + (LOUDER.has(t) ? STEP : -STEP) }, 'command');
      return f.sound ? `Volume ${f.volume}%.` : `Volume set to ${f.volume}% for when a sound plays.`;
    }
    // "30", "30%", "volume 30", "rain 30", "rain at 30%".
    const m = /^(?:(.+?)\s+(?:at\s+)?)?(?:vol(?:ume)?\s*)?(\d{1,3})\s*%?$/.exec(t);
    const word = m ? (m[1] ?? '').replace(/^vol(?:ume)?$/, '') : t;
    const volume = m ? Number(m[2]) : undefined;
    if (volume !== undefined && volume > 100) return 'The volume goes from 0 to 100, for example /focus 30.';
    const sound = word ? focusByName(word) : null;
    if (word && !sound) return `I have three focus sounds: ${names}. ${usage}`;
    const f = this.set({ ...(sound ? { sound } : {}), ...(volume === undefined ? {} : { volume }) }, 'command');
    if (sound) return `Playing ${FOCUS_LABELS[sound].toLowerCase()} at ${f.volume}%. /focus stop ends it.`;
    return f.sound ? `Volume ${f.volume}%.` : `Volume set to ${f.volume}% for when a sound plays.`;
  }
}
