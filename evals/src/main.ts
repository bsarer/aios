/**
 * `pnpm bakeoff [--repeat N] [--only model-id] [--skip-preflight]`
 *
 * Runs every task against each model in evals/candidates.toml, using the chat role's
 * connection settings and keyring entry from ~/.config/aios/config.toml (set up with
 * `pnpm run setup`). Writes evals/reports/<date>-bakeoff.{md,json}.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keyring, ModelClient } from '@aios/core';
import { type ModelRoleConfig, configDir, parseConfig } from '@aios/shared';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { renderMarkdown } from './report.js';
import { type ModelRun, runChatTask, runTriage } from './runner.js';
import { CHAT_TASKS } from './tasks.js';

const here = dirname(fileURLToPath(import.meta.url));
const Candidates = z.strictObject({ candidate: z.array(z.strictObject({ model: z.string().min(1) })).min(1) });

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Confirms each id exists and, where the listing says, supports tools and response_format. */
async function preflight(base: ModelRoleConfig, models: string[]): Promise<string[]> {
  const res = await fetch(`${base.baseUrl.replace(/\/$/, '')}/models`);
  if (!res.ok) {
    console.warn(`could not list models (HTTP ${res.status}); skipping preflight`);
    return [];
  }
  const Listing = z.looseObject({ data: z.array(z.looseObject({ id: z.string(), supported_parameters: z.array(z.string()).optional() })) });
  const listing = Listing.parse(await res.json());
  const problems: string[] = [];
  for (const m of models) {
    const entry = listing.data.find((d) => d.id === m);
    if (!entry) problems.push(`${m}: not in the provider's model list`);
    else if (entry.supported_parameters) {
      for (const p of ['tools', 'response_format']) if (!entry.supported_parameters.includes(p)) problems.push(`${m}: no ${p} support`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const repeat = Number(flag('repeat') ?? 1);
  const only = flag('only');
  const config = parseConfig(await readFile(join(configDir(), 'config.toml'), 'utf8'));
  const base = config.models.chat;
  const cands = Candidates.parse(parseToml(await readFile(join(here, '..', 'candidates.toml'), 'utf8')));
  const models = cands.candidate.map((c) => c.model).filter((m) => !only || m === only);

  if (!process.argv.includes('--skip-preflight')) {
    const problems = await preflight(base, models);
    if (problems.length) {
      console.error(`preflight failed:\n  ${problems.join('\n  ')}\nEdit evals/candidates.toml or pass --skip-preflight.`);
      process.exit(1);
    }
  }

  const keyring = new Keyring();
  await keyring.require(base.apiKeyRef); // fail early with the setup hint
  const runs: ModelRun[] = [];

  for (const model of models) {
    const role = { ...base, model };
    const client = new ModelClient({ models: { chat: role, triage: role, nightly: role }, resolveKey: (ref) => keyring.require(ref) });
    const run: ModelRun = { model, chat: [], triage: [] };
    for (let r = 0; r < repeat; r++) {
      for (const task of CHAT_TASKS) {
        const res = await runChatTask(client, task, config.user.name);
        run.chat.push(res);
        console.log(`${model}  ${res.pass ? 'PASS' : 'FAIL'}  ${task.id}  ${res.error ?? res.note}`);
      }
      const tri = await runTriage(client);
      run.triage.push(...tri);
      for (const t of tri) console.log(`${model}  ${t.valid ? 'OK  ' : 'BAD '}  triage-${t.batch}  agree ${t.agree}/${t.graded}  ${t.note}`);
    }
    runs.push(run);
  }

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(here, '..', 'reports');
  await mkdir(outDir, { recursive: true });
  const md = renderMarkdown(runs, { date, baseUrl: base.baseUrl, repeat });
  await writeFile(join(outDir, `${date}-bakeoff.md`), md);
  await writeFile(join(outDir, `${date}-bakeoff.json`), JSON.stringify({ date, baseUrl: base.baseUrl, repeat, runs }, null, 2));
  console.log(`\n${md}\n\nwrote evals/reports/${date}-bakeoff.md and .json`);
}

main().catch((err: unknown) => {
  console.error(`bake-off failed: ${(err as Error).message}`);
  process.exit(1);
});
