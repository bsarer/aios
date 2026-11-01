import type { ModelRole } from '@aios/shared';
import { type Store, startOfDay } from './store.js';

/**
 * The ModelClient gate (A7): no model call while paused, and none once today's spend has
 * reached the daily cap. Spend is what providers report per call, so a provider that
 * reports no cost is never capped; /cost shows the numbers. The local model (L1) costs
 * nothing, so only pause stops it.
 */
export function modelGate(o: { store: Store; timeZone: string; dailyCapUsd: number; now?: () => number }) {
  const now = o.now ?? Date.now;
  return (role: ModelRole): 'paused' | 'cost_cap' | null => {
    if (o.store.getSetting('paused') === '1') return 'paused';
    if (role === 'local') return null;
    if (o.store.usageSince(startOfDay(now(), o.timeZone)).costUsd >= o.dailyCapUsd) return 'cost_cap';
    return null;
  };
}
