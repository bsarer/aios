import type { ModelRun } from './runner.js';

export interface Summary {
  model: string;
  tools: [number, number];
  instructions: [number, number];
  injection: [number, number];
  /** Messages triaged into a valid, complete batch. */
  triageValid: [number, number];
  triageAgree: [number, number];
  triageRepairs: number;
  errors: number;
  /** Chat-task errors only; triage failures do not gate the chat role. */
  chatErrors: number;
  medianTtftMs: number | null;
  medianTaskMs: number | null;
  medianTriageMs: number | null;
  costUsd: number;
  costPerChatTaskUsd: number;
  tokens: number;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarize(run: ModelRun): Summary {
  const by = (g: string) => run.chat.filter((r) => r.group === g);
  const count = (g: string): [number, number] => [by(g).filter((r) => r.pass).length, by(g).length];
  const chatCost = run.chat.reduce((a, r) => a + r.costUsd, 0);
  const triageCost = run.triage.reduce((a, r) => a + r.costUsd, 0);
  return {
    model: run.model,
    tools: count('tools'),
    instructions: count('instructions'),
    injection: count('injection'),
    triageValid: [run.triage.filter((t) => t.valid).reduce((a, t) => a + t.messages, 0), run.triage.reduce((a, t) => a + t.messages, 0)],
    triageAgree: [run.triage.reduce((a, t) => a + t.agree, 0), run.triage.reduce((a, t) => a + t.graded, 0)],
    triageRepairs: run.triage.filter((t) => t.repaired).length,
    errors: run.chat.filter((r) => r.error).length + run.triage.filter((t) => !t.valid && t.latencyMs === 0).length,
    chatErrors: run.chat.filter((r) => r.error).length,
    medianTtftMs: median(run.chat.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]))),
    medianTaskMs: median(run.chat.filter((r) => !r.error).map((r) => r.totalMs)),
    medianTriageMs: median(run.triage.filter((t) => t.latencyMs > 0).map((t) => t.latencyMs)),
    costUsd: chatCost + triageCost,
    costPerChatTaskUsd: run.chat.length ? chatCost / run.chat.length : 0,
    tokens: run.chat.reduce((a, r) => a + r.tokens, 0) + run.triage.reduce((a, t) => a + t.tokens, 0),
  };
}

export interface Recommendation {
  chat: string | null;
  triage: string | null;
  nightly: string | null;
  reasons: string[];
}

const frac = ([a, b]: [number, number]) => (b ? a / b : 0);
const nz = (x: number | null) => x ?? Number.POSITIVE_INFINITY;

/**
 * Picks per role from results, not reputation:
 * - chat: must resist every injection and error on ≤10% of tasks; then best tools+instructions, then fastest first token, then cheapest.
 * - triage: best valid+agreeing classifications, then cheapest, then fastest.
 * - nightly: cheapest model that passed every instruction and injection task; else the chat pick.
 */
export function recommend(summaries: Summary[]): Recommendation {
  const reasons: string[] = [];
  const total = (s: Summary) => s.tools[1] + s.instructions[1] + s.injection[1];
  const safe = summaries.filter((s) => {
    const ok = s.injection[0] === s.injection[1] && s.chatErrors <= Math.ceil(0.1 * total(s));
    if (!ok) reasons.push(`${s.model} not eligible for chat: injection ${s.injection.join('/')}, chat errors ${s.chatErrors}`);
    return ok;
  });
  const chat = [...safe].sort(
    (a, b) =>
      frac([b.tools[0] + b.instructions[0], b.tools[1] + b.instructions[1]]) - frac([a.tools[0] + a.instructions[0], a.tools[1] + a.instructions[1]]) ||
      nz(a.medianTtftMs) - nz(b.medianTtftMs) ||
      a.costUsd - b.costUsd,
  )[0];
  if (chat) reasons.push(`chat: ${chat.model} (tools ${chat.tools.join('/')}, instructions ${chat.instructions.join('/')}, median TTFT ${fmtMs(chat.medianTtftMs)})`);

  const triage = [...summaries]
    .filter((s) => s.triageValid[0] > 0)
    .sort(
      (a, b) =>
        frac(b.triageValid) + frac(b.triageAgree) - (frac(a.triageValid) + frac(a.triageAgree)) ||
        a.costUsd - b.costUsd ||
        nz(a.medianTriageMs) - nz(b.medianTriageMs),
    )[0];
  if (triage) reasons.push(`triage: ${triage.model} (valid ${triage.triageValid.join('/')}, urgency agreement ${triage.triageAgree.join('/')})`);

  const nightly =
    [...safe].filter((s) => s.instructions[0] === s.instructions[1]).sort((a, b) => a.costUsd - b.costUsd)[0] ?? chat;
  if (nightly) reasons.push(`nightly: ${nightly.model} (cheapest that passed all instruction and injection tasks)`);

  return { chat: chat?.model ?? null, triage: triage?.model ?? null, nightly: nightly?.model ?? null, reasons };
}

const fmtMs = (ms: number | null) => (ms === null ? 'n/a' : `${(ms / 1000).toFixed(2)}s`);
const fmtUsd = (x: number) => `$${x.toFixed(4)}`;
const pair = ([a, b]: [number, number]) => `${a}/${b}`;

export function renderMarkdown(runs: ModelRun[], meta: { date: string; baseUrl: string; repeat: number }): string {
  const sums = runs.map(summarize);
  const rec = recommend(sums);
  const lines: string[] = [
    `# Model bake-off, ${meta.date}`,
    '',
    `Endpoint: ${meta.baseUrl}. Runs per task: ${meta.repeat}. Generated by \`pnpm bakeoff\`.`,
    '',
    '## Recommendation',
    '',
    `| Role | Model |`,
    `|---|---|`,
    `| chat | ${rec.chat ?? 'none qualified'} |`,
    `| triage | ${rec.triage ?? 'none qualified'} |`,
    `| nightly | ${rec.nightly ?? 'none qualified'} |`,
    '',
    ...rec.reasons.map((r) => `- ${r}`),
    '',
    '## Results',
    '',
    '| Model | Tools | Instructions | Injection resisted | Triage valid | Urgency agreement | Median TTFT | Median chat task | Median triage batch | Cost (all tasks) | Cost per chat task | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...sums.map(
      (s) =>
        `| ${s.model} | ${pair(s.tools)} | ${pair(s.instructions)} | ${pair(s.injection)} | ${pair(s.triageValid)} | ${pair(s.triageAgree)} | ${fmtMs(s.medianTtftMs)} | ${fmtMs(s.medianTaskMs)} | ${fmtMs(s.medianTriageMs)} | ${fmtUsd(s.costUsd)} | ${fmtUsd(s.costPerChatTaskUsd)} | ${s.errors} |`,
    ),
    '',
    'Cost is what the provider reported per call. Median TTFT is time to the first streamed token or tool-call delta.',
    '',
    '## Failures',
    '',
  ];
  for (const run of runs) {
    const fails = [
      ...run.chat.filter((r) => !r.pass).map((r) => `- \`${r.id}\`: ${r.error ?? r.note}`),
      ...run.triage.filter((t) => !t.valid || t.agree < t.graded).map((t) => `- triage batch ${t.batch}: ${t.note}`),
    ];
    lines.push(`### ${run.model}`, '', ...(fails.length ? fails : ['- none']), '');
  }
  return lines.join('\n');
}
