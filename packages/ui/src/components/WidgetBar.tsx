import { WIDGET_KINDS, type WidgetKind, type Widgets } from '@aios/shared/protocol';
import { useState } from 'react';

const TITLES: Record<WidgetKind, string> = { checkup: 'Checkup', brief: 'Today', todos: 'To-dos' };
const ICONS: Record<WidgetKind, string> = { checkup: '🩺', brief: '☀', todos: '☑' };

/**
 * W1: pinned system features as tiles along the bottom of the chat screen. A click opens the
 * full card in the chat; × unpins (right-click shows it too), + pins another. Everything on a tile
 * was written by code (the to-do tile shows the user's own items) and is shown as plain text.
 */
export function WidgetBar({
  widgets,
  disabled,
  onOpen,
  onPin,
}: {
  widgets: Widgets | null;
  disabled: boolean;
  onOpen: (w: WidgetKind) => void;
  onPin: (w: WidgetKind, pinned: boolean) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [menuFor, setMenuFor] = useState<WidgetKind | null>(null);
  if (!widgets) return null;
  const free = WIDGET_KINDS.filter((k) => !widgets.pinned.includes(k));
  const tileFor = (k: WidgetKind) => widgets.tiles.find((t) => t.widget === k);

  return (
    <nav data-testid="widgets" aria-label="Pinned widgets" className="mx-auto mb-3 flex w-[min(960px,calc(100%-24px))] flex-wrap items-stretch justify-center gap-3">
      {widgets.pinned.map((k) => {
        const t = tileFor(k);
        const tone = t?.tone ?? 'normal';
        const edge = tone === 'attention' ? 'var(--warning)' : tone === 'off' ? 'var(--border)' : 'var(--accent)';
        return (
          <div
            key={k}
            data-testid="widget"
            data-widget={k}
            data-tone={tone}
            className="group glass relative min-w-[180px] max-w-[300px] flex-1 rounded-xl"
            style={{ borderTop: `3px solid ${edge}`, opacity: tone === 'off' ? 0.6 : 1 }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(menuFor === k ? null : k);
            }}
          >
            <button type="button" data-testid="widget-open" disabled={disabled || tone === 'off'} onClick={() => onOpen(k)} className="block w-full px-3 py-2 text-left disabled:cursor-default" title={`Open ${TITLES[k]}`}>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span aria-hidden>{ICONS[k]}</span>
                {t?.title ?? TITLES[k]}
                {tone === 'attention' && <span aria-label="needs a look" className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} />}
              </div>
              <ul className="mt-0.5 text-[13px] leading-snug" style={{ color: 'var(--muted)' }}>
                {(t?.lines ?? ['…']).map((line, i) => (
                  <li key={i} data-testid="widget-line" className="truncate">
                    {line}
                  </li>
                ))}
              </ul>
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
              className={`absolute right-1.5 top-1 rounded px-1.5 text-sm leading-5 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-70 ${menuFor === k ? 'opacity-100' : ''}`}
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
            className="glass h-full min-h-[44px] rounded-xl px-3 text-lg disabled:opacity-40"
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
                  {ICONS[k]} Pin {TITLES[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
