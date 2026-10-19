/** `pnpm --filter @aios/evals run render <report.json>`: rebuild the Markdown report from saved results. */
import { readFile, writeFile } from 'node:fs/promises';
import { renderMarkdown } from './report.js';
import type { ModelRun } from './runner.js';

const path = process.argv[2];
if (!path?.endsWith('.json')) {
  console.error('usage: render <report.json>');
  process.exit(1);
}
const data = JSON.parse(await readFile(path, 'utf8')) as { date: string; baseUrl: string; repeat: number; runs: ModelRun[] };
await writeFile(path.replace(/\.json$/, '.md'), renderMarkdown(data.runs, data));
console.log(`wrote ${path.replace(/\.json$/, '.md')}`);
