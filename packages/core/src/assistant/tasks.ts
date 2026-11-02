/**
 * L1: which model a background job runs on. Moving a job to the local model is one line of
 * config (`assistant.localTasks = ["mailTriage"]`), and only takes effect when [models.local]
 * is set, so a typo can't leave a job with no model. The jobs keep their own prompts, limits
 * and no-tools rules either way; only the role changes.
 */
import type { AiosConfig, LocalTask, ModelRole } from '@aios/shared';

export function roleFor(config: Pick<AiosConfig, 'models' | 'assistant'>, task: LocalTask, cloud: ModelRole): ModelRole {
  return config.models.local && config.assistant.localTasks.includes(task) ? 'local' : cloud;
}
