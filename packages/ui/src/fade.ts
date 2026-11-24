/**
 * Fading older messages: as time passes, older exchanges dim a little more each minute so the
 * chat doesn't look cluttered.
 *
 * - An exchange starts to fade a minute after it stops being the latest (the user's next
 *   message), and dims a step a minute after that; older ones are fainter because they were
 *   replaced longer ago.
 * - The latest exchange (the user's last message up to Astra's last answer) never fades, nor
 *   the newest item on screen.
 * - Cards that wait for the user (a Save, Send or confirm click, a running build they can stop)
 *   never fade, wherever they are.
 * - Nothing goes below FADE_FLOOR: faded, never gone.
 * - Only scrolling up the chat brings everything back (useFade.ts); then it fades again from
 *   that moment. Typing, clicking and moving the mouse don't.
 *
 * This is display only, worked out here from the items the screen already has; it sends
 * nothing to core. `[ui] fade = false` in the config (or the setup window's Wallpaper step)
 * turns it off.
 */
import type { ChatItem } from '@aios/shared/protocol';

/** How long after an exchange is replaced (or brought back) before it fades. */
export const FADE_AFTER_MS = 60_000;
/** Each further minute fades one step more. */
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

/** How many fade steps this long has reached (0: nothing fades yet). */
export function idleSteps(idleMs: number): number {
  if (!(idleMs >= FADE_AFTER_MS)) return 0;
  return 1 + Math.floor((idleMs - FADE_AFTER_MS) / FADE_STEP_MS);
}

/**
 * The opacity of each item that fades at `now`, by id; items not in the map stay solid. Each item
 * fades from when it was replaced: the time of the user's next message, or for things after
 * the latest answer, the next item's time; never from before `restoredAt` (the last scroll up).
 */
export function fadeLevels(items: readonly ChatItem[], now: number, restoredAt = 0): Map<string, number> {
  const out = new Map<string, number>();
  let lastUser = -1;
  items.forEach((i, at) => {
    if (i.kind === 'user') lastUser = at;
  });
  // A chat without a message from the user (the greeting, a brief) has nothing older to fade.
  if (lastUser === -1) return out;
  let answer = -1;
  for (let at = items.length - 1; at > lastUser; at--) {
    if (items[at]!.kind === 'assistant') {
      answer = at;
      break;
    }
  }
  const solidTo = answer === -1 ? items.length - 1 : answer;
  // Walk back, remembering when the next user message came.
  let nextAsk = 0;
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!;
    const replaced = at > solidTo ? items[at + 1]?.at : at < lastUser ? nextAsk : undefined;
    if (item.kind === 'user') nextAsk = item.at;
    if (replaced === undefined || at === items.length - 1 || needsYou(item)) continue;
    const steps = idleSteps(now - Math.max(replaced, restoredAt));
    if (steps > 0) out.set(item.id, Math.max(FADE_FLOOR, Number((FADE_FIRST - FADE_STEP * (steps - 1)).toFixed(2))));
  }
  return out;
}
