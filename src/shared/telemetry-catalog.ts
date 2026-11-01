// OBS-07 (AD-029): a forma das declarações de telemetria. Cada pasta de src/ declara as próprias métricas e os
// próprios eventos de log num telemetry.ts, ao lado do código que os emite; aqui ficam só os tipos e a conferência
// das regras de nome, sem nenhum nome de negócio (AD-025). scripts/telemetry-catalog.ts junta as declarações para
// a documentação e para os testes.
// Os valores que um atributo aceita. A lista fechada (`values`) é a regra; o código de status HTTP (inteiro
// de 100 a 599) e a rota (o template da rota do contrato, ou `unmatched`) têm cardinalidade limitada pela
// própria forma, e não por uma lista.
export type AttributeValues =
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'http_status_code' }
  | { readonly kind: 'http_route' };

export interface AttributeSpec {
  readonly description: string;
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

// As violações das regras de nome do OpenTelemetry num catálogo (OBS-07), uma frase por violação, com o nome
// que a causou.
export function catalogViolations(
  _metrics: Readonly<Record<string, MetricSpec>>,
  _events: Readonly<Record<string, LogEventSpec>>,
): string[] {
  throw new Error('não implementado');
}
