import type { ModelRoleConfig } from '@aios/shared';

/** Same connection settings, this model, minus optional fields the model does not take. */
export function roleFor(base: ModelRoleConfig, model: string, supported: string[] | undefined): { role: ModelRoleConfig; dropped: string[] } {
  const role: ModelRoleConfig = { ...base, model };
  const dropped: string[] = [];
  if (supported && role.temperature !== undefined && !supported.includes('temperature')) {
    delete role.temperature;
    dropped.push('temperature');
  }
  return { role, dropped };
}
