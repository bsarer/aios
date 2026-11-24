import { useEffect, useRef, useState } from 'react';
import { idleSteps } from './fade';

/** What counts as the user being here: any of these, anywhere in the chat window. */
const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll', 'focusin'] as const;

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
    const tick = () => setSteps(idleSteps(Date.now() - last.current));
    // Capture: scrolling happens on the chat's own scroller, which doesn't bubble to window.
    for (const e of ACTIVITY) window.addEventListener(e, active, { capture: true, passive: true });
    const t = window.setInterval(tick, 10_000);
    return () => {
      for (const e of ACTIVITY) window.removeEventListener(e, active, { capture: true });
      window.clearInterval(t);
    };
  }, [enabled]);
  return steps;
}
