import { FOCUS_LABELS, FOCUS_SOUNDS, type Focus, type FocusSound } from '@aios/shared/protocol';
import { Icon } from './ui';

/**
 * Focus sounds: one calm line above the message box while a sound plays, so it is always clear
 * that one is on, even without the Focus tile pinned. It names the sound and the volume, and its
 * small buttons switch to another sound or stop it: each sends only a sound name (or null), like a
 * click on the tile's panel. Nothing shows while no sound plays.
 */
export function FocusLine({ focus, disabled, onFocus }: { focus: Focus | null; disabled: boolean; onFocus: (change: { sound: FocusSound | null }) => void }) {
  if (!focus?.sound) return null;
  const playing = focus.sound;
  const others = FOCUS_SOUNDS.filter((s) => s !== playing);
  return (
    <div data-testid="focus-line" data-sound={playing} role="status" aria-label={`Focus sound: ${FOCUS_LABELS[playing]} at ${focus.volume}%`} className="focus-line mx-auto flex w-[min(760px,calc(100%-24px))] flex-wrap items-center justify-center gap-x-2 gap-y-1 pb-1.5 text-[13px]">
      <span className="focus-bars shrink-0" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="shrink-0" style={{ color: 'var(--accent)' }}>
        <Icon name="headphones" size={13} />
      </span>
      <span>
        {FOCUS_LABELS[playing]} · {focus.volume}%
      </span>
      <span aria-hidden="true">·</span>
      {others.map((s) => (
        <button key={s} type="button" data-testid="focus-line-switch" data-sound={s} disabled={disabled} onClick={() => onFocus({ sound: s })} className="focus-line-btn">
          {FOCUS_LABELS[s]}
        </button>
      ))}
      <button type="button" data-testid="focus-line-stop" disabled={disabled} onClick={() => onFocus({ sound: null })} className="focus-line-btn">
        Stop
      </button>
    </div>
  );
}
