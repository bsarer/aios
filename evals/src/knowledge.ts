/**
 * `pnpm --filter @aios/evals knowledge [--only model-id] [--repeat N]`
 *
 * Knowledge bake-off: the local model ([models.local], Ollama) against each cloud model in
 * evals/knowledge-models.toml, on the chat role's connection (OpenRouter and Astra's own key, only
 * the model swapped). Every model gets exactly the requests the knowledge base sends
 * (`mailRequest`, `chatRequest`, `calendarRequest` from core), so this measures the model with
 * today's prompt.
 *
 * Only invented items (`knowledge-fixtures.ts`): traps and real facts, checked by code. No real
 * mail is read. Report: evals/reports/<date>-knowledge.md and .json, safe to commit. Nothing is
 * written to the knowledge base, the ledger, memory or config, and the extractor has no tools:
 * only structured calls.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtractedNotes, Keyring, ModelClient, ModelError, type ModelRequest, calendarRequest, chatRequest, cleanExtracted, cleanPages, mailRequest } from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { FIXTURES, FIXTURE_USER, type Fixture, type FixtureItem } from './knowledge-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}


export interface Extraction {
  ok: boolean;
  error?: string;
  /** Notes as "[section] text", page facts as "Page name: fact". */
  lines: string[];
  ms: number;
  usd: number | null;
}

/** One structured call, cleaned the way the crawler cleans it. */
export async function extractOnce(client: ModelClient, req: ModelRequest): Promise<Extraction> {
  const started = performance.now();
  try {
    const { value, result } = await client.structured(req, 'knowledge_notes', ExtractedNotes);
    const notes = cleanExtracted(value).map((n) => `[${n.section}] ${n.text}`);
    const pages = cleanPages(value).flatMap((p) => [
      ...p.facts.map((f) => `${p.name} (${p.kind}): ${f}`),
      ...(p.links.length ? [`${p.name} (${p.kind}) links: ${p.links.map((l) => l.name).join(', ')}`] : []),
    ]);
    return { ok: true, lines: [...notes, ...pages], ms: Math.round(performance.now() - started), usd: result.usage?.costUsd ?? null };
  } catch (err) {
    const kind = err instanceof ModelError ? err.kind : 'error';
    return { ok: false, error: `${kind}: ${(err as Error).message.slice(0, 160)}`, lines: [], ms: Math.round(performance.now() - started), usd: null };
  }
}

function fixtureRequest(role: ModelRequest['role'], item: FixtureItem, n: number): ModelRequest {
  if (item.kind === 'chat') return chatRequest(role, FIXTURE_USER, item.lines);
  if (item.kind === 'calendar') return calendarRequest(role, FIXTURE_USER, item.lines);
  return mailRequest(role, FIXTURE_USER, { id: `fixture-${n}`, sentByUser: item.sentByUser, from: item.from, to: item.to, date: item.date, subject: item.subject, body: { text: item.text } });
}

export interface CheckResult {
  label: string;
  pass: boolean;
  /** The line that broke a forbid check. */
  culprit?: string | undefined;
}

export function grade(f: Fixture, lines: string[]): CheckResult[] {
  return f.checks.map((c) => {
    const scoped = c.about ? lines.filter((l) => c.about!.test(l)) : lines;
    if (c.forbid) {
      const bad = scoped.find((l) => c.forbid!.test(l));
      if (bad) return { label: c.label, pass: false, culprit: bad };
    }
    if (c.expect && !scoped.some((l) => c.expect!.test(l))) return { label: c.label, pass: false };
    return { label: c.label, pass: true };
  });
}

/** Relationship and liking words: when a note uses one the source doesn't, the model supplied it. */
const CLAIM_WORDS = /\b(sister|brother|sibling|mother|mom|mum|father|dad|cousin|aunt|uncle|niece|nephew|relative|wife|husband|spouse|daughter|son|colleague|co-?worker|teammate|manager|boss|friend|likes?|loves?|enjoys?|favou?rite|fan of|interested in)\b/gi;
const stem = (w: string) => w.toLowerCase().replace(/^co-?worker$/, 'coworker').replace(/s$/, '').replace(/^mum$/, 'mom');

/** The claim words in a line that never appear in the source text. */
export function unsupportedWords(line: string, source: string): string[] {
  const have = new Set([...source.matchAll(CLAIM_WORDS)].map((m) => stem(m[0])));
  return [...new Set([...line.matchAll(CLAIM_WORDS)].map((m) => stem(m[0])))].filter((w) => !have.has(w));
}

const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

/** Which OpenRouter ids exist now; null when the listing can't be read (then every id is tried). */
async function liveIds(baseUrl: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`);
    if (!res.ok) return null;
    const Listing = z.looseObject({ data: z.array(z.looseObject({ id: z.string() })) });
    return new Set(Listing.parse(await res.json()).data.map((d) => d.id));
  } catch {
    return null;
  }
}

const Candidates = z.strictObject({ cloud: z.array(z.strictObject({ model: z.string().min(1).max(200) })).min(1) });

interface Contender {
  label: string;
  client: ModelClient;
  role: ModelRequest['role'];
}

async function main(): Promise<void> {
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const only = flag('only');
  const config = parseConfig(await readFile(join(configDir(), 'config.toml'), 'utf8'));
  const keyring = new Keyring();
  const resolveKey = (ref: Parameters<Keyring['require']>[0]) => keyring.require(ref);
  const contenders: Contender[] = [];
  const skipped: string[] = [];

  // The local model, exactly as Astra calls it.
  if (config.models.local) contenders.push({ label: `local ${config.models.local.model}`, client: new ModelClient({ models: config.models, resolveKey }), role: 'local' });
  else skipped.push('local: no [models.local] in the config');

  // Each cloud model on the chat role's connection (OpenRouter, Astra's key), only the model swapped.
  const base = config.models.chat;
  const cands = Candidates.parse(parseToml(await readFile(join(here, '..', 'knowledge-models.toml'), 'utf8')));
  const live = await liveIds(base.baseUrl);
  for (const { model } of cands.cloud) {
    if (only && model !== only) continue;
    if (live && !live.has(model)) {
      skipped.push(`${model}: not in the provider's model list today`);
      continue;
    }
    const role = { ...base, model };
    contenders.push({ label: model, client: new ModelClient({ models: { ...config.models, chat: role, triage: role, nightly: role }, resolveKey }), role: 'nightly' });
  }
  console.log(`contenders:\n  ${contenders.map((c) => c.label).join('\n  ')}${skipped.length ? `\nskipped:\n  ${skipped.join('\n  ')}` : ''}\n`);

  const rows: { id: string; who: string; run: number; ex: Extraction; checks: CheckResult[] }[] = [];
  for (const c of contenders) {
    for (let r = 0; r < repeat; r++) {
      for (const [n, f] of FIXTURES.entries()) {
        // A refused key or missing credit won't change on the next item: stop this model.
        if (rows.some((x) => x.who === c.label && /^(auth|credits|forbidden|key_missing|not_configured):/.test(x.ex.error ?? ''))) break;
        const ex = await extractOnce(c.client, fixtureRequest(c.role, f.item, n));
        const checks = ex.ok ? grade(f, ex.lines) : f.checks.map((k) => ({ label: k.label, pass: false, culprit: ex.error }));
        rows.push({ id: f.id, who: c.label, run: r, ex, checks });
        console.log(`${c.label}  ${checks.every((k) => k.pass) ? 'PASS' : 'FAIL'}  ${f.id}  ${ex.ms} ms${ex.error ? `  ${ex.error}` : ''}`);
      }
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  const summary = contenders.map((c) => {
    const xs = rows.filter((x) => x.who === c.label);
    // Only answers count: a failed call is an error, not a guess.
    const answered = xs.filter((x) => x.ex.ok);
    const cs = answered.flatMap((x) => x.checks);
    const traps = answered.flatMap((x) => x.checks.filter((_k, i) => FIXTURES.find((f) => f.id === x.id)!.checks[i]!.forbid));
    const facts = answered.flatMap((x) => x.checks.filter((_k, i) => FIXTURES.find((f) => f.id === x.id)!.checks[i]!.expect));
    return {
      who: c.label,
      pass: cs.filter((k) => k.pass).length,
      total: cs.length,
      guesses: traps.filter((k) => !k.pass).length,
      traps: traps.length,
      facts: facts.filter((k) => k.pass).length,
      factTotal: facts.length,
      errors: xs.filter((x) => !x.ex.ok).length,
      avgMs: Math.round(sum(xs.map((x) => x.ex.ms)) / Math.max(1, xs.length)),
      usd: sum(xs.map((x) => x.ex.usd)),
    };
  });
  const md: string[] = [
    `# Knowledge bake-off, ${date}`,
    '',
    `Invented emails, chat and calendar only. Every model gets the knowledge base's own extraction request, unchanged. ${repeat} run${repeat > 1 ? 's' : ''}.`,
    '',
    '| Model | Checks passed (answered items) | Guesses stated as facts | Real facts kept | Failed calls | Avg time | Cost |',
    '|---|---|---|---|---|---|---|',
    ...summary.map((s) => `| \`${s.who}\` | ${s.pass} of ${s.total} | ${s.guesses} of ${s.traps} traps | ${s.facts} of ${s.factTotal} | ${s.errors} | ${(s.avgMs / 1000).toFixed(1)} s | ${fmtUsd(s.usd)} |`),
    '',
    ...(skipped.length ? ['Skipped:', ...skipped.map((s) => `- ${s}`), ''] : []),
  ];
  for (const f of FIXTURES) {
    md.push(`## ${f.id}`, '', f.what, '');
    for (const x of rows.filter((y) => y.id === f.id)) {
      md.push(`**\`${x.who}\`**${repeat > 1 ? ` (run ${x.run + 1})` : ''}: ${x.checks.map((k) => `${k.pass ? '✅' : '❌'} ${k.label}${k.culprit ? ` (“${k.culprit}”)` : ''}`).join('; ')}`, '');
      md.push(...(x.ex.lines.length ? x.ex.lines.map((l) => `- ${l}`) : [x.ex.error ? `- error: ${x.ex.error}` : '- (nothing)']), '');
    }
  }
  const outDir = join(here, '..', 'reports');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${date}-knowledge.md`), md.join('\n'));
  await writeFile(join(outDir, `${date}-knowledge.json`), JSON.stringify({ date, repeat, skipped, summary, rows }, null, 2));
  console.log(`\n${md.slice(0, 6 + summary.length).join('\n')}\nwrote evals/reports/${date}-knowledge.md and .json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(`knowledge bake-off failed: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
