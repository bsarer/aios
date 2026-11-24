import { type RefObject, useEffect, useState } from 'react';

/**
 * The clock the fade reads (fade.ts), and when the user last brought the chat back. Only
 * scrolling up the chat brings it back: the wheel or a touchpad going up, or the chat's scroller
 * moving up (keys, the scrollbar, touch). Typing, clicking and moving the mouse don't, and the
 * chat scrolling itself down to something new doesn't either. While `enabled` is false nothing
 * is watched.
 */
export function useFadeClock(enabled: boolean, scroller: RefObject<HTMLElement | null>): { now: number; restoredAt: number } {
  const [now, setNow] = useState(() => Date.now());
  const [restoredAt, setRestoredAt] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!enabled || !el) return;
    const restore = () => {
      const t = Date.now();
      setRestoredAt(t);
      setNow(t);
    };
    let top = el.scrollTop;
    const scrolled = () => {
      if (el.scrollTop < top - 2) restore();
      top = el.scrollTop;
    };
    // Going up even when there is nothing more above counts: the user asked to see the past.
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0) restore();
    };
    el.addEventListener('scroll', scrolled, { passive: true });
    el.addEventListener('wheel', wheel, { passive: true });
    const t = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      el.removeEventListener('scroll', scrolled);
      el.removeEventListener('wheel', wheel);
      window.clearInterval(t);
    };
  }, [enabled, scroller]);
  return { now, restoredAt };
}
