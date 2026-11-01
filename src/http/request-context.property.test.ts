import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Request, RequestHandler, Response } from 'express';
import * as fc from 'fast-check';
import type { Logger } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/helpers/logs.ts';
import {
  promLabel,
  promName,
  scrapeMetrics,
} from '../../test/helpers/metrics.ts';
import {
  expectFalsified,
  expectProperty,
} from '../../test/helpers/properties.ts';
import {
  propertyTimeoutMs,
  readPropertyConfig,
} from '../../test/helpers/property-setup.ts';
import {
  DURATION_METRIC,
  interceptingTelemetry,
  type RecordedAttributes,
} from '../../test/helpers/telemetry-intercept.ts';
import { CorrelationId } from '../contract/index.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { requestContext } from './request-context.ts';

// FND-15, "Contexto da requisição": qualquer X-Request-Id recebido vira um correlationId válido pelo contrato, e
// qualquer status de 100 a 599 vira o atributo `http.response.status_code` da duração HTTP (o `error.type` só nas
// respostas 5xx), no lugar da antiga classe `Nxx` (AD-029). O middleware roda direto sobre objetos de requisição
// e resposta do Node: um status 1xx não sai por uma conexão HTTP de verdade (o cliente o trata como resposta
// parcial).

type Factory = (telemetry: Telemetry, logger: Logger) => RequestHandler;

const telemetry = createTelemetry();
const { logger } = captureLogs('casecellshop-api', 'silent');
const STATUS_ATTRIBUTE = 'http.response.status_code';
const ERROR_ATTRIBUTE = 'error.type';

afterAll(() => telemetry.shutdown());

interface Exchange {
  req: Request;
  res: Response;
  nextCalls: number;
}

// Requisição e resposta reais do Node, com o que o Express acrescenta (`locals`); o cabeçalho entra como veio,
// inclusive como lista, que o Node nunca entrega para esse nome mas o tipo permite. A resposta ainda não foi
// enviada: o middleware roda antes do handler e põe o X-Request-Id nela, o que um cabeçalho já enviado recusaria.
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

// O handler responde: pela convenção, o status só é gravado quando a resposta foi enviada (`headersSent`). O
// `writeHead` monta o cabeçalho sem precisar de conexão e aceita qualquer código de 100 a 599, inclusive os 1xx,
// que o `flushHeaders` (com a conexão) trataria à parte; depois vem o `finish`, como no fim de uma resposta.
function finishResponse(exchange: Exchange): void {
  exchange.res.writeHead(exchange.res.statusCode);
  expect(exchange.res.headersSent).toBe(true);
  exchange.res.emit('finish');
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

// Quantas medições o /metrics acumulou por código de status.
async function statusCounts(): Promise<Map<string, number>> {
  const families = await scrapeMetrics(telemetry);
  const duration = promName(DURATION_METRIC);
  const counts = new Map<string, number>();
  for (const sample of families.get(duration)?.samples ?? []) {
    const label = sample.labels[promLabel(STATUS_ATTRIBUTE)];
    if (sample.name === `${duration}_count` && label !== undefined)
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

// A telemetria entregue ao middleware repassa a medição à real e guarda os atributos de cada uma: a propriedade
// confere os atributos de cada caso sem raspar o /metrics 2 vezes por caso (com 1000 casos, eram 2.000
// raspagens e estourava o prazo); o /metrics é raspado uma vez antes e uma depois da propriedade inteira.
function recordingTelemetry(recorded: RecordedAttributes[]): Telemetry {
  return interceptingTelemetry(telemetry, (attributes, forward) => {
    recorded.push({ ...attributes });
    forward(attributes);
  });
}

// `executed` conta, por código de status, os casos que passaram pelo middleware (inclusive os da redução do
// contraexemplo), para somar com o que o /metrics acumulou.
function statusBecomesItsCode(make: Factory, executed: Map<string, number>) {
  const recorded: RecordedAttributes[] = [];
  const target = recordingTelemetry(recorded);
  return fc.property(fc.integer({ min: 100, max: 599 }), (status) => {
    recorded.length = 0;
    const exchange = exchangeWith('abc', status);
    run(make, exchange, target);
    finishResponse(exchange);

    executed.set(String(status), (executed.get(String(status)) ?? 0) + 1);
    expect(recorded).toHaveLength(1);
    const attributes = recorded[0] ?? {};
    // O código sai como está, sem arredondar para a classe.
    expect(String(attributes[STATUS_ATTRIBUTE])).toBe(String(status));
    // O error.type só existe na resposta 5xx, com o código como texto.
    expect(attributes[ERROR_ATTRIBUTE]).toBe(
      status >= 500 ? String(status) : undefined,
    );
    expect(attributes['http.request.method']).toBe('GET');
    // Sem rota casada, a convenção manda não gravar o http.route: nem `unmatched`, nem o caminho da URL.
    expect(Object.keys(attributes)).not.toContain('http.route');
    expect(['http', 'https']).toContain(attributes['url.scheme']);
    // Os nomes antigos (rótulos próprios do Prometheus) não voltam.
    for (const old of ['route', 'method', 'status_class'])
      expect(Object.keys(attributes)).not.toContain(old);
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

// Só o 200 e o 5xx: o resto das respostas cai no 200 (a classe 2xx inteira, 3xx e 4xx incluídas). A telemetria
// entregue ao middleware troca o atributo.
const collapsedStatus: Factory = (target, log) =>
  requestContext(
    interceptingTelemetry(target, (attributes, forward) => {
      const status = Number(attributes[STATUS_ATTRIBUTE]);
      forward({
        ...attributes,
        [STATUS_ATTRIBUTE]: status >= 500 ? status : 200,
      });
    }),
    log,
  );

// O 5xx sem o error.type: a propriedade tem de exigir o atributo da convenção.
const omitsErrorType: Factory = (target, log) =>
  requestContext(
    interceptingTelemetry(target, (attributes, forward) => {
      forward({ ...attributes, [ERROR_ATTRIBUTE]: undefined });
    }),
    log,
  );

// A requisição que casou com uma rota do contrato leva o template no `res.locals`; a duração HTTP grava esse
// template como `http.route`, e nunca o caminho concreto.
const routeArb = fc.constantFrom(
  '/products',
  '/products/{sku}',
  '/orders/{orderId}',
  '/checkout',
);

function matchedRouteBecomesTheTemplate(make: Factory) {
  const recorded: RecordedAttributes[] = [];
  const target = recordingTelemetry(recorded);
  return fc.property(
    routeArb,
    fc.integer({ min: 100, max: 599 }),
    (route, status) => {
      recorded.length = 0;
      const exchange = exchangeWith('abc', status);
      exchange.res.locals['route'] = route;
      run(make, exchange, target);
      finishResponse(exchange);

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.['http.route']).toBe(route);
    },
  );
}

// O valor inventado que a primeira versão gravava quando não havia rota (e que escondia a rota casada).
const inventsRoute: Factory = (target, log) =>
  requestContext(
    interceptingTelemetry(target, (attributes, forward) => {
      forward({ ...attributes, 'http.route': 'unmatched' });
    }),
    log,
  );

// A rota perdida: o template casado não chega à medição.
const dropsMatchedRoute: Factory = (target, log) =>
  requestContext(
    interceptingTelemetry(target, (attributes, forward) => {
      const { 'http.route': _route, ...rest } = attributes;
      forward(rest);
    }),
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

describe('FND-15 requestContext: código do status', () => {
  it(
    'FND-15 qualquer status de 100 a 599 vira o atributo http.response.status_code da duração HTTP, e o error.type só no 5xx',
    async () => {
      const executed = new Map<string, number>();
      const before = await statusCounts();
      expectProperty(statusBecomesItsCode(requestContext, executed));
      const after = await statusCounts();

      // O /metrics acumulou exatamente os casos executados, cada um no código do seu status.
      for (const code of new Set([...before.keys(), ...after.keys()])) {
        expect((after.get(code) ?? 0) - (before.get(code) ?? 0)).toBe(
          executed.get(code) ?? 0,
        );
      }
      expect(
        [...executed.values()].reduce((sum, count) => sum + count, 0),
      ).toBe(readPropertyConfig().numRuns);
    },
    propertyTimeoutMs(),
  );

  it('FND-15 controle negativo: a mesma propriedade reprova o middleware que junta todos os status que não são 5xx no 200', () => {
    expectFalsified(statusBecomesItsCode(collapsedStatus, new Map()));
  });

  it('FND-15 controle negativo: a mesma propriedade reprova o middleware que deixa o 5xx sem error.type', () => {
    expectFalsified(statusBecomesItsCode(omitsErrorType, new Map()));
  });

  it('FND-15 controle negativo: a mesma propriedade reprova o middleware que inventa o http.route unmatched quando não há rota', () => {
    expectFalsified(statusBecomesItsCode(inventsRoute, new Map()));
  });
});

describe('FND-15 requestContext: http.route', () => {
  it('FND-15 a requisição que casou com uma rota grava o template dela em http.route', () => {
    expectProperty(matchedRouteBecomesTheTemplate(requestContext));
  });

  it('FND-15 controle negativo: a propriedade da rota reprova o middleware que troca o template por unmatched', () => {
    expectFalsified(matchedRouteBecomesTheTemplate(inventsRoute));
  });

  it('FND-15 controle negativo: a propriedade da rota reprova o middleware que perde o template', () => {
    expectFalsified(matchedRouteBecomesTheTemplate(dropsMatchedRoute));
  });
});
