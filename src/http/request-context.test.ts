import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Span, Tracer } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import express, { type RequestHandler, type Response } from 'express';
import type { Logger } from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { captureLogs } from '../../test/helpers/logs.ts';
import {
  interceptingTelemetry,
  overriding,
  type RecordedAttributes,
} from '../../test/helpers/telemetry-intercept.ts';
import { createTelemetry, type Telemetry } from '../shared/telemetry.ts';
import { requestContext } from './request-context.ts';

// OBS-07, item "Span HTTP": o middleware real, atrás de um servidor HTTP de verdade em porta 0 (o cliente que
// fecha a conexão e um método fora da lista só existem numa conexão de verdade), com o span lido do exportador em
// memória e a duração HTTP lida no limite do Meter. Nenhum teste espera um prazo fixo: cada um espera o `close` da
// resposta, que o servidor emite quando a requisição termina.

type Factory = (telemetry: Telemetry, logger: Logger) => RequestHandler;

const exporter = new InMemorySpanExporter();
const telemetry = createTelemetry({ spanExporter: exporter });
const { logger } = captureLogs('casecellshop-api', 'silent');
const STATUS_ATTRIBUTE = 'http.response.status_code';
const ERROR_ATTRIBUTE = 'error.type';

afterAll(() => telemetry.shutdown());

beforeEach(async () => {
  await telemetry.forceFlush();
  exporter.reset();
});

// A telemetria entregue ao middleware repassa a medição à real e guarda os atributos de cada uma.
function recordingTelemetry(recorded: RecordedAttributes[]): Telemetry {
  return interceptingTelemetry(telemetry, (attributes, forward) => {
    recorded.push({ ...attributes });
    forward(attributes);
  });
}

async function listen(
  handler: RequestHandler,
  make: Factory,
  target: Telemetry,
) {
  const app = express();
  app.use(make(target, logger));
  app.use(handler);
  const server = createServer(app);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return { server, port: address.port };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

interface Exchange {
  span: ReadableSpan;
  metric: RecordedAttributes;
}

async function exchangeOf(recorded: RecordedAttributes[]): Promise<Exchange> {
  await telemetry.forceFlush();
  const spans = exporter.getFinishedSpans();
  expect(spans, 'deveria haver um único span da requisição').toHaveLength(1);
  const [span] = spans;
  expect(recorded, 'deveria haver uma única medição').toHaveLength(1);
  const [metric] = recorded;
  if (!span || !metric) throw new Error('span ou medição ausente');
  return { span, metric };
}

// O cliente envia a requisição, espera o servidor recebê-la e fecha a conexão sem receber resposta; o servidor
// emite o `close` da resposta quando percebe, e é nele que o teste espera. O handler pode antes enviar os
// cabeçalhos (`status`), o que conta como resposta enviada.
async function abortedExchange(
  make: Factory,
  status?: number,
): Promise<Exchange> {
  const recorded: RecordedAttributes[] = [];
  let onReached!: (res: Response) => void;
  const reached = new Promise<Response>((resolve) => {
    onReached = resolve;
  });
  const { server, port } = await listen(
    (_req, res) => {
      res.locals['route'] = '/hang';
      if (status !== undefined) {
        res.status(status);
        res.flushHeaders();
      }
      onReached(res);
    },
    make,
    recordingTelemetry(recorded),
  );
  try {
    const outgoing = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/hang',
      agent: false,
    });
    // Destruir a requisição sem resposta acusa "socket hang up" no cliente; é o esperado.
    outgoing.on('error', () => undefined);
    outgoing.end();
    const res = await reached;
    const closed = new Promise<void>((resolve) => {
      res.once('close', () => resolve());
    });
    outgoing.destroy();
    await closed;
    return await exchangeOf(recorded);
  } finally {
    await closeServer(server);
  }
}

// Uma requisição que o servidor responde: o método, o caminho e a rota casada (se houver) variam.
async function answeredExchange(
  make: Factory,
  method: string,
  route: string | undefined,
  status = 200,
): Promise<Exchange> {
  const recorded: RecordedAttributes[] = [];
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const { server, port } = await listen(
    (_req, res) => {
      if (route !== undefined) res.locals['route'] = route;
      // Registrado depois do `close` do middleware: quando dispara, o span já fechou.
      res.once('close', onClosed);
      res.status(status).end();
    },
    make,
    recordingTelemetry(recorded),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const outgoing = httpRequest(
        { host: '127.0.0.1', port, method, path: '/qualquer', agent: false },
        (incoming) => {
          incoming.resume();
          incoming.on('end', () => resolve());
        },
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
    await closed;
    return await exchangeOf(recorded);
  } finally {
    await closeServer(server);
  }
}

function expectNoResponseFields(exchange: Exchange): void {
  for (const keys of [
    Object.keys(exchange.span.attributes),
    Object.keys(exchange.metric),
  ]) {
    expect(keys).not.toContain(STATUS_ATTRIBUTE);
    expect(keys).not.toContain(ERROR_ATTRIBUTE);
  }
  // O resto do que a requisição já tinha segue no span e na métrica.
  for (const attributes of [exchange.span.attributes, exchange.metric]) {
    expect(attributes['http.request.method']).toBe('GET');
    expect(attributes['http.route']).toBe('/hang');
    expect(attributes['url.scheme']).toBe('http');
  }
  expect(exchange.span.attributes['url.path']).toBe('/hang');
  expect(exchange.span.name).toBe('GET /hang');
}

// Versão quebrada do middleware, escrita aqui: grava o 200 (o padrão do `res.statusCode` no Node) no span e na
// métrica mesmo sem resposta enviada.
function withDefaultStatus(target: Telemetry): Telemetry {
  const startSpan: Tracer['startSpan'] = (name, options, context) =>
    overriding(target.tracer.startSpan(name, options, context), {
      end: (real: Span) => (time?: Parameters<Span['end']>[0]) => {
        real.setAttribute(STATUS_ATTRIBUTE, 200);
        real.end(time);
      },
    });
  const tracer = overriding(target.tracer, { startSpan: () => startSpan });
  return {
    ...interceptingTelemetry(target, (attributes, forward) => {
      forward({ ...attributes, [STATUS_ATTRIBUTE]: 200 });
    }),
    tracer,
  };
}

const recordsDefaultStatus: Factory = (target, log) =>
  requestContext(withDefaultStatus(target), log);

describe('OBS-07 span HTTP: o status só entra quando uma resposta foi enviada', () => {
  it('OBS-07 a requisição que o cliente aborta antes da resposta não grava http.response.status_code nem error.type, no span nem na métrica', async () => {
    expectNoResponseFields(await abortedExchange(requestContext));
  });

  it('OBS-07 controle negativo: a mesma conferência reprova o middleware que grava o 200 padrão numa requisição abortada', async () => {
    const exchange = await abortedExchange(recordsDefaultStatus);
    expect(() => expectNoResponseFields(exchange)).toThrow(
      /http\.response\.status_code/,
    );
  });

  it('OBS-07 a requisição abortada depois de os cabeçalhos saírem mantém o status enviado, no span e na métrica', async () => {
    const exchange = await abortedExchange(requestContext, 202);
    expect(exchange.span.attributes[STATUS_ATTRIBUTE]).toBe(202);
    expect(exchange.metric[STATUS_ATTRIBUTE]).toBe(202);
  });

  it('OBS-07 a requisição respondida segue gravando o status enviado, no span e na métrica', async () => {
    const exchange = await answeredExchange(requestContext, 'GET', '/ok', 201);
    expect(exchange.span.attributes[STATUS_ATTRIBUTE]).toBe(201);
    expect(exchange.metric[STATUS_ATTRIBUTE]).toBe(201);
  });
});

describe('OBS-07 span HTTP: o nome do span com o método fora da lista', () => {
  it('OBS-07 método fora da lista com rota casada: o nome é "HTTP {rota}" e o método vira _OTHER com o original à parte', async () => {
    const exchange = await answeredExchange(
      requestContext,
      'PROPFIND',
      '/health',
      207,
    );
    expect(exchange.span.name).toBe('HTTP /health');
    expect(exchange.span.attributes['http.request.method']).toBe('_OTHER');
    expect(exchange.span.attributes['http.request.method_original']).toBe(
      'PROPFIND',
    );
    expect(exchange.span.attributes['http.route']).toBe('/health');
  });

  it('OBS-07 método fora da lista sem rota casada: o nome é só HTTP', async () => {
    const exchange = await answeredExchange(
      requestContext,
      'PROPFIND',
      undefined,
      404,
    );
    expect(exchange.span.name).toBe('HTTP');
    expect(Object.keys(exchange.span.attributes)).not.toContain('http.route');
  });

  it('OBS-07 método da lista com rota casada: o nome segue "{método} {rota}"', async () => {
    const exchange = await answeredExchange(
      requestContext,
      'POST',
      '/checkout',
    );
    expect(exchange.span.name).toBe('POST /checkout');
  });
});
