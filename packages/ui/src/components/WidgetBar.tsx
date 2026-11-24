import { FOCUS_LABELS, FOCUS_SOUNDS, type Focus, type FocusSound, WIDGET_KINDS, type WidgetKind, type Widgets } from '@aios/shared/protocol';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './ui';

const TITLES: Record<WidgetKind, string> = { checkup: 'Checkup', brief: 'Today', todos: 'To-dos', focus: 'Focus' };
// Drawn icons, not text characters: ☑ and ☀ came from the emoji font on some systems and looked out of place.
const ICONS: Record<WidgetKind, IconName> = { checkup: 'gauge', brief: 'sun', todos: 'checkbox', focus: 'headphones' };
const hue = (tone: 'normal' | 'attention' | 'off') => (tone === 'attention' ? 'var(--warning)' : 'var(--accent)');

/**
 * W1: pinned system features as compact buttons along the bottom of the chat screen, as wide as
 * the chat column. Only the name shows (and an amber dot when something wants a look); a click
 * opens the full card in the chat. × unpins (right-click shows it too), + pins another.
 * The Focus tile instead opens a small panel above it: the three sounds, Stop and a volume slider.
 */
export function WidgetBar({
  widgets,
  focus,
  onFocus,
  disabled,
  onOpen,
  onPin,
}: {
  widgets: Widgets | null;
  focus: Focus | null;
  onFocus: (change: { sound?: FocusSound | null; volume?: number }) => void;
  disabled: boolean;
  onOpen: (w: WidgetKind) => void;
  onPin: (w: WidgetKind, pinned: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<WidgetKind | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  if (!widgets) return null;
  const free = WIDGET_KINDS.filter((k) => !widgets.pinned.includes(k));
  const tileFor = (k: WidgetKind) => widgets.tiles.find((t) => t.widget === k);

  return (
    <nav data-testid="widgets" aria-label="Pinned widgets" className="mx-auto mb-4 flex w-[min(760px,calc(100%-24px))] items-stretch gap-2">
      {widgets.pinned.map((k) => {
        const t = tileFor(k);
        const tone = t?.tone ?? 'normal';
        return (
          <div
            key={k}
            data-testid="widget"
            data-widget={k}
            data-tone={tone}
            className="group glass relative flex-1 rounded-xl"
            style={{
              opacity: tone === 'off' ? 0.55 : 1,
              // Colour from the Omarchy theme: the accent, or amber when something wants a look.
              background: tone === 'off' ? undefined : `color-mix(in srgb, ${hue(tone)} 14%, var(--panel))`,
              borderColor: tone === 'off' ? undefined : `color-mix(in srgb, ${hue(tone)} 40%, transparent)`,
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(menuFor === k ? null : k);
            }}
          >
            {k === 'focus' && focusOpen && <FocusPanel focus={focus} disabled={disabled} onFocus={onFocus} onClose={() => setFocusOpen(false)} />}
            <button type="button" data-testid="widget-open" disabled={disabled || tone === 'off'} onClick={() => (k === 'focus' ? setFocusOpen(!focusOpen) : onOpen(k))} className="flex w-full items-center justify-center gap-2 px-3 py-2 text-[15px] font-medium disabled:cursor-default" title={tone === 'off' ? (t?.lines[0] ?? '') : `Open ${TITLES[k]}`}>
              <span aria-hidden className="inline-flex" style={{ color: tone === 'off' ? undefined : hue(tone) }}>
                <Icon name={ICONS[k]} size={17} />
              </span>
              {t?.title ?? TITLES[k]}
              {k === 'focus' && focus?.sound && (
                <span data-testid="focus-now" className="text-[13px] font-normal" style={{ color: 'var(--muted)' }}>
                  {FOCUS_LABELS[focus.sound]}
                </span>
              )}
              {tone === 'attention' && <span data-testid="widget-dot" aria-label="needs a look" className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--warning)', boxShadow: '0 0 6px var(--warning)' }} />}
            </button>
            <button
              type="button"
              data-testid="widget-unpin"
              aria-label={`Unpin ${TITLES[k]}`}
              title="Unpin"
              disabled={disabled}
              onClick={() => {
                setMenuFor(null);
                onPin(k, false);
              }}
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1.5 text-sm leading-5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-70 ${menuFor === k ? 'opacity-100' : ''}`}
              style={{ color: 'var(--muted)' }}
            >
              ×
            </button>
          </div>
        );
      })}
      {free.length > 0 && (
        <div className="relative flex items-center">
          <button
            type="button"
            data-testid="widget-add"
            aria-label="Pin a widget"
            title="Pin a widget"
            disabled={disabled}
            onClick={() => setAdding(!adding)}
            className="glass h-full rounded-xl px-3.5 text-lg disabled:opacity-40"
            style={{ color: 'var(--muted)' }}
          >
            +
          </button>
          {adding && (
            <div data-testid="widget-menu" className="glass absolute bottom-full right-0 mb-2 flex flex-col rounded-xl p-1 text-[15px]" style={{ background: 'var(--bg)' }}>
              {free.map((k) => (
                <button
                  key={k}
                  type="button"
                  data-testid="widget-pin"
                  data-widget={k}
                  className="whitespace-nowrap rounded-lg px-3 py-1 text-left hover:bg-[var(--panel)]"
                  onClick={() => {
                    setAdding(false);
                    onPin(k, true);
                  }}
                >
                  <span aria-hidden className="mr-1.5 inline-flex align-[-3px]" style={{ color: 'var(--accent)' }}>
                    <Icon name={ICONS[k]} size={16} />
                  </span>
                  Pin {TITLES[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

/**
 * The Focus tile's panel: the three sounds, Stop, and the volume. Each click sends only a sound
 * name or a number; core keeps the state and every open chat plays it. The slider sends once it
 * rests for a moment, so dragging doesn't send dozens of changes.
 */
function FocusPanel({ focus, disabled, onFocus, onClose }: { focus: Focus | null; disabled: boolean; onFocus: (change: { sound?: FocusSound | null; volume?: number }) => void; onClose: () => void }) {
  const [volume, setVolume] = useState(focus?.volume ?? 40);
  const timer = useRef<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus && timer.current === undefined) setVolume(focus.volume);
  }, [focus]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A click anywhere else, or Esc, closes it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const tile = box.current?.parentElement;
      if (tile && !tile.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const playing = focus?.sound ?? null;
  return (
    <div ref={box} data-testid="focus-panel" role="dialog" aria-label="Focus sounds" className="glass absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-xl p-3 text-[15px]" style={{ background: 'var(--bg)' }}>
      <div className="mb-2 text-[13px]" style={{ color: 'var(--muted)' }}>
        A calm sound while you work
      </div>
      <div className="flex flex-col gap-1">
        {FOCUS_SOUNDS.map((s) => (
          <button
            key={s}
            type="button"
            data-testid="focus-sound"
            data-sound={s}
            aria-pressed={playing === s}
            disabled={disabled}
            onClick={() => onFocus({ sound: s })}
            className="flex items-center justify-between rounded-lg px-3 py-1.5 text-left hover:bg-[var(--panel)] disabled:opacity-40"
            style={playing === s ? { background: 'color-mix(in srgb, var(--accent) 18%, transparent)' } : undefined}
          >
            {FOCUS_LABELS[s]}
            {playing === s && (
              <span className="text-[13px]" style={{ color: 'var(--accent)' }}>
                Playing
              </span>
            )}
          </button>
        ))}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[13px]" style={{ color: 'var(--muted)' }}>
        Volume
        <input
          type="range"
          data-testid="focus-volume"
          min={0}
          max={100}
          step={1}
          value={volume}
          disabled={disabled}
          aria-label="Focus sound volume"
          className="flex-1"
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => {
            const v = Number(e.target.value);
            setVolume(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              timer.current = undefined;
              onFocus({ volume: v });
            }, 200);
          }}
        />
        <span className="w-9 text-right tabular-nums">{volume}%</span>
      </label>
      <button type="button" data-testid="focus-stop" disabled={disabled || !playing} onClick={() => onFocus({ sound: null })} className="btn btn-sm mt-3 w-full disabled:opacity-40">
        Stop
      </button>
    </div>
  );
}
