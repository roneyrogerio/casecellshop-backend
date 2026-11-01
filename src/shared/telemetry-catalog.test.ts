import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_SCHEME,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, it } from 'vitest';
import { catalogViolations } from './telemetry-catalog.ts';

// OBS-07 (AD-029): as regras do catálogo da telemetria, conferidas por `catalogViolations`. Cada regra tem um
// controle negativo: um catálogo montado aqui, igual ao de base menos o defeito, que a função tem de acusar. O de
// base não tem violação, então o que a função acusa é o defeito do controle e mais nada. A mensagem cita o nome
// com defeito (a métrica, o atributo ou o evento), para quem lê o resultado saber onde corrigir.

type Metrics = Parameters<typeof catalogViolations>[0];
type Events = Parameters<typeof catalogViolations>[1];
type MetricSpec = Metrics[string];
type EventSpec = Events[string];

const VALID_COUNTER: MetricSpec = {
  instrument: 'counter',
  unit: '{request}',
  description: 'Checkouts por desfecho.',
  attributes: {
    'casecellshop.checkout.outcome': {
      description: 'Desfecho do checkout.',
      requirement: 'required',
      values: { kind: 'enum', values: ['accepted', 'out_of_stock'] },
    },
  },
};

const VALID_HISTOGRAM: MetricSpec = {
  instrument: 'histogram',
  unit: 's',
  description: 'Duração.',
  buckets: [0.1, 1, 10],
  attributes: {},
};

const VALID_UP_DOWN: MetricSpec = {
  instrument: 'up_down_counter',
  unit: '{operation}',
  description: 'Chamadas em andamento.',
  attributes: {},
};

// A duração HTTP da convenção do OpenTelemetry: o nome e os atributos não começam por `casecellshop.`, e os
// métodos HTTP seguem a convenção (`GET`, `_OTHER`), e não o snake_case.
const VALID_HTTP: MetricSpec = {
  instrument: 'histogram',
  unit: 's',
  description: 'Duração das requisições HTTP.',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 10],
  attributes: {
    [ATTR_HTTP_REQUEST_METHOD]: {
      description: 'Método HTTP.',
      requirement: 'required',
      values: { kind: 'enum', values: ['GET', 'POST', '_OTHER'] },
    },
    [ATTR_HTTP_ROUTE]: {
      description: 'Rota.',
      requirement: 'required',
      values: { kind: 'http_route' },
    },
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: {
      description: 'Status.',
      requirement: 'required',
      values: { kind: 'http_status_code' },
    },
    [ATTR_URL_SCHEME]: {
      description: 'Esquema.',
      requirement: 'required',
      values: { kind: 'enum', values: ['http', 'https'] },
    },
    [ATTR_ERROR_TYPE]: {
      description: 'Só no 5xx.',
      requirement: 'conditionally_required',
      values: { kind: 'http_status_code' },
    },
  },
};

const VALID_EVENT: EventSpec = {
  level: 'info',
  description: 'Checkout aceito.',
  fields: ['orderId'],
};

const BASE_METRICS: Metrics = {
  [METRIC_HTTP_SERVER_REQUEST_DURATION]: VALID_HTTP,
  'casecellshop.valid.requests': VALID_COUNTER,
  'casecellshop.valid.duration': VALID_HISTOGRAM,
  'casecellshop.valid.active_operations': VALID_UP_DOWN,
};

const BASE_EVENTS: Events = {
  'casecellshop.checkout.accepted': VALID_EVENT,
  'casecellshop.checkout.db.unavailable': {
    ...VALID_EVENT,
    level: 'warn',
    fields: ['err', 'step'],
  },
};

// Acusa o catálogo de base mais a métrica com defeito, e a mensagem cita um dos nomes culpados.
function expectMetricRejected(
  name: string,
  spec: MetricSpec,
  culprits: string[] = [name],
): void {
  const violations = catalogViolations(
    { ...BASE_METRICS, [name]: spec },
    BASE_EVENTS,
  );
  expect(violations.length, `violações de ${name}`).toBeGreaterThan(0);
  expect(
    violations.some((violation) =>
      culprits.some((culprit) => violation.includes(culprit)),
    ),
    `a mensagem cita ${culprits.join(' ou ')}: ${violations.join(' | ')}`,
  ).toBe(true);
}

function expectEventRejected(
  name: string,
  spec: EventSpec = VALID_EVENT,
): void {
  const violations = catalogViolations(BASE_METRICS, {
    ...BASE_EVENTS,
    [name]: spec,
  });
  expect(violations.length, `violações de ${name}`).toBeGreaterThan(0);
  expect(
    violations.some((violation) => violation.includes(name)),
    `a mensagem cita ${name}: ${violations.join(' | ')}`,
  ).toBe(true);
}

function withAttribute(attribute: string, values: string[]): MetricSpec {
  return {
    ...VALID_COUNTER,
    attributes: {
      [attribute]: {
        description: 'Atributo.',
        requirement: 'required',
        values: { kind: 'enum', values },
      },
    },
  };
}

// Um atributo cujo `requirement` o tipo não deixaria passar: o objeto vem de um JSON ou de um cast, e a função
// tem de acusá-lo mesmo assim.
function withRequirement(requirement: unknown): MetricSpec {
  const attribute = {
    description: 'Atributo.',
    values: { kind: 'enum', values: ['accepted'] },
    ...(requirement === undefined ? {} : { requirement }),
  } as unknown as MetricSpec['attributes'][string];
  return {
    ...VALID_COUNTER,
    attributes: { 'casecellshop.broken.kind': attribute },
  };
}

const METRIC = 'casecellshop.broken.requests';
const HISTOGRAM = 'casecellshop.broken.duration';

describe('OBS-07 regras do catálogo da telemetria: o que é válido passa', () => {
  it('OBS-07 o catálogo de base (contador, histograma, up_down_counter, a duração HTTP da convenção e dois eventos) não tem violação', () => {
    expect(catalogViolations(BASE_METRICS, BASE_EVENTS)).toEqual([]);
  });

  it('OBS-07 o catálogo vazio não tem violação', () => {
    expect(catalogViolations({}, {})).toEqual([]);
  });

  it('OBS-07 o resultado é uma lista de textos, que o teste do catálogo real compara com a lista vazia', () => {
    const violations = catalogViolations(
      { ...BASE_METRICS, 'broken.requests_total': VALID_COUNTER },
      BASE_EVENTS,
    );
    expect(violations.every((violation) => typeof violation === 'string')).toBe(
      true,
    );
  });
});

describe('OBS-07 controles negativos: o nome da métrica', () => {
  it.each([
    ['termina em _total', 'casecellshop.broken.requests_total'],
    ['termina em .total', 'casecellshop.broken.total'],
    ['traz a unidade seconds', 'casecellshop.broken.duration_seconds'],
    ['traz a unidade ms', 'casecellshop.broken.duration_ms'],
    ['traz a unidade bytes', 'casecellshop.broken.payload_bytes'],
    ['não tem o prefixo casecellshop.', 'broken.requests'],
    ['tem maiúscula', 'casecellshop.broken.Requests'],
    ['usa hífen', 'casecellshop.broken-requests'],
    ['usa sublinhado duplo', 'casecellshop.broken__requests'],
    ['tem um segmento vazio', 'casecellshop..requests'],
    ['termina em ponto', 'casecellshop.broken.'],
  ])(
    'OBS-07 controle negativo: a métrica cujo nome %s é acusada',
    (_defect, name) => {
      expectMetricRejected(name, VALID_COUNTER);
    },
  );

  it('OBS-07 controle negativo: o nome da convenção sem o prefixo vale só para a duração HTTP, e nenhum outro', () => {
    expectMetricRejected('http.server.request.count', VALID_COUNTER);
  });

  // A unidade vai no campo `unit`, e não no nome: o nome é dividido em palavras por `.` e `_`, e uma palavra que
  // é unidade reprova em qualquer posição; `total` reprova só como última palavra.
  it.each([
    ['uma unidade abreviada no fim (s)', 'casecellshop.x.duration_s'],
    ['uma unidade no plural no meio do nome', 'casecellshop.x.wait_minutes'],
    ['uma unidade no começo de um segmento', 'casecellshop.x.seconds.max'],
    ['uma unidade binária (kib)', 'casecellshop.x.size_kib'],
    ['total no fim', 'casecellshop.x.requests_total'],
    [
      'uma unidade no meio, seguida de outra palavra',
      'casecellshop.x.bytes_sent',
    ],
    ['a unidade percent', 'casecellshop.x.cpu_percent'],
    ['a unidade bits', 'casecellshop.x.rate_bits'],
    ['a unidade ns', 'casecellshop.x.latency_ns.p99'],
    ['a unidade day', 'casecellshop.x.age_day'],
    ['a abreviação secs no fim', 'casecellshop.x.wait_secs'],
    ['a abreviação sec no fim', 'casecellshop.x.wait_sec'],
    ['a abreviação mins no fim', 'casecellshop.x.wait_mins'],
    ['a abreviação msec no fim', 'casecellshop.x.timeout_msec'],
    ['a abreviação msecs no meio', 'casecellshop.x.timeout_msecs.max'],
    ['a abreviação usec no fim', 'casecellshop.x.latency_usec'],
    ['a abreviação usecs no fim', 'casecellshop.x.latency_usecs'],
    ['a abreviação min no começo de um segmento', 'casecellshop.x.min_wait'],
  ])(
    'OBS-07 controle negativo: a métrica cujo nome tem %s é acusada, em qualquer posição',
    (_defect, name) => {
      expectMetricRejected(name, VALID_COUNTER);
    },
  );

  it.each([
    'casecellshop.outbox.published.messages',
    'casecellshop.erp.client.active_operations',
    'casecellshop.x.sessions',
    'casecellshop.x.total_cost',
    'casecellshop.x.hourly_rate',
    'casecellshop.x.kbd_events',
    'casecellshop.x.minimum_stock',
    'casecellshop.x.secondary_requests',
    'casecellshop.x.admin_requests',
    'casecellshop.x.section_views',
  ])(
    'OBS-07 o nome %s, sem palavra de unidade e sem total no fim, não tem violação',
    (name) => {
      expect(
        catalogViolations(
          { ...BASE_METRICS, [name]: VALID_COUNTER },
          BASE_EVENTS,
        ),
      ).toEqual([]);
    },
  );
});

describe('OBS-07 controles negativos: os atributos da métrica', () => {
  it('OBS-07 controle negativo: o atributo próprio sem o prefixo casecellshop. é acusado', () => {
    expectMetricRejected(
      METRIC,
      withAttribute('broken.outcome', ['accepted']),
      ['broken.outcome', METRIC],
    );
  });

  it('OBS-07 controle negativo: o atributo com maiúscula é acusado', () => {
    expectMetricRejected(
      METRIC,
      withAttribute('casecellshop.broken.Outcome', ['accepted']),
      ['casecellshop.broken.Outcome', METRIC],
    );
  });

  it('OBS-07 controle negativo: o enum vazio é acusado', () => {
    expectMetricRejected(
      METRIC,
      withAttribute('casecellshop.broken.kind', []),
      ['casecellshop.broken.kind', METRIC],
    );
  });

  it('OBS-07 controle negativo: o enum com valor repetido é acusado', () => {
    expectMetricRejected(
      METRIC,
      withAttribute('casecellshop.broken.kind', ['a', 'b', 'a']),
      ['casecellshop.broken.kind', METRIC],
    );
  });

  it('OBS-07 controle negativo: o atributo sem requirement é acusado', () => {
    expectMetricRejected(METRIC, withRequirement(undefined), [
      'casecellshop.broken.kind',
      METRIC,
    ]);
  });

  it.each(['optional', 'recommended', 'Required', '', null, true])(
    'OBS-07 controle negativo: o atributo com requirement %j, fora de required e conditionally_required, é acusado',
    (requirement) => {
      expectMetricRejected(METRIC, withRequirement(requirement), [
        'casecellshop.broken.kind',
        METRIC,
      ]);
    },
  );

  it.each(['required', 'conditionally_required'])(
    'OBS-07 o atributo com requirement %s não tem violação',
    (requirement) => {
      expect(
        catalogViolations(
          { ...BASE_METRICS, [METRIC]: withRequirement(requirement) },
          BASE_EVENTS,
        ),
      ).toEqual([]);
    },
  );

  it.each(['OutOfStock', 'out-of-stock', 'Accepted', 'a b', ''])(
    'OBS-07 controle negativo: o valor de enum "%s" fora do snake_case é acusado',
    (value) => {
      expectMetricRejected(
        METRIC,
        withAttribute('casecellshop.broken.kind', ['ok', value]),
        ['casecellshop.broken.kind', METRIC],
      );
    },
  );
});

describe('OBS-07 controles negativos: o instrumento, a unidade e as fronteiras', () => {
  it.each([
    ['fora de ordem', [1, 0.5, 2]],
    ['repetidas', [0.1, 0.1, 1]],
    ['negativas', [-1, 1, 2]],
    ['com infinito', [1, 2, Infinity]],
    ['vazias', []],
  ])(
    'OBS-07 controle negativo: o histograma com fronteiras %s é acusado',
    (_defect, buckets) => {
      expectMetricRejected(HISTOGRAM, { ...VALID_HISTOGRAM, buckets });
    },
  );

  it('OBS-07 controle negativo: o histograma sem fronteiras é acusado', () => {
    const { buckets: _buckets, ...withoutBuckets } = VALID_HISTOGRAM;
    expectMetricRejected(HISTOGRAM, withoutBuckets);
  });

  it.each(['ms', 'seconds', '{request}'])(
    'OBS-07 controle negativo: o histograma com a unidade "%s", que não é s, é acusado',
    (unit) => {
      expectMetricRejected(HISTOGRAM, { ...VALID_HISTOGRAM, unit });
    },
  );

  it.each(['counter', 'up_down_counter'] as const)(
    'OBS-07 controle negativo: o %s com fronteiras é acusado',
    (instrument) => {
      expectMetricRejected(METRIC, {
        ...VALID_COUNTER,
        instrument,
        buckets: [1, 2],
      });
    },
  );

  it('OBS-07 controle negativo: a unidade vazia é acusada', () => {
    expectMetricRejected(METRIC, { ...VALID_COUNTER, unit: '' });
  });

  it('OBS-07 controle negativo: a descrição vazia é acusada', () => {
    expectMetricRejected(METRIC, { ...VALID_COUNTER, description: '' });
  });
});

describe('OBS-07 controles negativos: o nome do evento de log', () => {
  it.each([
    ['não tem o prefixo casecellshop.', 'checkout.accepted'],
    ['usa o estilo antigo, sem prefixo nem domínio', 'checkout_accepted'],
    ['não tem o evento depois do domínio', 'casecellshop.checkout'],
    ['tem maiúscula', 'casecellshop.checkout.Accepted'],
    ['usa hífen', 'casecellshop.checkout.price-changed'],
    ['usa sublinhado duplo', 'casecellshop.checkout.price__changed'],
    ['tem um segmento vazio', 'casecellshop..accepted'],
    ['termina em ponto', 'casecellshop.checkout.accepted.'],
  ])(
    'OBS-07 controle negativo: o evento cujo nome %s é acusado',
    (_defect, name) => {
      expectEventRejected(name);
    },
  );

  it('OBS-07 controle negativo: o evento com descrição vazia é acusado', () => {
    expectEventRejected('casecellshop.checkout.rejected', {
      ...VALID_EVENT,
      description: '',
    });
  });
});
