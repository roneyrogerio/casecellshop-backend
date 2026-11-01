import { describe, expect, it } from 'vitest';
import { createLogger, eventLogger, logContext } from './logging.ts';
import type { LogEventSpec } from './telemetry-catalog.ts';

// OBS-07 (AD-029): o logger tipado, em execução. `info`, `warn` e `error` escrevem uma linha no nível pedido, com o
// nome do evento no campo `event`, os campos dados e a mensagem. O que o `tsc` aceita e recusa (o evento, o nível e
// o campo fora da declaração) está em test/repo/event-logger-types.test.ts: um teste de `shared/` não importa os
// helpers de `test/` (AD-025), e a prova de tipo precisa deles.

type Line = Record<string, unknown>;

// O logger de produção (createLogger) escrevendo as linhas JSON em memória, pelo `destination`.
function capture(level = 'info') {
  const lines: Line[] = [];
  const destination = {
    write(chunk: string): void {
      for (const text of chunk.split('\n'))
        if (text.trim() !== '') lines.push(JSON.parse(text) as Line);
    },
  };
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
