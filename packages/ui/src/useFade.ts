import { useEffect, useRef, useState } from 'react';
import { idleSteps } from './fade';

/**
 * What counts as the user being here: keys, clicks, touch, the wheel, and a pointer that really
 * moves. Not focus or scroll events: the message box takes focus again whenever the chat's
 * window comes back, and the chat scrolls by itself when something new arrives, so either would
 * bring everything back before the user could see it calm.
 */
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
/** A pointer has to travel this far (px) to count; entering the window or a jitter doesn't. */
const MOVE_PX = 8;

/**
 * How many fade steps the chat's idle time has reached (fade.ts). Any activity puts it back to 0
 * at once. Always 0 while `enabled` is false.
 */
export function useFadeSteps(enabled: boolean): number {
  const [steps, setSteps] = useState(0);
  const last = useRef(Date.now());
  useEffect(() => {
    if (!enabled) {
      setSteps(0);
      return;
    }
    last.current = Date.now();
    const active = () => {
      last.current = Date.now();
      setSteps(0);
    };
    let from: { x: number; y: number } | null = null;
    const moved = (e: PointerEvent) => {
      if (from === null) {
        from = { x: e.clientX, y: e.clientY };
        return;
      }
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < MOVE_PX) return;
      from = { x: e.clientX, y: e.clientY };
      active();
    };
    // The pointer's last spot is forgotten when it leaves, so coming back in starts a new count.
    const left = () => {
      from = null;
    };
    const tick = () => setSteps(idleSteps(Date.now() - last.current));
    // Capture, so a card that stops an event doesn't hide it.
    for (const e of ACTIVITY) window.addEventListener(e, active, { capture: true, passive: true });
    window.addEventListener('pointermove', moved, { capture: true, passive: true });
    document.documentElement.addEventListener('pointerleave', left);
    const t = window.setInterval(tick, 5_000);
    return () => {
      for (const e of ACTIVITY) window.removeEventListener(e, active, { capture: true });
      window.removeEventListener('pointermove', moved, { capture: true });
      document.documentElement.removeEventListener('pointerleave', left);
      window.clearInterval(t);
    };
  }, [enabled]);
  return steps;
}
