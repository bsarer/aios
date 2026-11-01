/**
 * Every piece of email-derived text goes through sanitize() and is wrapped with
 * wrapUntrusted() before it reaches a model (CLAUDE.md). A0/A1 version: plain
 * text extraction, invisible-character removal, tag neutralisation and size caps.
 * A4 extends the HTML handling (hidden elements, tracking pixels).
 */

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤⁦-⁯﻿­]/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export interface SanitizeOptions {
  /** Maximum characters kept. Default 8000. */
  maxChars?: number;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith('#x') || e.startsWith('#X')) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
      if (e.startsWith('#')) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Turn untrusted email content into bounded plain text that cannot fake our markup. */
export function sanitize(input: { text?: string | undefined; html?: string | undefined }, opts: SanitizeOptions = {}): string {
  const max = opts.maxChars ?? 8000;
  let s = input.text ?? (input.html ? htmlToText(input.html) : '');
  s = s.normalize('NFKC').replace(ZERO_WIDTH, '');
  // Neutralise anything that looks like our own wrapper or a role tag.
  s = s.replace(/<\s*\/?\s*(untrusted|system|assistant|user|tool|developer)\b[^>]*>/gi, (m) => m.replace(/</g, '‹').replace(/>/g, '›'));
  // eslint-style control chars except \n and \t.
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = `${s.slice(0, max)}\n[truncated ${s.length - max} chars]`;
  return s;
}

const attr = (v: string) => v.replace(/[^A-Za-z0-9._:@-]/g, '_');

/**
 * 'calendar' (C1): event text, which anyone who sends the user an invite can write.
 * 'document' (D1): text, cells, sheet and file names from a Word or Excel file, which can come from anywhere.
 */
export function wrapUntrusted(source: 'email' | 'calendar' | 'document', id: string, sanitized: string): string {
  return `<untrusted source="${source}" id="${attr(id)}">\n${sanitized}\n</untrusted>`;
}

/**
 * A file or folder name shown to the model outside an <untrusted> wrapper (in "x.pdf (PDF, 2 KB)."
 * lines and errors). Names come from anywhere, so tags in them are neutralised and line breaks
 * and control characters dropped; otherwise the name is kept exact so it can be passed back.
 */
export function nameText(name: string): string {
  return name
    .replace(/<\s*\/?\s*(untrusted|system|assistant|user|tool|developer)\b[^>]*>/gi, (m) => m.replace(/</g, '‹').replace(/>/g, '›'))
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .slice(0, 1000);
}
