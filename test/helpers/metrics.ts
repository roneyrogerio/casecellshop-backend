import { createServer } from 'node:http';
import request from 'supertest';
import type { Telemetry } from '../../src/shared/telemetry.ts';

export type MetricType =
  'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

export interface Sample {
  // Nome da série, com o sufixo (`_bucket`, `_sum`, `_count`) nos histogramas.
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  name: string;
  type: MetricType;
  samples: Sample[];
}

export type Exposition = Map<string, MetricFamily>;

// O OpenTelemetry acrescenta o escopo a toda série; ele não é um label do design.
const IGNORED_LABELS = new Set([
  'otel_scope_name',
  'otel_scope_version',
  'otel_scope_schema_url',
]);
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of text.matchAll(
    /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g,
  )) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined) labels[key] = value;
  }
  return labels;
}

// Lê o formato de texto do Prometheus: as linhas `# TYPE` dão o tipo; as séries de um histograma
// (`_bucket`, `_sum`, `_count`) voltam para a família do nome base.
export function parseExposition(text: string): Exposition {
  const types = new Map<string, MetricType>();
  for (const line of text.split('\n')) {
    const match = /^# TYPE (\S+) (\S+)/.exec(line);
    if (match?.[1] && match[2]) types.set(match[1], match[2] as MetricType);
  }
  const families: Exposition = new Map();
  for (const [name, type] of types)
    families.set(name, { name, type, samples: [] });
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?\s+(\S+)/.exec(line);
    if (!match?.[1] || !match[3]) continue;
    const sampleName = match[1];
    const base =
      types.get(sampleName) !== undefined
        ? sampleName
        : HISTOGRAM_SUFFIXES.map((suffix) =>
            sampleName.endsWith(suffix)
              ? sampleName.slice(0, -suffix.length)
              : undefined,
          ).find(
            (candidate) =>
              candidate !== undefined && types.get(candidate) === 'histogram',
          );
    if (base === undefined) continue;
    const labels = parseLabels(match[2] ?? '');
    for (const ignored of IGNORED_LABELS) delete labels[ignored];
    families
      .get(base)
      ?.samples.push({ name: sampleName, labels, value: Number(match[3]) });
  }
  return families;
}

// O /metrics como o Prometheus o lê: uma requisição HTTP ao handler da telemetria.
export async function scrapeMetrics(telemetry: Telemetry): Promise<Exposition> {
  const server = createServer((req, res) => telemetry.metricsHandler(req, res));
  const res = await request(server).get('/metrics');
  return parseExposition(res.text);
}

// Valor da série com exatamente estes labels (os de `le` incluídos, se pedidos).
export function valueOf(
  families: Exposition,
  family: string,
  labels: Record<string, string> = {},
  sampleName = family,
): number | undefined {
  const found = families.get(family)?.samples.find((sample) => {
    if (sample.name !== sampleName) return false;
    const keys = Object.keys(sample.labels);
    return (
      keys.length === Object.keys(labels).length &&
      keys.every((key) => sample.labels[key] === labels[key])
    );
  });
  return found?.value;
}

// Todos os nomes de label de todas as séries do /metrics.
export function labelNames(families: Exposition): Set<string> {
  const names = new Set<string>();
  for (const family of families.values()) {
    for (const sample of family.samples)
      for (const key of Object.keys(sample.labels)) names.add(key);
  }
  return names;
}
