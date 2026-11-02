// OBS-07 (AD-029): a telemetria da vitrine (o cache e a origem dele) e da sincronização com o ERP.
import type { LogEventSpec, MetricSpec } from '../shared/telemetry-catalog.ts';
import { metricsOf } from '../shared/telemetry-instruments.ts';
import type { Telemetry } from '../shared/telemetry.ts';

export const CATALOG_METRICS = {
  'casecellshop.catalog.cache.lookups': {
    instrument: 'counter',
    unit: '{lookup}',
    description:
      'Leituras do cache da vitrine por resultado; o hit ratio sai daqui.',
    attributes: {
      'casecellshop.catalog.cache.result': {
        description:
          '`hit` dentro do TTL, `miss` quando esperou uma carga, `stale` quando serviu a entrada expirada por erro ou pausa da origem.',
        requirement: 'required',
        values: { kind: 'enum', values: ['hit', 'miss', 'stale'] },
      },
    },
  },
  'casecellshop.catalog.origin.loads': {
    instrument: 'counter',
    unit: '{load}',
    description:
      'Cargas do cache a partir do banco, por desfecho: o custo do cache em consultas à origem.',
    attributes: {
      'casecellshop.catalog.origin.outcome': {
        description: 'Desfecho da carga.',
        requirement: 'required',
        values: { kind: 'enum', values: ['ok', 'error'] },
      },
    },
  },
  'casecellshop.catalog.origin.active_loads': {
    instrument: 'up_down_counter',
    unit: '{load}',
    description:
      'Cargas do cache em andamento; o single-flight a mantém em no máximo 1 por instância.',
    attributes: {},
  },
  'casecellshop.catalog.served_entry.age': {
    instrument: 'histogram',
    unit: 's',
    description:
      'Idade da entrada do cache servida, desde a carga que a gerou.',
    // 4.5 e 5.5 são as pontas do TTL com jitter; 60 é o teto do stale-if-error.
    buckets: [1, 2.5, 4.5, 5.5, 10, 20, 30, 45, 60],
    attributes: {},
  },
  'casecellshop.catalog.sync.age': {
    instrument: 'gauge',
    unit: 's',
    description:
      'Idade da última rodada completa da sincronização com o ERP; base do alerta de sincronização parada.',
    attributes: {},
  },
  'casecellshop.catalog.gauge.read_failures': {
    instrument: 'counter',
    unit: '{read}',
    description:
      'Leituras do gauge da idade da sincronização que falharam no /metrics da API; nesse caso o gauge mantém o último valor.',
    attributes: {
      'casecellshop.gauge.name': {
        description: 'Gauge cuja leitura falhou.',
        requirement: 'required',
        values: { kind: 'enum', values: ['catalog_sync_age'] },
      },
    },
  },
  'casecellshop.catalog.sync.corrections': {
    instrument: 'counter',
    unit: '{correction}',
    description:
      'Campos que a sincronização corrigiu porque o ERP divergia do valor guardado no início da rodada.',
    attributes: {
      'casecellshop.catalog.sync.field': {
        description: 'Campo corrigido.',
        requirement: 'required',
        values: { kind: 'enum', values: ['price', 'on_hand', 'name'] },
      },
    },
  },
  'casecellshop.catalog.sync.missing_skus': {
    instrument: 'counter',
    unit: '{sku}',
    description:
      'SKUs da loja ausentes do ERP numa rodada completa, zerados por ela.',
    attributes: {},
  },
} as const satisfies Record<string, MetricSpec>;

// Os instrumentos da vitrine e da sincronização, criados uma vez por `Telemetry` a partir da declaração acima.
export function catalogMetrics(telemetry: Telemetry) {
  return metricsOf(telemetry, 'casecellshop.catalog', CATALOG_METRICS);
}

export const CATALOG_LOG_EVENTS = {
  'casecellshop.catalog.origin.load_failed': {
    levels: ['warn'],
    description:
      'A carga do cache a partir do banco falhou; a vitrine serve a entrada antiga até o teto ou responde 503.',
    fields: ['err'],
  },
  'casecellshop.catalog.sync.round.completed': {
    levels: ['info'],
    description:
      'Fim de uma rodada completa da sincronização, com os SKUs lidos, os ausentes zerados e a duração.',
    fields: ['skuCount', 'missingCount', 'duration_ms'],
  },
  'casecellshop.catalog.sync.round.failed': {
    levels: ['warn'],
    description:
      'Rodada incompleta: o ERP falhou numa página (`cause`) ou o banco falhou (`err`); nenhum ausente é zerado.',
    fields: ['cause', 'page', 'err'],
  },
  'casecellshop.catalog.gauge.read_failed': {
    levels: ['error'],
    description:
      'A leitura de um gauge da sincronização falhou no scrape; o gauge segue com o último valor lido.',
    fields: ['gauge', 'err'],
  },
} as const satisfies Record<string, LogEventSpec>;
