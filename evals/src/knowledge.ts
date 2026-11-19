/**
 * `pnpm --filter @aios/evals knowledge [--mine N] [--cloud model-id] [--repeat N]`
 *
 * Knowledge bake-off: the local model ([models.local]) against the cloud model the first pass
 * uses ([models.nightly], or --cloud to try another id on the same connection). Both get exactly
 * the requests the knowledge base sends (`mailRequest`, `chatRequest`, `calendarRequest` from
 * core), so this measures the model, with today's prompt.
 *
 * 1. Fixtures (`knowledge-fixtures.ts`): invented items with traps and real facts, checked by
 *    code. Report: evals/reports/<date>-knowledge.md and .json, safe to commit.
 * 2. With --mine N: up to N of the user's own recent emails (half sent, half received, bulk and
 *    automated mail skipped like the knowledge base does). Both models' notes side by side, with
 *    every relationship or liking word that isn't in the email itself flagged. This report holds
 *    the user's mail, so it is written only to <config dir>/evals/, never to the repo, and only
 *    counts are printed.
 *
 * Nothing is written to the knowledge base, the ledger or memory. The extractor has no tools here
 * either: only structured calls.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExtractedNotes,
  Keyring,
  MailClient,
  ModelClient,
  type ModelRequest,
  ModelError,
  calendarRequest,
  chatRequest,
  cleanExtracted,
  cleanPages,
  mailRequest,
  ownText,
  sanitize,
  skipReason,
} from '@aios/core';
import { configDir, parseConfig } from '@aios/shared';
import { FIXTURES, FIXTURE_USER, type Fixture, type FixtureItem } from './knowledge-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Side = 'local' | 'cloud';
const ROLE: Record<Side, ModelRequest['role']> = { local: 'local', cloud: 'nightly' };

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

async function main(): Promise<void> {
  const mine = Number(flag('mine') ?? 0);
  const repeat = Math.max(1, Number(flag('repeat') ?? 1));
  const config = parseConfig(await readFile(join(configDir(), 'config.toml'), 'utf8'));
  if (!config.models.local) throw new Error('no [models.local] in the config: there is no local model to compare');
  const keyring = new Keyring();
  const cloudModel = flag('cloud') ?? config.models.nightly.model;
  const models = { ...config.models, nightly: { ...config.models.nightly, model: cloudModel } };
  const client = new ModelClient({ models, resolveKey: (ref) => keyring.require(ref) });
  const names: Record<Side, string> = { local: config.models.local.model, cloud: cloudModel };
  console.log(`local: ${names.local}\ncloud: ${names.cloud}\n`);

  // ── 1. Fixtures ──
  const rows: { id: string; what: string; side: Side; run: number; ex: Extraction; checks: CheckResult[] }[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const [n, f] of FIXTURES.entries()) {
      for (const side of ['local', 'cloud'] as const) {
        const ex = await extractOnce(client, fixtureRequest(ROLE[side], f.item, n));
        const checks = ex.ok ? grade(f, ex.lines) : f.checks.map((c) => ({ label: c.label, pass: false, culprit: ex.error }));
        rows.push({ id: f.id, what: f.what, side, run: r, ex, checks });
        console.log(`${side.padEnd(5)}  ${checks.every((c) => c.pass) ? 'PASS' : 'FAIL'}  ${f.id}  ${ex.ms} ms${ex.error ? `  ${ex.error}` : ''}`);
      }
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  const score = (side: Side) => {
    const cs = rows.filter((x) => x.side === side).flatMap((x) => x.checks);
    return { pass: cs.filter((c) => c.pass).length, total: cs.length };
  };
  const md: string[] = [
    `# Knowledge bake-off, ${date}`,
    '',
    `Local: \`${names.local}\` · Cloud: \`${names.cloud}\` · ${repeat} run${repeat > 1 ? 's' : ''} · today's extraction prompt`,
    '',
    '| | Checks passed | Errors | Avg time | Cost |',
    '|---|---|---|---|---|',
    ...(['local', 'cloud'] as const).map((s) => {
      const xs = rows.filter((x) => x.side === s);
      const sc = score(s);
      return `| ${s} \`${names[s]}\` | ${sc.pass} of ${sc.total} | ${xs.filter((x) => !x.ex.ok).length} | ${Math.round(sum(xs.map((x) => x.ex.ms)) / xs.length)} ms | ${fmtUsd(sum(xs.map((x) => x.ex.usd)))} |`;
    }),
    '',
  ];
  for (const f of FIXTURES) {
    md.push(`## ${f.id}`, '', f.what, '');
    for (const side of ['local', 'cloud'] as const) {
      for (const x of rows.filter((y) => y.id === f.id && y.side === side)) {
        md.push(`**${side}**${repeat > 1 ? ` (run ${x.run + 1})` : ''}: ${x.checks.map((c) => `${c.pass ? '✅' : '❌'} ${c.label}${c.culprit ? ` (“${c.culprit}”)` : ''}`).join('; ')}`, '');
        md.push(...(x.ex.lines.length ? x.ex.lines.map((l) => `- ${l}`) : [x.ex.error ? `- error: ${x.ex.error}` : '- (nothing)']), '');
      }
    }
  }
  const outDir = join(here, '..', 'reports');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${date}-knowledge.md`), md.join('\n'));
  await writeFile(join(outDir, `${date}-knowledge.json`), JSON.stringify({ date, models: names, repeat, rows: rows.map(({ what: _w, ...r }) => r) }, null, 2));
  console.log(`\nfixtures: local ${score('local').pass}/${score('local').total}, cloud ${score('cloud').pass}/${score('cloud').total}\nwrote evals/reports/${date}-knowledge.md and .json`);

  // ── 2. The user's own mail (stays on this computer) ──
  if (mine > 0) await ownMail(config, keyring, client, names, mine, date);
}

async function ownMail(config: ReturnType<typeof parseConfig>, keyring: Keyring, client: ModelClient, names: Record<Side, string>, n: number, date: string): Promise<void> {
  const mail = new MailClient({
    host: config.mail.imap.host,
    port: config.mail.imap.port,
    tls: config.mail.imap.tls,
    user: config.mail.username,
    password: async () => (await keyring.require(config.mail.passwordRef)).reveal(),
  });
  const kc = config.knowledge;
  const listed = await mail.list({ since: new Date(Date.now() - 45 * 86_400_000), limit: 300, skipCategories: kc.skipCategories });
  const sent = listed.filter((m) => m.id.startsWith('Sent:'));
  const got = listed.filter((m) => !m.id.startsWith('Sent:') && !skipReason(m, false, kc));
  const pick = [...sent.slice(0, Math.ceil(n / 2)), ...got.slice(0, Math.floor(n / 2))];
  const totals: Record<Side, { notes: number; flagged: number; errors: number; ms: number; usd: number }> = {
    local: { notes: 0, flagged: 0, errors: 0, ms: 0, usd: 0 },
    cloud: { notes: 0, flagged: 0, errors: 0, ms: 0, usd: 0 },
  };
  const md: string[] = [
    `# Knowledge bake-off on your own mail, ${date}`,
    '',
    `Local: \`${names.local}\` · Cloud: \`${names.cloud}\`. ⚠️ marks a relationship or liking word the email itself never uses: the model supplied it.`,
    'This file holds your email subjects and what the models wrote about them. It stays on this computer.',
    '',
  ];
  const sections: string[] = [];
  for (const [i, s] of pick.entries()) {
    const m = await mail.read(s.id);
    if (!m) continue;
    const isSent = s.id.startsWith('Sent:');
    const who = (a: { name: string; address: string }) => (a.name ? `${a.name} <${a.address}>` : a.address);
    const body = m.text ? m.text : m.html ? sanitize({ html: m.html }, { maxChars: 12_000 }) : '';
    const source = `${m.from ? who(m.from) : ''}\n${m.to.map(who).join(', ')}\n${m.subject}\n${ownText(body)}`;
    sections.push(`## ${i + 1}. ${isSent ? 'Sent' : 'Received'}: ${m.subject.replace(/[\r\n]+/g, ' ').slice(0, 120) || '(no subject)'}`, '');
    for (const side of ['local', 'cloud'] as const) {
      const req = mailRequest(ROLE[side], config.user.name, {
        id: m.id,
        sentByUser: isSent,
        from: m.from ? who(m.from) : '(unknown)',
        to: [...m.to, ...m.cc].slice(0, 10).map(who),
        date: m.date?.toISOString().slice(0, 16).replace('T', ' ') ?? '(no date)',
        subject: m.subject,
        body: { text: m.text, html: m.html },
      });
      const ex = await extractOnce(client, req);
      const t = totals[side];
      t.ms += ex.ms;
      t.usd += ex.usd ?? 0;
      if (!ex.ok) t.errors++;
      t.notes += ex.lines.length;
      sections.push(`**${side}** (${ex.ms} ms)`, '');
      if (!ex.ok) sections.push(`- error: ${ex.error}`);
      else if (!ex.lines.length) sections.push('- (nothing)');
      for (const l of ex.lines) {
        const bad = unsupportedWords(l, source);
        if (bad.length) t.flagged++;
        sections.push(`- ${bad.length ? `⚠️ (${bad.join(', ')}) ` : ''}${l}`);
      }
      sections.push('');
    }
    console.log(`own mail ${i + 1}/${pick.length} done`);
  }
  md.push(
    '| | Notes and facts | ⚠️ unsupported words | Errors | Total time | Cost |',
    '|---|---|---|---|---|---|',
    ...(['local', 'cloud'] as const).map((s) => `| ${s} | ${totals[s].notes} | ${totals[s].flagged} | ${totals[s].errors} | ${Math.round(totals[s].ms / 1000)} s | ${fmtUsd(totals[s].usd)} |`),
    '',
    ...sections,
  );
  const dir = join(configDir(), 'evals');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${date}-knowledge-own-mail.md`);
  await writeFile(path, md.join('\n'), { mode: 0o600 });
  console.log(`\nown mail (${pick.length} emails):`);
  for (const s of ['local', 'cloud'] as const) console.log(`  ${s}: ${totals[s].notes} lines, ${totals[s].flagged} with unsupported words, ${totals[s].errors} errors, ${Math.round(totals[s].ms / 1000)} s, ${fmtUsd(totals[s].usd)}`);
  console.log(`wrote ${path} (stays on this computer)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), (err: unknown) => {
    console.error(`knowledge bake-off failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
