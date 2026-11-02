import type { Histogram, Meter, MetricOptions } from '@opentelemetry/api';
import type { Telemetry } from '../../src/shared/telemetry.ts';

export const DURATION_METRIC = 'http.server.request.duration';
export type RecordedAttributes = Record<string, string | number | undefined>;

// A interceptação fica no limite do `Telemetry` que o middleware usa: o `meter(scope)` devolve o Meter real
// envolvido, e o histograma da duração HTTP entrega os atributos de cada `record` à função `intercept`, que decide
// o que repassar ao histograma real. Os outros instrumentos do Meter passam sem mudança.
export type Intercept = (
  attributes: RecordedAttributes,
  forward: (attributes: RecordedAttributes) => void,
) => void;

// Envolve um objeto do SDK trocando alguns membros; cada troca recebe o objeto real e devolve o novo membro. Os
// outros membros saem presos ao objeto real, porque o SDK usa campos privados.
export function overriding<T extends object>(
  real: T,
  replacements: Partial<Record<keyof T, (real: T) => unknown>>,
): T {
  return new Proxy(real, {
    get: (target, property): unknown => {
      const replace = (
        replacements as Record<PropertyKey, ((real: T) => unknown) | undefined>
      )[property];
      if (replace) return replace(target);
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function'
        ? (member as (...args: unknown[]) => unknown).bind(target)
        : member;
    },
  });
}

function interceptMeter(meter: Meter, intercept: Intercept): Meter {
  const createHistogram = (
    name: string,
    options?: MetricOptions,
  ): Histogram => {
    const histogram = meter.createHistogram(name, options);
    if (name !== DURATION_METRIC) return histogram;
    return {
      record: (value, attributes, context) => {
        intercept({ ...attributes } as RecordedAttributes, (forwarded) => {
          histogram.record(value, forwarded, context);
        });
      },
    };
  };
  return overriding(meter, { createHistogram: () => createHistogram });
}

export function interceptingTelemetry(
  target: Telemetry,
  intercept: Intercept,
): Telemetry {
  return {
    ...target,
    meter: (scope) => interceptMeter(target.meter(scope), intercept),
  };
}
