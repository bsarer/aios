/**
 * Fading older messages: once the user has stepped away from the chat for a while, older
 * exchanges dim a little more each minute so the screen looks calm when they come back.
 *
 * - Only idle time counts (no mouse movement, keys, clicks, touch or wheel here for a minute),
 *   never the clock alone, so nothing dims while someone is reading.
 * - The latest exchange (the user's last message and everything after it) never fades.
 * - Cards that wait for the user (a Save, Send or confirm click, a running build they can stop)
 *   never fade, wherever they are.
 * - Nothing goes below FADE_FLOOR: faded, never gone.
 * - Any activity brings everything back at once.
 *
 * This is display only, worked out here from the items the screen already has; it sends
 * nothing to core. `[ui] fade = false` in the config (or the setup window's Wallpaper step)
 * turns it off.
 */
import type { ChatItem } from '@aios/shared/protocol';

/** How long the chat must be idle before anything fades. */
export const FADE_AFTER_MS = 60_000;
/** Each further idle minute fades one step more. */
export const FADE_STEP_MS = 60_000;
/** The first step: clear enough to see at a glance. */
export const FADE_FIRST = 0.7;
/** How much each further step takes away. */
export const FADE_STEP = 0.15;
/** The faintest a message gets. */
export const FADE_FLOOR = 0.2;

/** True for a card that still waits for the user, or something still happening. */
export function needsYou(item: ChatItem): boolean {
  switch (item.kind) {
    case 'assistant':
      return item.streaming;
    case 'tool':
      return item.state === 'running';
    case 'memory':
      return item.state === 'pending';
    case 'draft':
    case 'signal':
      return item.state === 'pending' || item.state === 'sending' || item.state === 'failed';
    case 'action':
      return item.state === 'pending' || item.state === 'running';
    case 'event':
    case 'file_change':
    case 'doc_change':
      return item.state === 'pending' || item.state === 'running' || item.state === 'failed';
    case 'update':
      return item.state === 'available';
    default:
      return false;
  }
}

/** How many fade steps an idle stretch this long has reached (0: nothing fades yet). */
export function idleSteps(idleMs: number): number {
  if (!(idleMs >= FADE_AFTER_MS)) return 0;
  return 1 + Math.floor((idleMs - FADE_AFTER_MS) / FADE_STEP_MS);
}

/**
 * The opacity of each item that fades, by id; items not in the map stay solid. An exchange is
 * a user message and what follows it; each exchange further back is one step fainter. The
 * latest exchange stays solid up to Astra's last answer in it; things that came after that
 * answer (notices from slash commands, say) count as one exchange back, except the newest item
 * on screen, which always stays.
 */
export function fadeLevels(items: readonly ChatItem[], steps: number): Map<string, number> {
  const out = new Map<string, number>();
  if (steps <= 0) return out;
  let exchanges = 0;
  let lastUser = -1;
  items.forEach((i, at) => {
    if (i.kind === 'user') {
      exchanges++;
      lastUser = at;
    }
  });
  // A chat without a message from the user (the greeting, a brief) has nothing older to fade.
  if (exchanges === 0) return out;
  let answer = -1;
  for (let at = items.length - 1; at > lastUser; at--) {
    if (items[at]!.kind === 'assistant') {
      answer = at;
      break;
    }
  }
  const solidTo = answer === -1 ? items.length - 1 : answer;
  let n = 0;
  items.forEach((item, at) => {
    if (item.kind === 'user') n++;
    const back = at > solidTo ? 1 : exchanges - n;
    if (back <= 0 || at === items.length - 1 || needsYou(item)) return;
    out.set(item.id, Math.max(FADE_FLOOR, Number((FADE_FIRST - FADE_STEP * (steps + back - 2)).toFixed(2))));
  });
  return out;
}
