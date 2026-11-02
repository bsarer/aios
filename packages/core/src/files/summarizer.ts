/**
 * The file summary worker (F2): one structured call per file, describing it in a sentence or
 * two with search keywords. Like the triage worker it has no tools, by construction: the
 * request it builds has no `tools` field and the model client it gets can only make
 * structured calls. The file's name, facts and excerpt reach the model sanitized and wrapped
 * in <untrusted source="document">. Its answer is stored, never acted on, and is shown again
 * only inside a wrapper, because it was written from a file that can come from anyone.
 */
import type { ModelRole } from '@aios/shared';
import { z } from 'zod';
import type { ModelClient, ModelRequest } from '../model.js';
import { FILE_SUMMARY_SYSTEM_PROMPT } from '../prompts.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';
import type { FileFacts } from './catalog.js';
import { EXCERPT_CHARS } from './facts.js';
import { KIND_TEXT, type FileKind } from './roots.js';

export type SummaryModel = Pick<ModelClient, 'structured'>;

export const FileSummary = z.strictObject({
  summary: z.string().min(1).max(600),
  keywords: z.array(z.string().min(1).max(60)).max(12),
});
export type FileSummary = z.infer<typeof FileSummary>;

export interface SummaryInput {
  display: string;
  kind: FileKind;
  facts: FileFacts;
  excerpt: string;
}

export function factsText(kind: FileKind, f: FileFacts): string {
  return [
    `Type: ${KIND_TEXT[kind]}`,
    f.title ? `Title: ${f.title}` : '',
    f.author ? `Author: ${f.author}` : '',
    f.pages ? `Pages: ${f.pages}` : '',
    f.sheets?.length ? `Sheets: ${f.sheets.join(', ')}` : '',
    f.words ? `Words: ${f.words}` : '',
    f.width && f.height ? `Size: ${f.width}×${f.height}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** `role` is 'triage', or 'local' when assistant.localTasks lists fileSummaries (L1). */
export function summaryRequest(file: SummaryInput, role: ModelRole = 'triage'): ModelRequest {
  const body = `File: ${file.display}\n${factsText(file.kind, file.facts)}\n\nStart of the file:\n${file.excerpt}`;
  return {
    role,
    messages: [
      { role: 'system', content: FILE_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: `Describe this file.\n\n${wrapUntrusted('document', file.display, sanitize({ text: body }, { maxChars: EXCERPT_CHARS + 1200 }))}` },
    ],
  };
}

/** The model's description, cleaned for storage: plain text, short, no markup. */
export async function summarizeFile(model: SummaryModel, file: SummaryInput, role: ModelRole = 'triage'): Promise<FileSummary> {
  const { value } = await model.structured(summaryRequest(file, role), 'file_summary', FileSummary);
  const clean = (s: string, n: number) => sanitize({ text: s }, { maxChars: n }).replace(/\s+/g, ' ').trim();
  return {
    summary: clean(value.summary, 400),
    keywords: [...new Set(value.keywords.map((k) => clean(k, 40).toLowerCase()).filter(Boolean))].slice(0, 10),
  };
}
