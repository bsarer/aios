import { WIDGET_KINDS, type WidgetKind, type Widgets } from '@aios/shared/protocol';
import { useState } from 'react';

const TITLES: Record<WidgetKind, string> = { checkup: 'Checkup', brief: 'Today', todos: 'To-dos' };
const ICONS: Record<WidgetKind, string> = { checkup: '🩺', brief: '☀', todos: '☑' };

/**
 * W1: pinned system features as compact buttons along the bottom of the chat screen, as wide as
 * the chat column. Only the name shows (and an amber dot when something wants a look); a click
 * opens the full card in the chat. × unpins (right-click shows it too), + pins another.
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
    <nav data-testid="widgets" aria-label="Pinned widgets" className="mx-auto mb-4 flex w-[min(820px,calc(100%-24px))] items-stretch gap-2">
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
            style={{ opacity: tone === 'off' ? 0.55 : 1 }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(menuFor === k ? null : k);
            }}
          >
            <button type="button" data-testid="widget-open" disabled={disabled || tone === 'off'} onClick={() => onOpen(k)} className="flex w-full items-center justify-center gap-2 px-3 py-2 text-[15px] font-medium disabled:cursor-default" title={tone === 'off' ? (t?.lines[0] ?? '') : `Open ${TITLES[k]}`}>
              <span aria-hidden>{ICONS[k]}</span>
              {t?.title ?? TITLES[k]}
              {tone === 'attention' && <span data-testid="widget-dot" aria-label="needs a look" className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--warning)' }} />}
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
