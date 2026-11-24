import type { Frames } from '@aios/shared/protocol';
import { useEffect, useState } from 'react';
import { FRAME_TILTS, frameSources } from '../frames';

/**
 * Photo frames: a few small photos standing in the space left of the chat, from the folder picked
 * in Settings. Each turns to another photo every few minutes with a slow cross-fade. They are
 * decoration only: nothing to click, nothing read out, and they step aside on narrow screens and
 * while the inbox is open (styles.css).
 */
export function PhotoFrames({ frames, hidden }: { frames: Frames; hidden: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!frames) return;
    const t = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(t);
  }, [frames]);
  const sources = frameSources(frames, now);
  if (!sources.length) return null;
  return (
    <div aria-hidden="true" data-testid="photo-frames" data-hidden={hidden ? 'true' : undefined} className="photo-frames" style={{ ['--n' as string]: sources.length }}>
      {sources.map((src, slot) => (
        <Frame key={slot} src={src} tilt={FRAME_TILTS[slot] ?? '0deg'} />
      ))}
    </div>
  );
}

/** One frame. The next photo is loaded first and faded in over the last one; a photo that fails keeps the last. */
function Frame({ src, tilt }: { src: string; tilt: string }) {
  const [layers, setLayers] = useState<{ back: string | null; front: string | null }>({ back: null, front: null });
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => live && setLayers((l) => (l.front === src ? l : { back: l.front, front: src }));
    img.src = src;
    return () => {
      live = false;
      img.onload = null;
    };
  }, [src]);
  if (!layers.front) return null;
  return (
    <figure data-testid="photo-frame" className="photo-frame" style={{ ['--tilt' as string]: tilt }}>
      <div className="photo">
        {layers.back && <img src={layers.back} alt="" draggable={false} />}
        <img key={layers.front} src={layers.front} alt="" draggable={false} className="photo-in" />
      </div>
    </figure>
  );
}
