// OBS-07 (AD-029): a telemetria do checkout.
import type { LogEventSpec, MetricSpec } from '../shared/telemetry-catalog.ts';

const CHECKOUT_OUTCOMES = [
  'accepted',
  'replay',
  'out_of_stock',
  'price_changed',
  'invalid',
  'unavailable',
] as const;

export const CHECKOUT_METRICS = {
  'casecellshop.checkout.requests': {
    instrument: 'counter',
    unit: '{request}',
    description: 'Checkouts por desfecho.',
    attributes: {
      'casecellshop.checkout.outcome': {
        description: 'Desfecho do checkout.',
        values: { kind: 'enum', values: CHECKOUT_OUTCOMES },
      },
    },
  },
} as const satisfies Record<string, MetricSpec>;

export const CHECKOUT_LOG_EVENTS = {
  'casecellshop.checkout.accepted': {
    level: 'info',
    description: 'Checkout aceito, com o pedido criado.',
    fields: ['orderId'],
  },
  'casecellshop.checkout.rejected': {
    level: 'warn',
    description: 'Checkout recusado; `reason` é o tipo do problem.',
    fields: ['reason'],
  },
  'casecellshop.checkout.price_changed': {
    level: 'warn',
    description: 'Checkout recusado porque o preço informado mudou.',
    fields: ['reason', 'items'],
  },
  'casecellshop.checkout.db.unavailable': {
    level: 'warn',
    description: 'O banco não respondeu no checkout; a resposta é 503.',
    fields: ['err', 'step'],
  },
} as const satisfies Record<string, LogEventSpec>;
