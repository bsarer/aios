/**
 * Opens a document in WordCraft or GridCraft (D1, doc_open_app). The app comes from config
 * and gets exactly one argument: the absolute path DocFiles resolved. Started the way S3
 * starts apps, through `uwsm-app --` when Omarchy has it, so the window outlives aios-core.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { onPath } from '../apps/desktop.js';
import type { DocKind } from './files.js';

export type OpenDocument = (kind: DocKind, path: string) => Promise<void>;

const EARLY_EXIT_MS = 1500;

export class OpenDocumentError extends Error {}

export function createDocumentOpener(apps: Record<DocKind, string>, env: NodeJS.ProcessEnv = process.env): OpenDocument {
  return async (kind, path) => {
    if (!isAbsolute(path)) throw new OpenDocumentError('internal: document paths must be absolute');
    const app = apps[kind];
    const [cmd, args] = (await onPath('uwsm-app', env)) ? ['uwsm-app', ['--', app, path]] : [app, [path]];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false, detached: true, stdio: 'ignore', env });
      const timer = setTimeout(() => {
        child.unref();
        resolve();
      }, EARLY_EXIT_MS);
      child.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new OpenDocumentError(err.code === 'ENOENT' ? `${app} is not installed (or not on the service's PATH)` : `${cmd} could not start: ${err.message}`));
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new OpenDocumentError(`${app} could not start (exit code ${code ?? 'unknown'})`));
      });
    });
  };
}
