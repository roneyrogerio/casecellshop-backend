import type { StartedDockerComposeEnvironment } from 'testcontainers';
import { expect } from 'vitest';
import { METRICS } from '../../scripts/telemetry-catalog.ts';
import type {
  AttributeSpec,
  MetricSpec,
} from '../../src/shared/telemetry-catalog.ts';
import {
  parseExposition,
  promLabel,
  promName,
  valueOf,
  type Exposition,
  type MetricName,
} from './metrics.ts';

// O /metrics de um processo do compose, lido de dentro do contêiner dele (nem a API nem o worker publicam a porta de
// métricas no host, e o ElasticMQ e o Postgres ficam na rede do compose).
export async function readProcessMetrics(
  environment: StartedDockerComposeEnvironment,
  container: string,
  port: number,
): Promise<Exposition> {
  const script = `fetch('http://127.0.0.1:${port}/metrics').then((r) => r.text()).then((t) => process.stdout.write(t))`;
  const result = await environment
    .getContainer(container)
    .exec(['node', '-e', script]);
  expect(result.exitCode, result.output).toBe(0);
  return parseExposition(result.stdout);
}

// A lista fechada de um atributo `enum` do catálogo (OBS-07): o que o OBS-08 manda combinar na subida.
export function closedList(metric: MetricName, attribute: string): string[] {
  const spec: MetricSpec = METRICS[metric];
  const found: AttributeSpec | undefined = spec.attributes[attribute];
  if (found?.values.kind !== 'enum')
    throw new Error(`${attribute} de ${metric} não é uma lista fechada`);
  return [...found.values.values];
}

// Uma série do counter ou do UpDownCounter existe no /metrics e vale 0, pelos atributos do catálogo.
export function expectSeriesAtZero(
  families: Exposition,
  metric: MetricName,
  attributes: Record<string, string> = {},
): void {
  const labels = Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [promLabel(key), value]),
  );
  expect(
    valueOf(families, promName(metric), labels),
    `${promName(metric)} ${JSON.stringify(labels)} em 0`,
  ).toBe(0);
}

// Uma série por valor da lista fechada do atributo, todas em 0.
export function expectSeriesAtZeroForEach(
  families: Exposition,
  metric: MetricName,
  attribute: string,
): void {
  for (const value of closedList(metric, attribute))
    expectSeriesAtZero(families, metric, { [attribute]: value });
}
