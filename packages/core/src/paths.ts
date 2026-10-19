import { join } from 'node:path';

/** ~/.local/share/aios (respects XDG_DATA_HOME). Database and audit log live here. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(env.HOME ?? '', '.local', 'share'), 'aios');
}
