// OBS-07 (AD-029): a telemetria da camada anticorrupção do ERP.
import type { MetricSpec } from '../shared/telemetry-catalog.ts';
import {
  metricsOf,
  type AttributesOf,
} from '../shared/telemetry-instruments.ts';
import type { Telemetry } from '../shared/telemetry.ts';

const ERP_OPERATIONS = ['create_order', 'find_order', 'list_catalog'] as const;

const ERP_OUTCOMES = [
  'ok',
  'found',
  'not_found',
  'permanent',
  'transient',
  'ambiguous',
  'config_error',
] as const;

export const ERP_METRICS = {
  'casecellshop.erp.client.operation.duration': {
    instrument: 'histogram',
    unit: 's',
    description:
      'Duração das chamadas ao ERP, por operação e desfecho; o `_count` conta as chamadas.',
    // A chamada vai até o timeout de 10 s com folga; a última fronteira é 30.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    attributes: {
      'casecellshop.erp.operation': {
        description: 'Operação da porta ErpClient.',
        requirement: 'required',
        values: { kind: 'enum', values: ERP_OPERATIONS },
      },
      'casecellshop.erp.outcome': {
        description: 'Desfecho da chamada, pela lista fechada da porta.',
        requirement: 'required',
        values: { kind: 'enum', values: ERP_OUTCOMES },
      },
    },
  },
  'casecellshop.erp.client.active_operations': {
    instrument: 'up_down_counter',
    unit: '{operation}',
    description: 'Chamadas ao ERP em andamento.',
    attributes: {},
  },
  'casecellshop.erp.out_of_stock.rejections': {
    instrument: 'counter',
    unit: '{order}',
    description: 'Pedidos que o ERP recusou por falta de estoque.',
    attributes: {},
  },
} as const satisfies Record<string, MetricSpec>;

// Os valores das listas fechadas, para o código do ERP ser conferido pelo tipo contra a declaração.
type DurationAttributes = AttributesOf<
  (typeof ERP_METRICS)['casecellshop.erp.client.operation.duration']
>;
export type ErpOperation = DurationAttributes['casecellshop.erp.operation'];
export type ErpOutcome = DurationAttributes['casecellshop.erp.outcome'];

// Os instrumentos do ERP, criados uma vez por `Telemetry` a partir da declaração acima.
export function erpMetrics(telemetry: Telemetry) {
  return metricsOf(telemetry, 'casecellshop.erp', ERP_METRICS);
}
