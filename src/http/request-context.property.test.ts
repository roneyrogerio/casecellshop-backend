import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import * as fc from 'fast-check';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/helpers/logs.ts';
import { scrapeMetrics } from '../../test/helpers/metrics.ts';
import {
  expectFalsified,
  expectProperty,
} from '../../test/helpers/properties.ts';
import {
  propertyTimeoutMs,
  readPropertyConfig,
} from '../../test/helpers/property-setup.ts';
import { CorrelationId } from '../contract/index.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { requestContext } from './request-context.ts';

// FND-15, "Contexto da requisição": qualquer X-Request-Id recebido vira um correlationId válido pelo contrato, e
// qualquer status vira uma das classes 1xx a 5xx no label da métrica. O middleware roda direto sobre objetos de
// requisição e resposta do Node: um status 1xx não sai por uma conexão HTTP de verdade (o cliente o trata como
// resposta parcial).

type Factory = (telemetry: Telemetry, logger: Logger) => RequestHandler;

const telemetry = createTelemetry();
const { logger } = captureLogs('casecellshop-api', 'silent');
const DURATION = 'http_server_request_duration_seconds';
const CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'];

afterAll(() => telemetry.shutdown());

interface Exchange {
  req: Request;
  res: Response;
  nextCalls: number;
}

// Requisição e resposta reais do Node, com o que o Express acrescenta (`locals`); o cabeçalho entra como veio,
// inclusive como lista, que o Node nunca entrega para esse nome mas o tipo permite.
function exchangeWith(requestId: unknown, status = 200): Exchange {
  const incoming = new IncomingMessage(new Socket());
  incoming.method = 'GET';
  incoming.headers = { 'x-request-id': requestId } as Record<string, string>;
  const outgoing = new ServerResponse(incoming);
  outgoing.statusCode = status;
  Object.assign(outgoing, { locals: {} });
  return {
    req: incoming as unknown as Request,
    res: outgoing as unknown as Response,
    nextCalls: 0,
  };
}

function run(
  make: Factory,
  exchange: Exchange,
  target: Telemetry = telemetry,
): void {
  make(target, logger)(exchange.req, exchange.res, () => {
    exchange.nextCalls += 1;
  });
}

async function classCounts(): Promise<Map<string, number>> {
  const families = await scrapeMetrics(telemetry);
  const counts = new Map<string, number>(CLASSES.map((name) => [name, 0]));
  for (const sample of families.get(DURATION)?.samples ?? []) {
    const label = sample.labels['status_class'];
    if (sample.name === `${DURATION}_count` && label !== undefined)
      counts.set(label, (counts.get(label) ?? 0) + sample.value);
  }
  return counts;
}

// Pequenas, longas, vazias, com controle e Unicode, e a lista que o tipo do Node admite.
const requestIdArb = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.constant(''),
  fc.string({ minLength: 129, maxLength: 400 }),
  fc.string({
    unit: fc.constantFrom('\u0000', '\u0007', '\n', '\r', '\t', ' ', '\u007f'),
    minLength: 1,
    maxLength: 10,
  }),
  fc.stringMatching(/^[\x21-\x7E]{1,128}$/),
  fc.array(fc.string(), { maxLength: 4 }),
  fc.constant(undefined),
);

function correlationIdIsValid(make: Factory) {
  return fc.property(requestIdArb, (requestId) => {
    const exchange = exchangeWith(requestId);
    run(make, exchange);

    const correlationId: unknown = exchange.res.locals['correlationId'];
    expect(CorrelationId.safeParse(correlationId).success).toBe(true);
    expect(exchange.res.getHeader('X-Request-Id')).toBe(correlationId);
    expect(exchange.req.headers['x-request-id']).toBe(correlationId);
    expect(exchange.nextCalls).toBe(1);
    // Um identificador já válido segue o mesmo, para o cliente rastrear o pedido pelo que enviou.
    const keepsValidInput =
      typeof requestId === 'string' &&
      CorrelationId.safeParse(requestId).success;
    expect(!keepsValidInput || correlationId === requestId).toBe(true);
  });
}

// A telemetria entregue ao middleware repassa a medição à real e guarda o label `status_class` de cada uma: a
// propriedade confere a classe de cada caso sem raspar o /metrics 2 vezes por caso (com 1000 casos, eram 2.000
// raspagens e estourava o prazo); o /metrics é raspado uma vez antes e uma depois da propriedade inteira.
function recordingTelemetry(labels: (string | undefined)[]): Telemetry {
  return {
    ...telemetry,
    httpRequestDuration: {
      record: (value: number, attributes?: Record<string, string>) => {
        labels.push(attributes?.['status_class']);
        telemetry.httpRequestDuration.record(value, attributes);
      },
    },
  };
}

// `executed` conta, por classe esperada, os casos que passaram pelo middleware (inclusive os da redução do
// contraexemplo), para somar com o que o /metrics acumulou.
function statusBecomesItsClass(make: Factory, executed: Map<string, number>) {
  const recorded: (string | undefined)[] = [];
  const target = recordingTelemetry(recorded);
  return fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
    recorded.length = 0;
    const exchange = exchangeWith('abc', status);
    run(make, exchange, target);
    exchange.res.emit('finish');

    const expected = `${Math.floor(status / 100)}xx`;
    executed.set(expected, (executed.get(expected) ?? 0) + 1);
    expect(recorded).toEqual([expected]);
  });
}

// Versões quebradas do middleware, escritas aqui.
const trustsRequestId: Factory = (target, log) => {
  const real = requestContext(target, log);
  return (req, res, next) => {
    const raw = req.headers['x-request-id'];
    real(req, res, next);
    if (typeof raw === 'string') {
      res.locals['correlationId'] = raw;
      req.headers['x-request-id'] = raw;
    }
  };
};

const generatesNothingForList: Factory = (target, log) => {
  const real = requestContext(target, log);
  return (req, res, next) => {
    const wasList = Array.isArray(req.headers['x-request-id']);
    real(req, res, next);
    if (wasList) res.locals['correlationId'] = undefined;
  };
};

// Só as classes 2xx e 5xx: o resto cai na 2xx. A telemetria entregue ao middleware troca o label.
const collapsedClasses: Factory = (target, log) =>
  requestContext(
    {
      ...target,
      httpRequestDuration: {
        record: (value: number, labels?: Record<string, string>) => {
          target.httpRequestDuration.record(value, {
            ...labels,
            status_class: labels?.['status_class'] === '5xx' ? '5xx' : '2xx',
          });
        },
      },
    },
    log,
  );

describe('FND-15 requestContext: X-Request-Id', () => {
  it('FND-15 qualquer X-Request-Id vira um correlationId válido pelo contrato, no locals, no cabeçalho da resposta e na requisição', () => {
    expectProperty(correlationIdIsValid(requestContext));
  });

  it.each([
    { defect: 'aceita o texto recebido sem conferir', broken: trustsRequestId },
    {
      defect: 'deixa o correlationId vazio quando o cabeçalho é uma lista',
      broken: generatesNothingForList,
    },
  ])(
    'FND-15 controle negativo: a mesma propriedade reprova o middleware que $defect',
    ({ broken }) => {
      expectFalsified(correlationIdIsValid(broken));
    },
  );
});

describe('FND-15 requestContext: classe do status', () => {
  it(
    'FND-15 qualquer status de 100 a 599 vira a classe Nxx correspondente no label da métrica',
    async () => {
      const executed = new Map<string, number>();
      const before = await classCounts();
      expectProperty(statusBecomesItsClass(requestContext, executed));
      const after = await classCounts();

      // O /metrics acumulou exatamente os casos executados, cada um na classe do seu status.
      for (const name of CLASSES) {
        expect((after.get(name) ?? 0) - (before.get(name) ?? 0)).toBe(
          executed.get(name) ?? 0,
        );
      }
      expect(
        [...executed.values()].reduce((sum, count) => sum + count, 0),
      ).toBe(readPropertyConfig().numRuns);
    },
    propertyTimeoutMs(),
  );

  it('FND-15 controle negativo: a mesma propriedade reprova o middleware que junta as classes 1xx a 4xx numa só', () => {
    expectFalsified(statusBecomesItsClass(collapsedClasses, new Map()));
  });
});
