// OBS-07 (AD-029): a telemetria das entradas de cada processo.
import type { LogEventSpec } from '../shared/telemetry-catalog.ts';

export const MAIN_LOG_EVENTS = {
  'casecellshop.api.started': {
    levels: ['info'],
    description: 'A API começou a escutar.',
    fields: ['port'],
  },
  'casecellshop.migration.completed': {
    levels: ['info'],
    description: 'As migrações dos dois schemas terminaram.',
    fields: [],
  },
  'casecellshop.worker.metrics_server.started': {
    levels: ['info'],
    description: 'O servidor do /metrics do worker começou a escutar.',
    fields: ['port'],
  },
} as const satisfies Record<string, LogEventSpec>;
