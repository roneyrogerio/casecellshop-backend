// OBS-07 (AD-029): cria os instrumentos de uma pasta a partir da declaração dela (`Record<string, MetricSpec>`) e
// tipa a gravação pela mesma declaração: o nome é uma chave dela, e os atributos só aceitam as chaves e os valores
// declarados. O nome ou o valor fora da declaração não compila.
import type {
  Attributes,
  Counter,
  Histogram,
  Meter,
  UpDownCounter,
} from '@opentelemetry/api';
import type { MetricSpec } from './telemetry-catalog.ts';

type Specs = Readonly<Record<string, MetricSpec>>;

// Enum vira a união literal; o status HTTP aceita o número ou o texto dele (o `error.type` leva o texto); a rota
// é um texto.
type ValueOf<V> = V extends { kind: 'enum'; values: readonly (infer U)[] }
  ? U
  : V extends { kind: 'http_status_code' }
    ? number | `${number}`
    : string;

export type AttributesOf<M extends MetricSpec> = {
  -readonly [K in keyof M['attributes']]: M['attributes'][K] extends {
    values: infer V;
  }
    ? ValueOf<V>
    : never;
};

type NamesOf<S extends Specs, I extends string> = {
  [K in keyof S & string]: S[K]['instrument'] extends I ? K : never;
}[keyof S & string];

// Sem atributos declarados, a gravação não leva o argumento.
type AttributesArgument<M extends MetricSpec> =
  keyof M['attributes'] extends never
    ? [attributes?: undefined]
    : [attributes: AttributesOf<M>];

export interface TypedMetrics<S extends Specs> {
  add<N extends NamesOf<S, 'counter' | 'up_down_counter'>>(
    name: N,
    value: number,
    ...attributes: AttributesArgument<S[N]>
  ): void;
  record<N extends NamesOf<S, 'histogram'>>(
    name: N,
    value: number,
    ...attributes: AttributesArgument<S[N]>
  ): void;
}

type Instrument = Counter | UpDownCounter | Histogram;

function createInstrument(
  meter: Meter,
  name: string,
  spec: MetricSpec,
): Instrument {
  const options = { unit: spec.unit, description: spec.description };
  switch (spec.instrument) {
    case 'counter':
      return meter.createCounter(name, options);
    case 'up_down_counter':
      return meter.createUpDownCounter(name, options);
    case 'histogram':
      // As fronteiras ligadas aos SLOs entram pelo `advice`: sem elas o percentil seria aproximado.
      return meter.createHistogram(name, {
        ...options,
        ...(spec.buckets
          ? { advice: { explicitBucketBoundaries: [...spec.buckets] } }
          : {}),
      });
  }
}

// Um instrumento solto, para quem grava com atributos que o tipo da declaração não descreve por inteiro
// (a duração HTTP, cujo `error.type` só existe no 5xx).
export function createHistogramFor(
  meter: Meter,
  name: string,
  spec: MetricSpec,
): Pick<Histogram, 'record'> {
  const instrument = createInstrument(meter, name, spec);
  if (!('record' in instrument)) throw new Error(`${name} não é um histograma`);
  return instrument;
}

export function createInstruments<S extends Specs>(
  meter: Meter,
  specs: S,
): TypedMetrics<S> {
  const instruments = new Map<string, Instrument>(
    Object.entries(specs).map(([name, spec]) => [
      name,
      createInstrument(meter, name, spec),
    ]),
  );
  const pick = (name: string): Instrument => {
    const instrument = instruments.get(name);
    if (!instrument) throw new Error(`métrica fora da declaração: ${name}`);
    return instrument;
  };
  const typed = {
    add(name: string, value: number, attributes?: Attributes): void {
      const instrument = pick(name);
      if ('add' in instrument) instrument.add(value, attributes);
    },
    record(name: string, value: number, attributes?: Attributes): void {
      const instrument = pick(name);
      if ('record' in instrument) instrument.record(value, attributes);
    },
  };
  // A assinatura genérica de TypedMetrics só existe no tipo; o corpo é o mesmo para qualquer declaração.
  return typed;
}

// Cada pasta pede os próprios instrumentos pelo `Telemetry` que recebe; o cache evita recriá-los a cada gravação.
const cache = new WeakMap<object, Map<string, unknown>>();

export function metricsOf<S extends Specs>(
  telemetry: { meter(scope: string): Meter },
  scope: string,
  specs: S,
): TypedMetrics<S> {
  let scopes = cache.get(telemetry);
  if (!scopes) {
    scopes = new Map();
    cache.set(telemetry, scopes);
  }
  const cached = scopes.get(scope) as TypedMetrics<S> | undefined;
  if (cached) return cached;
  const created = createInstruments(telemetry.meter(scope), specs);
  scopes.set(scope, created);
  return created;
}
