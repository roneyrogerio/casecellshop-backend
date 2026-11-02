import { expect } from 'vitest';
import type { Telemetry } from '../../src/shared/telemetry.ts';
import type { LogLine } from './logs.ts';
import { labelNames, parseExposition, scrapeMetricsText } from './metrics.ts';

// OBS-01 (os eventos com produto): o que uma linha de log pode levar além dos campos do evento. São os comuns do
// design (time, level, service, env, version, msg, event, correlationId, trace_id, span_id, trace_flags) e os que o
// pino escreve por padrão quando o teste monta o logger sem o `createLogger` (pid, hostname). O trace_flags sai junto
// de trace_id e span_id em toda linha escrita dentro de um span (`traceMixin`).
export const COMMON_LOG_KEYS: readonly string[] = [
  'time',
  'level',
  'service',
  'env',
  'version',
  'msg',
  'event',
  'correlationId',
  'trace_id',
  'span_id',
  'trace_flags',
  'pid',
  'hostname',
];

// A linha leva só os campos declarados do evento mais os comuns: nada do corpo da requisição, do cabeçalho
// Idempotency-Key nem de outro dado do cliente.
export function expectOnlyKeys(
  line: LogLine,
  declared: readonly string[],
): void {
  const allowed = new Set<string>([...COMMON_LOG_KEYS, ...declared]);
  const outside = Object.keys(line).filter((key) => !allowed.has(key));
  expect(
    outside,
    `campos fora do declarado em ${String(line['event'])}`,
  ).toEqual([]);
}

// O sku só vai ao log, nunca a uma métrica (cardinalidade): o /metrics não ganha o rótulo `sku` nem `skus`, e nenhum
// valor de SKU usado no teste aparece no texto.
export async function expectNoSkuInMetrics(
  telemetry: Telemetry,
  skus: readonly string[],
): Promise<void> {
  const text = await scrapeMetricsText(telemetry);
  expectNoSkuInMetricsText(text, skus);
}

export function expectNoSkuInMetricsText(
  text: string,
  skus: readonly string[],
): void {
  const labels = labelNames(parseExposition(text));
  expect(labels.has('sku'), 'rótulo sku no /metrics').toBe(false);
  expect(labels.has('skus'), 'rótulo skus no /metrics').toBe(false);
  const leaked = skus.filter((sku) => text.includes(sku));
  expect(leaked, 'SKUs no texto do /metrics').toEqual([]);
}

// A lista de um campo `skus` ou `fields`, lida como texto; falha se o campo não é uma lista de textos.
export function stringList(value: unknown): string[] {
  expect(Array.isArray(value), 'o campo é uma lista').toBe(true);
  const list = value as unknown[];
  expect(list.every((item) => typeof item === 'string')).toBe(true);
  return list as string[];
}
