// OBS-07 (AD-029): a telemetria do /health.
import type { LogEventSpec } from '../shared/telemetry-catalog.ts';

export const HEALTH_LOG_EVENTS = {
  'casecellshop.health.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu ao /health.',
    fields: ['err'],
  },
} as const satisfies Record<string, LogEventSpec>;
