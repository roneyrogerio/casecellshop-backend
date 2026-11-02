import { pino, type DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, eventLogger, fromPino, logContext } from './logging.ts';
import type { LogEventSpec } from './telemetry-catalog.ts';

// OBS-07 (AD-029): o logger tipado, em execução. `info`, `warn` e `error` escrevem uma linha no nível pedido, com o
// nome do evento no campo `event`, os campos dados e a mensagem. O que o `tsc` aceita e recusa (o evento, o nível e
// o campo fora da declaração) está em test/repo/event-logger-types.test.ts: um teste de `shared/` não importa os
// helpers de `test/` (AD-025), e a prova de tipo precisa deles.

type Line = Record<string, unknown>;

// O destino em memória: guarda cada linha JSON que o logger escreve.
function memoryDestination() {
  const lines: Line[] = [];
  const destination = {
    write(chunk: string): void {
      for (const text of chunk.split('\n'))
        if (text.trim() !== '') lines.push(JSON.parse(text) as Line);
    },
  };
  return { lines, destination };
}

// Um logger do pino com o nível como texto, como o da aplicação, para o `fromPino` envolver.
function textLevelPino(level: string, destination: DestinationStream) {
  return pino(
    { level, formatters: { level: (label) => ({ level: label }) } },
    destination,
  );
}

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo `destination`.
function capture(level = 'info') {
  const { lines, destination } = memoryDestination();
  const logger = createLogger({
    serviceName: 'casecellshop-worker',
    level,
    destination,
  });
  return { logger, lines };
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
