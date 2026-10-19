import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Prompter } from './setup-lib.js';

/**
 * Terminal prompter. Secret answers are read with echo suppressed.
 * Lines are queued as they arrive so piped input (scripted runs) is not lost.
 */
export function terminalPrompter(): Prompter & { close(): void } {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (!muted) stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: stdin, output, terminal: stdin.isTTY });
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;
  rl.on('line', (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  const nextLine = async (): Promise<string> => {
    const l = lines.length ? lines.shift()! : closed ? null : await new Promise<string | null>((r) => waiting.push(r));
    if (l === null) throw new Error('input ended before setup finished');
    return l.trim();
  };

  return {
    async ask(question, opts = {}) {
      const def = opts.default && !opts.secret ? ` [${opts.default}]` : '';
      stdout.write(`${question}${def}: `);
      muted = Boolean(opts.secret);
      try {
        const answer = await nextLine();
        return answer || opts.default || '';
      } finally {
        if (muted || !stdin.isTTY) stdout.write('\n');
        muted = false;
      }
    },
    async confirm(question, defaultYes = true) {
      stdout.write(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'}: `);
      const answer = (await nextLine()).toLowerCase();
      if (!stdin.isTTY) stdout.write('\n');
      return answer ? answer.startsWith('y') : defaultYes;
    },
    close: () => rl.close(),
  };
}
