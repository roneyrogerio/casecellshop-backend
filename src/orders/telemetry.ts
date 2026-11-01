// OBS-07 (AD-029): a telemetria do status do pedido.
import type { LogEventSpec } from '../shared/telemetry-catalog.ts';

export const ORDERS_LOG_EVENTS = {
  'casecellshop.orders.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu na leitura do status do pedido.',
    fields: ['err'],
  },
} as const satisfies Record<string, LogEventSpec>;
