import { type AiosConfig, MODEL_ROLES, type SecretRef } from '@aios/shared';

/** Every keyring reference a config uses: the mail password, model keys and calendar secrets. */
export function secretRefs(config: AiosConfig): SecretRef[] {
  const calendar = config.calendar ? [...(config.calendar.clientSecretRef ? [config.calendar.clientSecretRef] : []), config.calendar.tokenRef] : [];
  return [...new Set([config.mail.passwordRef, ...MODEL_ROLES.map((r) => config.models[r].apiKeyRef), ...calendar])];
}

