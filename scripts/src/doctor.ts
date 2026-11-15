/** P1: `pnpm doctor`. Checks the install and prints one line per check, with a fix; exits 1 when one fails. */
import { formatChecks, kioskPaths, realDoctorProbes, runDoctor } from '@aios/core';

const checks = await runDoctor(realDoctorProbes(kioskPaths()));
for (const line of formatChecks(checks)) console.log(line);
const failed = checks.filter((c) => c.status === 'fail').length;
console.log(failed ? `\n${failed} check${failed === 1 ? '' : 's'} failed.` : '\nAll good.');
process.exit(failed ? 1 : 0);
