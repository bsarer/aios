import type { ChatItem } from '@aios/shared/protocol';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type AttachmentItem = Extract<ChatItem, { kind: 'attachment' }>;

type View = { state: 'loading' } | { state: 'error'; text: string } | { state: 'image'; url: string } | { state: 'text'; text: string } | { state: 'pdf'; note: string };

/**
 * Full-screen viewer for an email attachment (S2). The file comes from this computer's own
 * service, which checked that it really is a PDF, text file or picture. Text is shown as
 * plain text, pictures as an <img> from a blob, PDFs as canvases (pdf.ts). Esc closes it.
 */
export function AttachmentViewer({ item, onClose }: { item: AttachmentItem; onClose: () => void }) {
  const [view, setView] = useState<View>({ state: 'loading' });
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
    let blobUrl = '';
    void (async () => {
      try {
        const res = await fetch(`/attachments/${encodeURIComponent(item.id)}`, { signal: ac.signal, credentials: 'same-origin' });
        if (!res.ok) {
          setView({ state: 'error', text: res.status === 404 ? 'That attachment is no longer in your mailbox.' : (await res.text()).slice(0, 300) });
          return;
        }
        const type = res.headers.get('content-type') ?? '';
        if (type.startsWith('image/')) {
          blobUrl = URL.createObjectURL(await res.blob());
          setView({ state: 'image', url: blobUrl });
        } else if (type.startsWith('text/plain')) {
          setView({ state: 'text', text: await res.text() });
        } else if (type === 'application/pdf') {
          const data = await res.arrayBuffer();
          setView({ state: 'pdf', note: 'Loading…' });
          // Wait a frame so the page container exists and has its width.
          await new Promise((r) => requestAnimationFrame(r));
          if (!pages.current || ac.signal.aborted) return;
          const { renderPdf } = await import('../pdf');
          const { pages: total, shown } = await renderPdf(data, pages.current, ac.signal);
          setView({ state: 'pdf', note: shown < total ? `Showing the first ${shown} of ${total} pages.` : '' });
        } else {
          setView({ state: 'error', text: "This file can't be shown here." });
        }
      } catch {
        if (!ac.signal.aborted) setView({ state: 'error', text: "I couldn't open this file. Try again in a moment." });
      }
    })();
    return () => {
      ac.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [item.id]);

  // A portal to <body>: inside a chat card, a blurred (backdrop-filter) ancestor would make
  // `fixed` position relative to the card instead of the screen.
  return createPortal(
    <div data-testid="attachment-viewer" data-state={view.state} role="dialog" aria-label={item.name} className="fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--bg)' }}>
      <div className="glass flex items-center gap-3 px-4 py-2">
        <div className="flex-1 truncate font-medium">{item.name}</div>
        <button type="button" data-testid="attachment-close" className="glass rounded-lg px-3 py-1" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {view.state === 'loading' && <div style={{ color: 'var(--muted)' }}>Opening…</div>}
        {view.state === 'error' && (
          <div data-testid="attachment-error" style={{ color: 'var(--danger)' }}>
            {view.text}
          </div>
        )}
        {view.state === 'image' && <img data-testid="attachment-image" src={view.url} alt={item.name} className="mx-auto max-h-full max-w-full object-contain" />}
        {view.state === 'text' && (
          <pre data-testid="attachment-text" className="mx-auto max-w-[900px] whitespace-pre-wrap break-words font-mono text-[15px]">
            {view.text}
          </pre>
        )}
        {view.state === 'pdf' && view.note && (
          <div className="mb-2 text-center text-sm" style={{ color: 'var(--muted)' }}>
            {view.note}
          </div>
        )}
        <div ref={pages} data-testid="attachment-pages" className="mx-auto max-w-[900px]" hidden={view.state !== 'pdf'} />
      </div>
    </div>,
    document.body,
  );
}
