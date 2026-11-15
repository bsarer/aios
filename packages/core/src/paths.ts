import { join } from 'node:path';
import { appIds } from '@aios/shared';

/** ~/.local/share/astra (respects XDG_DATA_HOME; `aios` for an install made before R1). Database and audit log live here. */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(env.HOME ?? '', '.local', 'share'), appIds(env).dir);
}
