import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';

// OBS-07 (AD-029): a forma das declarações de telemetria. Cada pasta de src/ declara as próprias métricas e os
// próprios eventos de log num telemetry.ts, ao lado do código que os emite; aqui ficam só os tipos e a conferência
// das regras de nome, sem nenhum nome de negócio (AD-025). scripts/telemetry-catalog.ts junta as declarações para
// a documentação e para os testes.
// Os valores que um atributo aceita. A lista fechada (`values`) é a regra; o código de status HTTP (inteiro
// de 100 a 599) e a rota (o template da rota do contrato, ausente sem match) têm cardinalidade limitada pela
// própria forma, e não por uma lista.
export type AttributeValues =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'http_status_code' }
  | { readonly kind: 'http_route' };

// O nível de exigência do atributo, pela convenção do OpenTelemetry: o `required` vai em toda gravação; o
// `conditionally_required` só quando a condição da descrição vale (o `error.type` só quando houve erro).
export type AttributeRequirement = 'required' | 'conditionally_required';

export interface AttributeSpec {
  readonly description: string;
  readonly requirement: AttributeRequirement;
  readonly values: AttributeValues;
}

export type InstrumentKind = 'counter' | 'histogram' | 'up_down_counter';

export interface MetricSpec {
  readonly instrument: InstrumentKind;
  // UCUM: `s` para tempo; uma anotação entre chaves (`{request}`) para contagem.
  readonly unit: string;
  readonly description: string;
  // Só nos histogramas: as fronteiras, ligadas aos SLOs (AD-029).
  readonly buckets?: readonly number[];
  readonly attributes: Readonly<Record<string, AttributeSpec>>;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEventSpec {
  readonly level: LogLevel;
  readonly description: string;
  // Os campos próprios do evento, além dos que todo log leva (service, env, version, correlationId,
  // trace_id, span_id, trace_flags). `err` é o erro serializado pelo pino.
  readonly fields: readonly string[];
}

// Um segmento em snake_case; os nomes próprios levam o prefixo `casecellshop` e ao menos um segmento depois.
const SEGMENT = '[a-z][a-z0-9]*(?:_[a-z0-9]+)*';
const OWN_NAME = new RegExp(`^casecellshop(?:\\.${SEGMENT})+$`);
const EVENT_NAME = new RegExp(`^casecellshop(?:\\.${SEGMENT}){2,}$`);
const SNAKE_CASE = new RegExp(`^${SEGMENT}$`);
// A unidade vai no `unit`, nunca no nome, em qualquer palavra; `total` é do exportador, que o acrescenta aos
// contadores, e só vale como última palavra.
const UNIT_WORDS = new Set<string>([
  ...'s ms us ns kb mb gb kib mib gib percent'.split(' '),
  ...'second millisecond microsecond nanosecond minute hour day byte bit'.split(
    ' ',
  ),
  ...'seconds milliseconds microseconds nanoseconds minutes hours days bytes bits'.split(
    ' ',
  ),
]);

function redundantWord(name: string): string | undefined {
  const words = name.split(/[._]/);
  return (
    words.find((word) => UNIT_WORDS.has(word)) ??
    (words.at(-1) === 'total' ? 'total' : undefined)
  );
}
// A convenção do OpenTelemetry tem nomes próprios, sem o prefixo: só estes escapam da regra do prefixo.
const CONVENTION_METRICS = new Set<string>([
  METRIC_HTTP_SERVER_REQUEST_DURATION,
]);
const CONVENTION_ATTRIBUTES = new Set<string>([
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
]);

function enumViolations(
  metric: string,
  name: string,
  values: readonly string[],
): string[] {
  const where = `do atributo ${name} da métrica ${metric}`;
  const violations: string[] = [];
  if (values.length === 0)
    violations.push(`a lista de valores ${where} está vazia`);
  if (new Set(values).size !== values.length)
    violations.push(`a lista de valores ${where} repete um valor`);
  // Os métodos HTTP seguem a convenção (`GET`, `_OTHER`), e não o snake_case.
  if (name === ATTR_HTTP_REQUEST_METHOD) return violations;
  for (const value of values)
    if (!SNAKE_CASE.test(value))
      violations.push(`o valor "${value}" ${where} não está em snake_case`);
  return violations;
}

function attributeViolations(metric: string, spec: MetricSpec): string[] {
  const violations: string[] = [];
  for (const [name, attribute] of Object.entries(spec.attributes)) {
    if (!CONVENTION_ATTRIBUTES.has(name) && !OWN_NAME.test(name))
      violations.push(
        `o atributo ${name} da métrica ${metric} não segue o padrão casecellshop.<namespace>.<nome> em snake_case`,
      );
    if (!attribute.description)
      violations.push(
        `o atributo ${name} da métrica ${metric} não tem descrição`,
      );
    // O tipo já exige o campo, mas o catálogo também vem de JSON e de cast: a conferência vale em tempo de execução.
    const requirement: unknown = attribute.requirement;
    if (requirement !== 'required' && requirement !== 'conditionally_required')
      violations.push(
        `o atributo ${name} da métrica ${metric} não declara o nível de exigência (required ou conditionally_required)`,
      );
    if (attribute.values.kind === 'enum')
      violations.push(...enumViolations(metric, name, attribute.values.values));
  }
  return violations;
}

function bucketViolations(metric: string, spec: MetricSpec): string[] {
  const { buckets } = spec;
  if (spec.instrument !== 'histogram')
    return buckets === undefined
      ? []
      : [`a métrica ${metric} não é um histograma e declara fronteiras`];
  if (!buckets || buckets.length === 0)
    return [`o histograma ${metric} não declara fronteiras`];
  const valid =
    buckets.every((bucket) => Number.isFinite(bucket) && bucket >= 0) &&
    buckets.every(
      (bucket, index) => index === 0 || bucket > buckets[index - 1]!,
    );
  return valid
    ? []
    : [
        `as fronteiras do histograma ${metric} não são finitas, não negativas e estritamente crescentes`,
      ];
}

function metricViolations(metric: string, spec: MetricSpec): string[] {
  const violations: string[] = [];
  if (!CONVENTION_METRICS.has(metric) && !OWN_NAME.test(metric))
    violations.push(
      `a métrica ${metric} não segue o padrão casecellshop.<namespace>.<nome> em snake_case`,
    );
  const redundant = redundantWord(metric);
  if (redundant !== undefined)
    violations.push(
      `a métrica ${metric} traz a unidade ou o sufixo total no nome (palavra "${redundant}")`,
    );
  if (!spec.unit) violations.push(`a métrica ${metric} não tem unidade`);
  if (spec.instrument === 'histogram' && spec.unit !== 's')
    violations.push(`o histograma ${metric} tem a unidade ${spec.unit}, não s`);
  if (!spec.description)
    violations.push(`a métrica ${metric} não tem descrição`);
  return [
    ...violations,
    ...bucketViolations(metric, spec),
    ...attributeViolations(metric, spec),
  ];
}

// As violações das regras de nome do OpenTelemetry num catálogo (OBS-07), uma frase por violação, com o nome
// que a causou.
export function catalogViolations(
  metrics: Readonly<Record<string, MetricSpec>>,
  events: Readonly<Record<string, LogEventSpec>>,
): string[] {
  const fromEvents = Object.entries(events).flatMap(([name, spec]) => [
    ...(EVENT_NAME.test(name)
      ? []
      : [
          `o evento ${name} não segue o padrão casecellshop.<domínio>.<evento> em snake_case`,
        ]),
    ...(spec.description ? [] : [`o evento ${name} não tem descrição`]),
  ]);
  return [
    ...Object.entries(metrics).flatMap(([name, spec]) =>
      metricViolations(name, spec),
    ),
    ...fromEvents,
  ];
}
