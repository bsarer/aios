/**
 * L1: the local model's two jobs for the system assistant, each one structured call on the
 * 'local' role. Like the triage and file summary workers it has no tools, by construction:
 * the requests have no `tools` field and the client it gets can only make structured calls.
 *
 * Process names, file names and window titles reach it sanitized inside <untrusted>
 * wrappers. Its answers are short plain text, cleaned before they are stored, and it can only
 * name candidates by the ids code gave it; buttons are always made by code.
 */
import { z } from 'zod';
import type { ModelClient, ModelRequest } from '../model.js';
import { CLEANUP_REVIEW_SYSTEM_PROMPT, RESOURCE_ADVICE_SYSTEM_PROMPT } from '../prompts.js';
import { sanitize, wrapUntrusted } from '../untrusted.js';

export type LocalModel = Pick<ModelClient, 'structured'>;

/** Plain, single-line, short: model text that is only ever displayed. */
export function cleanLine(s: string, max: number): string {
  return sanitize({ text: s }, { maxChars: max * 2 })
    .replace(/[<>`*_#[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ── Resource advice ──

export const ResourceAdvice = z.strictObject({ advice: z.string().min(1).max(600) });

export interface AdviceInput {
  resource: 'disk' | 'memory' | 'cpu';
  /** Written by code: the numbers. */
  facts: string;
  /** Process names with their share, e.g. "firefox: 3.1 GB". */
  top: string[];
}

export function adviceRequest(input: AdviceInput): ModelRequest {
  const top = input.top.length ? wrapUntrusted('system', 'processes', sanitize({ text: input.top.join('\n') }, { maxChars: 1500 })) : '(none listed)';
  return {
    role: 'local',
    messages: [
      { role: 'system', content: RESOURCE_ADVICE_SYSTEM_PROMPT },
      { role: 'user', content: `Resource: ${input.resource}\n${input.facts}\n\nBiggest users:\n${top}` },
    ],
  };
}

export async function resourceAdvice(model: LocalModel, input: AdviceInput): Promise<string> {
  const { value } = await model.structured(adviceRequest(input), 'resource_advice', ResourceAdvice);
  return cleanLine(value.advice, 300);
}

// ── Morning review ──

export const CleanupPicks = z.strictObject({
  intro: z.string().max(400),
  files: z.array(z.strictObject({ id: z.string().max(20), reason: z.string().max(400) })).max(40),
  apps: z.array(z.strictObject({ id: z.string().max(20), reason: z.string().max(400) })).max(40),
});
export type CleanupPicks = z.infer<typeof CleanupPicks>;

export interface FileCandidate {
  id: string;
  /** "~/Downloads/x.iso". */
  display: string;
  size: string;
  lastUsed: string;
}

export interface AppCandidate {
  id: string;
  name: string;
  title: string;
  memory: string;
  idle: string;
}

export function reviewRequest(files: FileCandidate[], apps: AppCandidate[], limits: { files: number; apps: number }): ModelRequest {
  const fileText = files.map((f) => `${f.id}: ${f.display} (${f.size}, ${f.lastUsed})`).join('\n');
  const appText = apps.map((a) => `${a.id}: ${a.name} "${a.title}" (${a.memory}, ${a.idle})`).join('\n');
  return {
    role: 'local',
    messages: [
      { role: 'system', content: CLEANUP_REVIEW_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          `Pick at most ${limits.files} files and ${limits.apps} windows.`,
          '',
          'Files:',
          files.length ? wrapUntrusted('system', 'files', sanitize({ text: fileText }, { maxChars: 6000 })) : '(none)',
          '',
          'Windows:',
          apps.length ? wrapUntrusted('system', 'windows', sanitize({ text: appText }, { maxChars: 4000 })) : '(none)',
        ].join('\n'),
      },
    ],
  };
}

/** The model's picks, kept to known ids (each once) and the limits, with reasons cleaned. */
export async function reviewPicks(
  model: LocalModel,
  files: FileCandidate[],
  apps: AppCandidate[],
  limits: { files: number; apps: number },
): Promise<{ intro: string; files: Map<string, string>; apps: Map<string, string> }> {
  const { value } = await model.structured(reviewRequest(files, apps, limits), 'cleanup_review', CleanupPicks);
  const keep = (picks: CleanupPicks['files'], known: Set<string>, max: number) => {
    const out = new Map<string, string>();
    for (const p of picks) {
      if (out.size >= max) break;
      if (known.has(p.id) && !out.has(p.id)) out.set(p.id, cleanLine(p.reason, 120));
    }
    return out;
  };
  return {
    intro: cleanLine(value.intro, 200),
    files: keep(value.files, new Set(files.map((f) => f.id)), limits.files),
    apps: keep(value.apps, new Set(apps.map((a) => a.id)), limits.apps),
  };
}
