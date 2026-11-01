// OBS-07 (AD-029): a telemetria do acesso ao banco.
import type { LogEventSpec } from '../shared/telemetry-catalog.ts';

export const DB_LOG_EVENTS = {
  'casecellshop.db.transaction.aborted': {
    level: 'error',
    description: 'A transação foi abortada antes do COMMIT.',
    fields: ['err'],
  },
  'casecellshop.db.pool.failed': {
    level: 'error',
    description: 'Erro numa conexão ociosa do pool.',
    fields: ['err'],
  },
} as const satisfies Record<string, LogEventSpec>;
