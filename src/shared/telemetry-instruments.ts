// OBS-07 (AD-029): cria os instrumentos de uma pasta a partir da declaração dela (`Record<string, MetricSpec>`) e
// tipa a gravação pela mesma declaração: o nome é uma chave dela, e os atributos só aceitam as chaves e os valores
// declarados. O nome ou o valor fora da declaração não compila.
import type {
  Attributes,
  Counter,
  Histogram,
  BatchObservableCallback,
  Meter,
  ObservableCallback,
  ObservableGauge,
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

type Attribute<
  M extends MetricSpec,
  K extends keyof M['attributes'],
> = M['attributes'][K] extends { values: infer V } ? ValueOf<V> : never;

type RequiredKeys<M extends MetricSpec> = {
  [K in keyof M['attributes']]: M['attributes'][K] extends {
    requirement: 'required';
  }
    ? K
    : never;
}[keyof M['attributes']];

// O `required` é obrigatório na gravação; o `conditionally_required` é opcional, porque só vale quando a condição
// da descrição ocorre (o `error.type` só no 5xx).
export type AttributesOf<M extends MetricSpec> = {
  -readonly [K in RequiredKeys<M>]: Attribute<M, K>;
} & {
  -readonly [K in Exclude<keyof M['attributes'], RequiredKeys<M>>]?: Attribute<
    M,
    K
  >;
};

type NamesOf<S extends Specs, I extends string> = {
  [K in keyof S & string]: S[K]['instrument'] extends I ? K : never;
}[keyof S & string];

// Sem atributos declarados, a gravação não leva o argumento.
type AttributesArgument<M extends MetricSpec> =
  keyof M['attributes'] extends never
    ? [attributes?: undefined]
    : [attributes: AttributesOf<M>];

// Grava o valor de um gauge dentro do callback do scrape, com os atributos da declaração.
export type GaugeObservation<M extends MetricSpec> = (
  value: number,
  ...attributes: AttributesArgument<M>
) => void;

export interface ObserveOptions {
  // Chamado uma vez por leitura que falha (lançamento síncrono ou rejeição), antes de a exceção seguir para o SDK.
  onError?: (error: unknown) => void;
}

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
  // Registra o callback que o scrape chama para ler o gauge; devolve a função que o remove. Uma falha do callback
  // mantém o último valor exportado (o exportador é cumulativo); por isso `onError` avisa cada falha, para o
  // chamador contá-la e registrá-la.
  observe<N extends NamesOf<S, 'gauge'>>(
    name: N,
    callback: (observe: GaugeObservation<S[N]>) => void | Promise<void>,
    options?: ObserveOptions,
  ): () => void;
  // Vários gauges lidos por uma consulta só: o callback recebe uma gravação por nome pedido, e o SDK só aceita
  // observar nele os gauges associados (Meter.addBatchObservableCallback).
  observeBatch<N extends NamesOf<S, 'gauge'>>(
    names: readonly N[],
    callback: (observe: {
      [K in N]: GaugeObservation<S[K]>;
    }) => void | Promise<void>,
    options?: ObserveOptions,
  ): () => void;
}

type Instrument = Counter | UpDownCounter | Histogram | ObservableGauge;

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
    case 'gauge':
      return meter.createObservableGauge(name, options);
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

// Por dentro a gravação é frouxa; a tipagem pela declaração está em `TypedMetrics`.
type GaugeWriter = (value: number, attributes?: Attributes) => void;
type ObserveCallback = (observe: GaugeWriter) => void | Promise<void>;
// O objeto do lote tem uma chave por nome pedido, tipada em `TypedMetrics`; por dentro `never` aceita o callback
// de qualquer declaração. PENDENTE (A5): sem cast ainda não fecha o tipo; ver o relatório.
type ObserveBatchCallback = (observe: never) => void | Promise<void>;

// Avisa a falha da leitura antes de devolvê-la ao SDK. O exportador cumulativo segue exportando o último valor
// quando o callback lança: sem este aviso a falha do banco ou da fila não deixa sinal nenhum.
async function reportingFailure(
  read: () => void | Promise<void>,
  options: ObserveOptions | undefined,
): Promise<void> {
  try {
    await read();
  } catch (error) {
    options?.onError?.(error);
    throw error;
  }
}

// ObservableGauge.addCallback / removeCallback: o SDK espera o callback assíncrono antes de escrever o scrape.
function observeGauge(
  gauge: ObservableGauge,
  callback: ObserveCallback,
  options: ObserveOptions | undefined,
): () => void {
  const observable: ObservableCallback = (result) =>
    reportingFailure(
      () => callback((value, attributes) => result.observe(value, attributes)),
      options,
    );
  gauge.addCallback(observable);
  return () => gauge.removeCallback(observable);
}

// Meter.addBatchObservableCallback: um callback para vários gauges; só os associados podem ser observados nele.
function observeGauges(
  meter: Meter,
  { names, gauges }: { names: readonly string[]; gauges: ObservableGauge[] },
  callback: ObserveBatchCallback,
  options: ObserveOptions | undefined,
): () => void {
  const observable: BatchObservableCallback = (result) => {
    const writers: Record<string, GaugeWriter> = Object.fromEntries(
      names.map((name, index) => [
        name,
        (value: number, attributes?: Attributes) =>
          result.observe(gauges[index]!, value, attributes),
      ]),
    );
    return reportingFailure(() => callback(writers as never), options);
  };
  meter.addBatchObservableCallback(observable, gauges);
  return () => meter.removeBatchObservableCallback(observable, gauges);
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
  const pickGauge = (name: string): ObservableGauge => {
    const instrument = pick(name);
    if (!('addCallback' in instrument))
      throw new Error(`métrica não é um gauge: ${name}`);
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
    observe: (
      name: string,
      callback: ObserveCallback,
      options?: ObserveOptions,
    ) => observeGauge(pickGauge(name), callback, options),
    observeBatch: (
      names: readonly string[],
      callback: ObserveBatchCallback,
      options?: ObserveOptions,
    ) =>
      observeGauges(
        meter,
        { names, gauges: names.map(pickGauge) },
        callback,
        options,
      ),
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
