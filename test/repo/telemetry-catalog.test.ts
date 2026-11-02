import { existsSync, readdirSync } from 'node:fs';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, it } from 'vitest';
import { LOG_EVENTS, METRICS } from '../../scripts/telemetry-catalog.ts';
import { catalogViolations } from '../../src/shared/telemetry-catalog.ts';

// OBS-07 (AD-029): a conferência do catálogo real do repositório. As regras de nome estão em
// src/shared/telemetry-catalog.test.ts, com catálogos montados lá; aqui o que se confere é o código de verdade:
// o agregado de scripts/telemetry-catalog.ts, que junta o src/<pasta>/telemetry.ts de cada pasta.

const PREFIX = 'casecellshop.';
const SRC = new URL('../../src/', import.meta.url);

interface FolderNames {
  folder: string;
  metrics: string[];
  events: string[];
}

// Um export é um catálogo quando é um objeto não vazio e todo valor dele tem o campo que marca a forma:
// `instrument` (texto) na métrica, `levels` (lista) no evento. O nome do export não importa.
function isCatalogOf(
  value: unknown,
  marker: string,
  kind: 'string' | 'array',
): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const entries = Object.values(value);
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      if (typeof entry !== 'object' || entry === null) return false;
      const field = (entry as Record<string, unknown>)[marker];
      return kind === 'array'
        ? Array.isArray(field)
        : typeof field === 'string';
    })
  );
}

// Cada pasta de src/ com um telemetry.ts declara a própria telemetria (AD-025), `shared/` incluída (os eventos de
// encerramento do processo). Os exports que não são catálogo (o SDK de `shared/telemetry.ts`) não contam.
async function namesByFolder(): Promise<FolderNames[]> {
  const folders = readdirSync(SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(new URL(`${name}/telemetry.ts`, SRC)));
  const found: FolderNames[] = [];
  for (const folder of folders.sort()) {
    const url = new URL(`${folder}/telemetry.ts`, SRC).href;
    const exported = (await import(/* @vite-ignore */ url)) as Record<
      string,
      unknown
    >;
    const names: FolderNames = { folder, metrics: [], events: [] };
    for (const value of Object.values(exported)) {
      if (isCatalogOf(value, 'instrument', 'string'))
        names.metrics.push(...Object.keys(value));
      if (isCatalogOf(value, 'levels', 'array'))
        names.events.push(...Object.keys(value));
    }
    found.push(names);
  }
  return found;
}

// Os nomes que aparecem em mais de uma lista, ou mais de uma vez na mesma.
function repeatedNames(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of lists.flat()) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated].sort();
}

// A forma que o teste lê, sem depender de como o agregado tipa o índice.
interface MetricLike {
  readonly instrument: string;
  readonly buckets?: readonly number[];
  readonly attributes: Readonly<Record<string, { readonly values: unknown }>>;
}

function metricNamed(name: string): MetricLike | undefined {
  return Object.entries<MetricLike>(METRICS).find(([key]) => key === name)?.[1];
}

describe('OBS-07 o catálogo real segue as regras de nomes do OpenTelemetry', () => {
  it('OBS-07 o catálogo agregado das métricas e dos eventos de log não tem violação', () => {
    expect(Object.keys(METRICS).length).toBeGreaterThan(0);
    expect(Object.keys(LOG_EVENTS).length).toBeGreaterThan(0);
    expect(catalogViolations(METRICS, LOG_EVENTS)).toEqual([]);
  });

  it('OBS-07 só a duração HTTP, da convenção do OpenTelemetry, não começa por casecellshop.; as outras começam', () => {
    const outside = Object.keys(METRICS).filter(
      (name) => !name.startsWith(PREFIX),
    );
    expect(outside).toEqual([METRIC_HTTP_SERVER_REQUEST_DURATION]);
    expect(METRIC_HTTP_SERVER_REQUEST_DURATION).toBe(
      'http.server.request.duration',
    );
  });

  it('OBS-07 todo evento de log começa por casecellshop.', () => {
    expect(
      Object.keys(LOG_EVENTS).filter((name) => !name.startsWith(PREFIX)),
    ).toEqual([]);
  });

  it('OBS-07 a duração HTTP leva os atributos da convenção e só eles, com os métodos da convenção', () => {
    const http = metricNamed(METRIC_HTTP_SERVER_REQUEST_DURATION);
    expect(Object.keys(http?.attributes ?? {}).sort()).toEqual(
      [
        ATTR_HTTP_REQUEST_METHOD,
        ATTR_HTTP_ROUTE,
        ATTR_HTTP_RESPONSE_STATUS_CODE,
        ATTR_URL_SCHEME,
        ATTR_ERROR_TYPE,
      ].sort(),
    );
    expect(
      Object.entries(http?.attributes ?? {}).find(
        ([key]) => key === ATTR_HTTP_REQUEST_METHOD,
      )?.[1].values,
    ).toMatchObject({
      kind: 'enum',
      values: expect.arrayContaining(['GET', '_OTHER']) as unknown,
    });
  });

  it('OBS-07 a duração HTTP usa as fronteiras recomendadas pela convenção mais 0.2, o limiar da vitrine', () => {
    expect(metricNamed(METRIC_HTTP_SERVER_REQUEST_DURATION)?.buckets).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 2.5, 5,
      7.5, 10,
    ]);
  });

  it('OBS-07 o catálogo usa os três instrumentos, e as regras de fronteira e unidade não passam por não ter o que conferir', () => {
    const instruments = new Set(
      Object.values<MetricLike>(METRICS).map((spec) => spec.instrument),
    );
    expect([...instruments].sort()).toEqual([
      'counter',
      'histogram',
      'up_down_counter',
    ]);
  });
});

describe('OBS-07 o agregado junta a telemetria das pastas sem repetir nome', () => {
  it('OBS-07 as pastas que declaram a telemetria (http, checkout, billing, erp, db, orders e health) têm o telemetry.ts', async () => {
    const folders = (await namesByFolder()).map(({ folder }) => folder);
    for (const folder of [
      'http',
      'checkout',
      'billing',
      'erp',
      'db',
      'orders',
      'health',
    ])
      expect(folders, `src/${folder}/telemetry.ts`).toContain(folder);
  });

  it('OBS-07 ao menos uma pasta declara métricas e ao menos uma declara eventos de log', async () => {
    const folders = await namesByFolder();
    expect(folders.some(({ metrics }) => metrics.length > 0)).toBe(true);
    expect(folders.some(({ events }) => events.length > 0)).toBe(true);
  });

  it('OBS-07 nenhum nome de métrica se repete entre as pastas, e a união delas, toda pasta com telemetry.ts incluída, é o METRICS do agregado', async () => {
    const lists = (await namesByFolder()).map(({ metrics }) => metrics);
    expect(repeatedNames(lists)).toEqual([]);
    expect(lists.flat().sort()).toEqual(Object.keys(METRICS).sort());
  });

  it('OBS-07 nenhum nome de evento de log se repete entre as pastas, e a união delas, toda pasta com telemetry.ts incluída, é o LOG_EVENTS do agregado', async () => {
    const lists = (await namesByFolder()).map(({ events }) => events);
    expect(repeatedNames(lists)).toEqual([]);
    expect(lists.flat().sort()).toEqual(Object.keys(LOG_EVENTS).sort());
  });

  it('OBS-07 controle negativo: o nome declarado em duas pastas, ou duas vezes na mesma, é acusado', () => {
    expect(
      repeatedNames([
        ['a', 'b'],
        ['b', 'c'],
      ]),
    ).toEqual(['b']);
    expect(repeatedNames([['a', 'a'], ['c']])).toEqual(['a']);
    expect(repeatedNames([['a'], ['b'], ['c']])).toEqual([]);
  });
});
