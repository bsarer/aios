import type { ChatItem } from '@aios/shared/protocol';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type DocumentItem = Extract<ChatItem, { kind: 'document' }>;

interface SheetView {
  sheets: { name: string; rows: string[][] }[];
  moreSheets: number;
  rows: number;
  cols: number;
}

type View = { state: 'loading' } | { state: 'error'; text: string } | { state: 'pdf'; note: string } | { state: 'sheet'; view: SheetView };

const isSheetView = (v: unknown): v is SheetView =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as SheetView).sheets) &&
  (v as SheetView).sheets.every((s) => typeof s?.name === 'string' && Array.isArray(s.rows) && s.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')));

const letters = (n: number) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

/**
 * Full-screen viewer for a Word or Excel file (D1). A Word file arrives as a PDF that
 * WordCraft made and is drawn on canvases like a PDF attachment (pdf.ts). A workbook
 * arrives as cells and is drawn as a plain table: every cell is text, nothing in it runs.
 * Esc closes it.
 */
export function DocumentViewer({ item, onClose }: { item: DocumentItem; onClose: () => void }) {
  const [view, setView] = useState<View>({ state: 'loading' });
  const [sheet, setSheet] = useState(0);
  const pages = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`/documents/${encodeURIComponent(item.id)}`, { signal: ac.signal, credentials: 'same-origin' });
        if (!res.ok) {
          setView({ state: 'error', text: res.status === 404 ? 'That document card is no longer here.' : (await res.text()).slice(0, 300) });
          return;
        }
        const type = res.headers.get('content-type') ?? '';
        if (type === 'application/pdf') {
          const data = await res.arrayBuffer();
          setView({ state: 'pdf', note: 'Loading…' });
          await new Promise((r) => requestAnimationFrame(r));
          if (!pages.current || ac.signal.aborted) return;
          const { renderPdf } = await import('../pdf');
          const { pages: total, shown } = await renderPdf(data, pages.current, ac.signal);
          setView({ state: 'pdf', note: shown < total ? `Showing the first ${shown} of ${total} pages.` : '' });
        } else if (type.startsWith('application/json')) {
          const v: unknown = await res.json();
          if (isSheetView(v)) setView({ state: 'sheet', view: v });
          else setView({ state: 'error', text: "This file can't be shown here." });
        } else {
          setView({ state: 'error', text: "This file can't be shown here." });
        }
      } catch {
        if (!ac.signal.aborted) setView({ state: 'error', text: "I couldn't open this file. Try again in a moment." });
      }
    })();
    return () => ac.abort();
  }, [item.id]);

  const current = view.state === 'sheet' ? view.view.sheets[sheet] : undefined;
  const width = current ? Math.max(0, ...current.rows.map((r) => r.length)) : 0;

  return createPortal(
    <div data-testid="document-viewer" data-state={view.state} role="dialog" aria-label={item.name} className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
      <div className="glass flex items-center gap-3 px-4 py-2">
        <div className="flex-1 truncate font-medium">{item.name}</div>
        <button type="button" data-testid="document-close" className="glass rounded-lg px-3 py-1" onClick={onClose}>
          Close
        </button>
      </div>
      {view.state === 'sheet' && view.view.sheets.length > 1 && (
        <div className="flex gap-2 overflow-x-auto px-4 pt-2" role="tablist">
          {view.view.sheets.map((s, i) => (
            <button key={i} type="button" role="tab" aria-selected={i === sheet} data-testid="document-sheet-tab" className="glass whitespace-nowrap rounded-lg px-3 py-1 text-sm" style={i === sheet ? { background: 'var(--accent)', color: 'var(--bg)' } : {}} onClick={() => setSheet(i)}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-auto p-4">
        {view.state === 'loading' && <div style={{ color: 'var(--muted)' }}>Opening…</div>}
        {view.state === 'error' && (
          <div data-testid="document-error" style={{ color: 'var(--danger)' }}>
            {view.text}
          </div>
        )}
        {view.state === 'pdf' && view.note && (
          <div className="mb-2 text-center text-sm" style={{ color: 'var(--muted)' }}>
            {view.note}
          </div>
        )}
        <div ref={pages} data-testid="document-pages" className="mx-auto max-w-[900px]" hidden={view.state !== 'pdf'} />
        {current && (
          <>
            <table data-testid="document-sheet" className="border-collapse text-sm">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: width }, (_, c) => (
                    <th key={c} className="px-2 py-1 font-normal" style={{ color: 'var(--muted)' }}>
                      {letters(c + 1)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {current.rows.map((r, i) => (
                  <tr key={i}>
                    <th className="px-2 py-1 text-right font-normal" style={{ color: 'var(--muted)' }}>
                      {i + 1}
                    </th>
                    {Array.from({ length: width }, (_, c) => (
                      <td key={c} className="whitespace-pre px-2 py-1" style={{ border: '1px solid var(--border, rgba(127,127,127,0.3))' }}>
                        {r[c] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
              Showing up to {view.state === 'sheet' ? `${view.view.rows} rows and ${view.view.cols} columns` : ''}
              {view.state === 'sheet' && view.view.moreSheets ? `, and the first ${view.view.sheets.length} sheets (${view.view.moreSheets} more not shown)` : ''}. Open it in GridCraft to see everything.
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
