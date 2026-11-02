// OBS-07 (AD-029): gera o .specs/features/casecellshop/telemetry.md a partir das declarações de cada pasta (o
// agregado de scripts/telemetry-catalog.ts), como o openapi.yaml sai do contrato. Com --check, só compara com o
// arquivo commitado e falha se divergir; o --file troca o arquivo comparado, para o teste provar a detecção.
import type {
  InstrumentKind,
  LogEventSpec,
  MetricSpec,
} from '../src/shared/telemetry-catalog.ts';

// O nome que o exportador Prometheus do OpenTelemetry dá à métrica: ponto vira sublinhado, e o contador ganha
// `_total` (o UpDownCounter sai como gauge, sem sufixo; o histograma ganha `_bucket`, `_sum` e `_count` na
// exposição, e o nome base fica sem sufixo).
export function prometheusName(
  name: string,
  instrument: InstrumentKind,
): string {
  void name;
  void instrument;
  throw new Error('não implementado');
}

// O Markdown do catálogo: as métricas e os eventos de log em ordem de nome, com o cabeçalho de arquivo gerado.
export function renderTelemetryDoc(
  metrics: Readonly<Record<string, MetricSpec>>,
  events: Readonly<Record<string, LogEventSpec>>,
): string {
  void metrics;
  void events;
  throw new Error('não implementado');
}
