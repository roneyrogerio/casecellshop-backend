import { SpanKind } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { pino, type DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { duplicateKeys } from '#test-helpers/duplicate-keys.ts';
import { memoryDestination } from '#test-helpers/logs.ts';
import { createLogger, eventLogger, fromPino, logContext } from './logging.ts';
import type { LogEventSpec } from './telemetry-catalog.ts';
import { createTelemetry } from './telemetry.ts';

// OBS-07 (AD-029): o logger tipado, em execução. `info`, `warn` e `error` escrevem uma linha no nível pedido, com o
// nome do evento no campo `event`, os campos dados e a mensagem. O que o `tsc` aceita e recusa (o evento, o nível e
// o campo fora da declaração) está em test/repo/event-logger-types.test.ts, que roda o tsc do projeto sobre uma
// amostra e não pertence a uma pasta de `src/`. Um teste de `shared/` importa os helpers de `test/helpers/`
// pelo atalho `#test-helpers/`; o lint barra qualquer `..` e barra invertida no import (AD-025).

type Line = Record<string, unknown>;

// Um logger do pino com o nível como texto, como o da aplicação, para o `fromPino` envolver.
function textLevelPino(level: string, destination: DestinationStream) {
  return pino(
    { level, formatters: { level: (label) => ({ level: label }) } },
    destination,
  );
}

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo `destination`.
function capture(level = 'info') {
  const { lines, raw, destination } = memoryDestination();
  const logger = createLogger({
    serviceName: 'casecellshop-worker',
    level,
    destination,
  });
  return { logger, lines, raw };
}

// A declaração de teste: um evento por nível e um que sai em dois (como o fim da requisição HTTP).
const EVENTS = {
  'casecellshop.demo.started': {
    levels: ['info'],
    description: 'A demonstração começou.',
    fields: ['port'],
  },
  'casecellshop.demo.degraded': {
    levels: ['warn'],
    description: 'A demonstração degradou.',
    fields: ['reason'],
  },
  'casecellshop.demo.failed': {
    levels: ['error'],
    description: 'A demonstração falhou.',
    fields: ['err'],
  },
  'casecellshop.demo.finished': {
    levels: ['info', 'error'],
    description: 'A demonstração terminou.',
    fields: ['status', 'route'],
  },
  'casecellshop.demo.stopped': {
    levels: ['info'],
    description: 'A demonstração parou, sem campos próprios.',
    fields: [],
  },
} as const satisfies Record<string, LogEventSpec>;

describe('OBS-07 eventLogger: a linha que sai', () => {
  it('OBS-07 o info escreve uma linha em info, com o nome no campo event, os campos dados e a mensagem', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.info('casecellshop.demo.started', { port: 3000 }, 'mensagem do evento');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'casecellshop.demo.started',
      port: 3000,
      msg: 'mensagem do evento',
    });
  });

  it('OBS-07 o warn escreve uma linha em warn, com o nome no campo event, os campos dados e a mensagem', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.warn(
      'casecellshop.demo.degraded',
      { reason: 'out_of_stock' },
      'mensagem do evento',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'casecellshop.demo.degraded',
      reason: 'out_of_stock',
      msg: 'mensagem do evento',
    });
  });

  it('OBS-07 o error escreve uma linha em error, com o nome no campo event, os campos dados e a mensagem', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.error('casecellshop.demo.failed', {}, 'mensagem do evento');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'error',
      event: 'casecellshop.demo.failed',
      msg: 'mensagem do evento',
    });
  });

  it('OBS-07 uma chamada escreve uma linha só, sem os campos de outro evento', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.info('casecellshop.demo.started', { port: 8080 }, 'iniciado');

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('reason');
  });

  it('OBS-07 os campos de um logger filho (orderId) seguem na linha do evento', () => {
    const { logger, lines } = capture();
    const log = eventLogger(
      logger.child({ orderId: 'pedido-1', attempt: 2 }),
      EVENTS,
    );

    log.warn(
      'casecellshop.demo.degraded',
      { reason: 'cancelled' },
      'degradado',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'casecellshop.demo.degraded',
      orderId: 'pedido-1',
      attempt: 2,
      reason: 'cancelled',
    });
  });

  it('OBS-07 os campos obrigatórios do logger (service, env, version, time, level, msg) continuam na linha do evento', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.info('casecellshop.demo.stopped', {}, 'parado');

    const line = lines[0] ?? {};
    for (const key of ['service', 'env', 'version', 'time', 'level', 'msg'])
      expect(line, key).toHaveProperty(key);
    expect(line['event']).toBe('casecellshop.demo.stopped');
  });

  it('OBS-07 os campos de correlação passados à mão (correlationId, trace_id, span_id) saem como vieram', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);

    log.info(
      'casecellshop.demo.finished',
      {
        status: 200,
        route: '/products',
        correlationId: 'req-manual',
        trace_id: traceId,
        span_id: spanId,
      },
      'fim',
    );

    expect(lines[0]).toMatchObject({
      correlationId: 'req-manual',
      trace_id: traceId,
      span_id: spanId,
      status: 200,
      route: '/products',
    });
  });

  it('OBS-07 o correlationId passado à mão vale mais que o do contexto assíncrono, porque o finish da requisição pode correr fora dele', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    logContext.run({ correlationId: 'req-contexto' }, () => {
      log.info(
        'casecellshop.demo.finished',
        { status: 200, correlationId: 'req-manual' },
        'fim',
      );
      log.info('casecellshop.demo.finished', { status: 200 }, 'fim');
    });

    expect(lines.map((line) => line['correlationId'])).toEqual([
      'req-manual',
      'req-contexto',
    ]);
  });

  it('OBS-07 o evento que declara dois níveis sai em cada um deles, com o nível pedido', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.info('casecellshop.demo.finished', { status: 200 }, 'ok');
    log.error('casecellshop.demo.finished', { status: 503 }, 'erro');

    expect(lines.map((line) => [line['level'], line['status']])).toEqual([
      ['info', 200],
      ['error', 503],
    ]);
    expect(
      lines.filter((line) => line['event'] === 'casecellshop.demo.finished'),
    ).toHaveLength(2);
  });

  it('OBS-07 o erro dado em err sai serializado pelo pino (err.message), e não como texto solto', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, EVENTS);

    log.error('casecellshop.demo.failed', { err: new Error('boom') }, 'falhou');

    expect(lines[0]).toMatchObject({
      level: 'error',
      event: 'casecellshop.demo.failed',
      err: { message: 'boom' },
    });
  });

  it('OBS-07 o logger configurado acima do nível do evento não escreve a linha', () => {
    const { logger, lines } = capture('error');
    const log = eventLogger(logger, EVENTS);

    log.info('casecellshop.demo.started', { port: 1 }, 'iniciado');
    log.error('casecellshop.demo.failed', {}, 'falhou');

    expect(lines.map((line) => line['event'])).toEqual([
      'casecellshop.demo.failed',
    ]);
  });

  // A18: o catálogo recusa `event` entre os campos, mas o logger não depende só disso. Esta declaração monta, de
  // propósito e fora das regras, um evento que lista `event` nos campos; o nome do evento escrito por último vence.
  it('OBS-07 um campo event que chega por fora do tipo não troca o nome do evento na linha', () => {
    const { logger, lines } = capture();
    const log = eventLogger(logger, {
      'casecellshop.demo.shadowed': {
        levels: ['info'],
        description: 'Declaração fora das regras, para a prova de execução.',
        fields: ['event', 'port'],
      },
    } as const satisfies Record<string, LogEventSpec>);

    log.info(
      'casecellshop.demo.shadowed',
      { event: 'casecellshop.demo.impostor', port: 3000 },
      'mensagem do evento',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'casecellshop.demo.shadowed',
      port: 3000,
      msg: 'mensagem do evento',
    });
  });
});

// A17: o `AppLogger` que o resto de `src/` recebe só cria filhos; a prova de tipo está em
// test/repo/event-logger-types.test.ts, e aqui o que acontece em execução.
describe('OBS-07 AppLogger: só cria filhos, e o eventLogger é o único que escreve', () => {
  it.each(['info', 'warn', 'error', 'fatal', 'debug', 'trace'])(
    'OBS-07 o AppLogger do createLogger, do fromPino e do child não expõe %s em execução',
    (method) => {
      const fromCreate = capture().logger;
      const fromPinoLogger = fromPino(pino({ level: 'silent' }));
      const loggers = [
        fromCreate,
        fromCreate.child({ orderId: 'pedido-1' }),
        fromPinoLogger,
        fromPinoLogger.child({ orderId: 'pedido-1' }),
      ];

      for (const logger of loggers)
        expect(
          (logger as unknown as Record<string, unknown>)[method],
        ).toBeUndefined();
    },
  );

  it('OBS-07 o filho de um filho (child.child) leva os campos dos dois à linha que o eventLogger escreve', () => {
    const { logger, lines } = capture();
    const grandchild = logger
      .child({ orderId: 'pedido-1' })
      .child({ attempt: 3 });

    eventLogger(grandchild, EVENTS).info(
      'casecellshop.demo.finished',
      { status: 202 },
      'fim',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'casecellshop.demo.finished',
      orderId: 'pedido-1',
      attempt: 3,
      status: 202,
    });
  });

  it('OBS-07 o fromPino escreve no destino do logger do pino que envolve, e o filho dele leva os campos', () => {
    const { lines, destination } = memoryDestination();
    const logger = fromPino(textLevelPino('info', destination));

    eventLogger(logger.child({ orderId: 'pedido-2' }), EVENTS).info(
      'casecellshop.demo.started',
      { port: 3000 },
      'iniciado',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'casecellshop.demo.started',
      orderId: 'pedido-2',
      port: 3000,
      msg: 'iniciado',
    });
  });

  it('OBS-07 o fromPino respeita o nível do logger do pino: o evento abaixo dele não escreve', () => {
    const { lines, destination } = memoryDestination();
    const log = eventLogger(
      fromPino(textLevelPino('warn', destination)),
      EVENTS,
    );

    log.info('casecellshop.demo.stopped', {}, 'parado');
    log.warn('casecellshop.demo.degraded', { reason: 'x' }, 'degradado');

    expect(lines.map((line) => line['level'])).toEqual(['warn']);
  });
});

// Abre um span ativo (como o withSpan da rodada da sincronização) e devolve os identificadores dele.
async function inSpan<T>(
  fn: (ids: { traceId: string; spanId: string }) => T,
): Promise<T> {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  try {
    return await telemetry.withSpan(
      'obs01.span',
      { kind: SpanKind.INTERNAL },
      (span) => {
        const { traceId, spanId } = span.spanContext();
        return Promise.resolve(fn({ traceId, spanId }));
      },
    );
  } finally {
    await telemetry.shutdown();
  }
}

// OBS-01 (decisão do mantenedor de 02/11/2026): o correlationId sai dentro de uma requisição ou de uma tentativa do
// worker (o contexto assíncrono `logContext`); o trace_id e o span_id, dentro de qualquer span, inclusive fora de
// requisição; um log do processo fora dos três contextos sai sem eles, mas com os campos de identificação.
// A rodada da sincronização, dentro do span `catalog.sync.round`, está em test/integration/observability/.
describe('OBS-01 campos de correlação por contexto', () => {
  const IDENTIFICATION = [
    'time',
    'level',
    'service',
    'env',
    'version',
    'msg',
    'event',
  ];
  const CORRELATION = ['correlationId', 'trace_id', 'span_id'];

  it('OBS-01 um log fora de requisição, de tentativa e de span sai sem correlationId, trace_id e span_id, e com os campos de identificação', () => {
    const { logger, lines } = capture();

    eventLogger(logger, EVENTS).info(
      'casecellshop.demo.stopped',
      {},
      'log do processo',
    );

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? {};
    for (const key of IDENTIFICATION) expect(line, key).toHaveProperty(key);
    for (const key of CORRELATION) expect(line, key).not.toHaveProperty(key);
  });

  it('OBS-01 controle: o mesmo log dentro de uma requisição leva o correlationId, e sem span não leva trace_id nem span_id', () => {
    const { logger, lines } = capture();

    logContext.run({ correlationId: 'req-1' }, () => {
      eventLogger(logger, EVENTS).info(
        'casecellshop.demo.stopped',
        {},
        'log da requisição',
      );
    });

    expect(lines[0]).toMatchObject({ correlationId: 'req-1' });
    expect(lines[0]).not.toHaveProperty('trace_id');
    expect(lines[0]).not.toHaveProperty('span_id');
  });

  it('OBS-01 um log dentro de um span, fora de requisição, leva o trace_id e o span_id do span e não leva correlationId', async () => {
    const { logger, lines } = capture();

    const ids = await inSpan((spanIds) => {
      eventLogger(logger, EVENTS).info(
        'casecellshop.demo.stopped',
        {},
        'log do span',
      );
      return spanIds;
    });

    expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      trace_id: ids.traceId,
      span_id: ids.spanId,
    });
    expect(lines[0]).not.toHaveProperty('correlationId');
    for (const key of IDENTIFICATION) expect(lines[0], key).toHaveProperty(key);
  });

  it('OBS-01 um log dentro de uma requisição e de um span leva os três campos', async () => {
    const { logger, lines } = capture();

    const ids = await inSpan((spanIds) =>
      logContext.run({ correlationId: 'req-2' }, () => {
        eventLogger(logger, EVENTS).info(
          'casecellshop.demo.stopped',
          {},
          'log da requisição no span',
        );
        return spanIds;
      }),
    );

    expect(lines[0]).toMatchObject({
      correlationId: 'req-2',
      trace_id: ids.traceId,
      span_id: ids.spanId,
    });
  });

  it('OBS-01 depois de o span terminar, o log do processo volta a sair sem trace_id e span_id', async () => {
    const { logger, lines } = capture();
    await inSpan(() => undefined);

    eventLogger(logger, EVENTS).info(
      'casecellshop.demo.stopped',
      {},
      'depois do span',
    );

    expect(lines).toHaveLength(1);
    for (const key of CORRELATION)
      expect(lines[0], key).not.toHaveProperty(key);
  });
});

// As linhas cruas que escrevem alguma chave duas vezes no primeiro nível, com as chaves repetidas.
function repeatedIn(raw: string[]): { line: string; keys: string[] }[] {
  return raw
    .map((line) => ({ line, keys: duplicateKeys(line) }))
    .filter((found) => found.keys.length > 0);
}

describe('OBS-01 o detector de chave repetida lê o texto cru da linha', () => {
  it('OBS-01 controle: a linha com a mesma chave duas vezes no primeiro nível é acusada, e o JSON.parse não mostra a repetição', () => {
    const line =
      '{"level":"info","correlationId":"c","a":1,"correlationId":"m","a":2,"msg":"x"}';

    expect(duplicateKeys(line)).toEqual(['correlationId', 'a']);
    expect(Object.keys(JSON.parse(line) as Line)).toHaveLength(4);
  });

  it('OBS-01 controle: a mesma chave em objeto aninhado, em lista ou dentro do texto de um valor não é repetição da linha', () => {
    const line =
      '{"a":1,"err":{"a":2,"a\\"b":3},"list":[{"a":1},{"a":2}],"msg":"x,\\"a\\":9","b":{"a":1}}';

    expect(duplicateKeys(line)).toEqual([]);
  });

  it('OBS-01 controle: a chave com aspa escapada repetida é acusada pelo nome já decodificado', () => {
    expect(duplicateKeys('{"a\\"b":1,"c":2,"a\\"b":3}')).toEqual(['a"b']);
  });

  it('OBS-01 controle: o pino puro, com mixin e um filho de mesma chave, escreve a repetição que o detector acusa', () => {
    const { raw, destination } = memoryDestination();
    const plain = pino({ mixin: () => ({ correlationId: 'm' }) }, destination);

    plain.child({ correlationId: 'c', a: 1 }).info({ a: 2 }, 'x');

    expect(raw).toHaveLength(1);
    expect(duplicateKeys(raw[0] ?? '').sort()).toEqual(['a', 'correlationId']);
  });
});

// Precedência do design: numa chave repetida vale o evento, depois o filho, depois o contexto (requisição e span).
describe('OBS-01 cada chave sai uma vez só na linha, também com logger filho', () => {
  it('OBS-01 o filho com o correlationId do contexto da requisição escreve a chave uma vez, com o valor do filho', () => {
    const { logger, lines, raw } = capture();
    const child = logger.child({
      orderId: 'pedido-1',
      correlationId: 'corr-filho',
    });

    logContext.run({ correlationId: 'corr-contexto' }, () => {
      eventLogger(child, EVENTS).info('casecellshop.demo.stopped', {}, 'fim');
    });

    expect(repeatedIn(raw)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      orderId: 'pedido-1',
      correlationId: 'corr-filho',
    });
  });

  it('OBS-01 o filho com o mesmo correlationId do contexto escreve a chave uma vez, com o valor que os dois levam', () => {
    const { logger, lines, raw } = capture();
    const child = logger.child({ orderId: 'pedido-1', correlationId: 'mesmo' });

    logContext.run({ correlationId: 'mesmo' }, () => {
      eventLogger(child, EVENTS).info('casecellshop.demo.stopped', {}, 'fim');
    });

    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({ correlationId: 'mesmo' });
  });

  it('OBS-01 o filho com trace_id e span_id do span escreve cada chave uma vez, com o valor do filho', async () => {
    const { logger, lines, raw } = capture();
    const traceId = 'c'.repeat(32);
    const spanId = 'd'.repeat(16);
    const child = logger.child({ trace_id: traceId, span_id: spanId });

    const ids = await inSpan((spanIds) => {
      eventLogger(child, EVENTS).info('casecellshop.demo.stopped', {}, 'fim');
      return spanIds;
    });

    expect(ids.traceId).not.toBe(traceId);
    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({ trace_id: traceId, span_id: spanId });
  });

  it('OBS-01 o evento com correlationId, trace_id e span_id próprios, dentro de requisição e de span, escreve cada chave uma vez, com o valor do evento', async () => {
    const { logger, lines, raw } = capture();
    const traceId = 'e'.repeat(32);
    const spanId = 'f'.repeat(16);

    await inSpan(() =>
      logContext.run({ correlationId: 'corr-contexto' }, () => {
        eventLogger(logger, EVENTS).info(
          'casecellshop.demo.finished',
          {
            status: 200,
            correlationId: 'corr-evento',
            trace_id: traceId,
            span_id: spanId,
          },
          'fim',
        );
      }),
    );

    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({
      correlationId: 'corr-evento',
      trace_id: traceId,
      span_id: spanId,
      status: 200,
    });
  });

  it('OBS-01 o filho com um campo que o evento também escreve sai com a chave uma vez, e vale o valor do evento', () => {
    const { logger, lines, raw } = capture();
    const child = logger.child({ orderId: 'pedido-1', status: 1, route: '/a' });

    eventLogger(child, EVENTS).info(
      'casecellshop.demo.finished',
      { status: 2 },
      'fim',
    );

    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({
      orderId: 'pedido-1',
      status: 2,
      route: '/a',
    });
  });

  it('OBS-01 o filho de um filho com a mesma chave sai com ela uma vez, e vale o valor do filho mais novo', () => {
    const { logger, lines, raw } = capture();
    const grandchild = logger
      .child({ orderId: 'pedido-1', attempt: 1 })
      .child({ attempt: 2, route: '/b' });

    eventLogger(grandchild, EVENTS).info(
      'casecellshop.demo.finished',
      { status: 202 },
      'fim',
    );

    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({
      orderId: 'pedido-1',
      attempt: 2,
      route: '/b',
      status: 202,
    });
  });

  it('OBS-01 todas as coincidências juntas (evento, filho, filho do filho, requisição e span) saem com cada chave uma vez e a precedência evento, filho, contexto', async () => {
    const { logger, lines, raw } = capture();
    const traceId = 'a'.repeat(32);
    const grandchild = logger
      .child({ orderId: 'pedido-1', correlationId: 'corr-filho', status: 1 })
      .child({
        correlationId: 'corr-neto',
        trace_id: traceId,
        route: '/neto',
      });

    await inSpan(() =>
      logContext.run({ correlationId: 'corr-contexto' }, () => {
        const log = eventLogger(grandchild, EVENTS);
        log.info('casecellshop.demo.finished', { status: 2 }, 'primeira');
        log.info(
          'casecellshop.demo.finished',
          { status: 3, correlationId: 'corr-evento' },
          'segunda',
        );
      }),
    );

    expect(lines).toHaveLength(2);
    expect(repeatedIn(raw)).toEqual([]);
    expect(lines[0]).toMatchObject({
      orderId: 'pedido-1',
      correlationId: 'corr-neto',
      trace_id: traceId,
      route: '/neto',
      status: 2,
    });
    expect(lines[1]).toMatchObject({
      correlationId: 'corr-evento',
      status: 3,
    });
    for (const line of lines)
      expect(line['span_id'], 'o span_id do contexto fica').toMatch(
        /^[0-9a-f]{16}$/,
      );
  });
});
