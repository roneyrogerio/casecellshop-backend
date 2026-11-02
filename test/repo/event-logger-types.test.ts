import { afterAll, describe, it } from 'vitest';
import {
  FIELD_ERROR_CODES,
  expectLogCompiles,
  expectLogTypeError,
  type SampleCase,
} from '../helpers/event-logger-sample.ts';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';

// OBS-07 (AD-029): o que o `tsc` aceita e recusa no `eventLogger` de src/shared/logging.ts: o evento fora da
// declaração, o evento num nível que ele não declara e o campo que o evento não declara reprovam. A prova é o tsc do
// projeto sobre uma amostra que importa o `eventLogger` real: um erro de tipo não se prova por execução. Fica em
// `test/repo/` porque roda o tsc do projeto sobre uma amostra e não pertence a uma pasta de `src/`; um teste de
// `src/shared/` pode importar os helpers de `test/helpers/`, e só as outras pastas de `src/` seguem barradas
// (AD-025). A linha que sai, em execução, está em src/shared/logging.test.ts; a declaração real da borda HTTP, em
// src/http/log-events.test.ts.

afterAll(cleanupTempDirs);

// A declaração de teste, escrita na amostra: um evento por nível e um que sai em dois.
const DECLARATION = `const EVENTS = {
  'casecellshop.demo.started': { levels: ['info'], description: 'a', fields: ['port'] },
  'casecellshop.demo.degraded': { levels: ['warn'], description: 'b', fields: ['reason'] },
  'casecellshop.demo.failed': { levels: ['error'], description: 'c', fields: ['err'] },
  'casecellshop.demo.finished': { levels: ['info', 'error'], description: 'd', fields: ['status', 'route'] },
  'casecellshop.demo.stopped': { levels: ['info'], description: 'e', fields: [] },
} as const satisfies Record<string, LogEventSpec>;`;

function sample(calls: string): SampleCase {
  return { imports: DECLARATION, specs: 'EVENTS', calls };
}

describe('OBS-07 eventLogger: o que o tsc aceita', () => {
  it('OBS-07 controle: um evento no nível que declara, com os campos que declara e os de correlação, compila', () => {
    expectLogCompiles(
      sample(`log.info('casecellshop.demo.started', { port: 1 }, 'm');
log.warn('casecellshop.demo.degraded', { reason: 'cancelled' }, 'm');
log.error('casecellshop.demo.failed', { err: new Error('x') }, 'm');
log.info('casecellshop.demo.finished', { status: 200, route: '/x' }, 'm');
log.error('casecellshop.demo.finished', { status: 503 }, 'm');
log.info('casecellshop.demo.stopped', {}, 'm');
log.info(
  'casecellshop.demo.started',
  { correlationId: 'r', trace_id: 't', span_id: 's' },
  'm',
);`),
    );
  }, 60_000);
});

describe('OBS-07 eventLogger: o evento fora da declaração', () => {
  it('OBS-07 um evento fora da declaração reprova no tsc, e o erro cita o nome', () => {
    expectLogTypeError(
      sample("log.info('casecellshop.demo.unknown', {}, 'm');"),
      { code: 'TS2345', text: 'casecellshop.demo.unknown' },
    );
  }, 60_000);

  it('OBS-07 um evento escrito no estilo antigo (sem o prefixo) reprova no tsc', () => {
    expectLogTypeError(sample("log.info('checkout.accepted', {}, 'm');"), {
      code: 'TS2345',
      text: 'checkout.accepted',
    });
  }, 60_000);
});

describe('OBS-07 eventLogger: o evento num nível que ele não declara', () => {
  it('OBS-07 info num evento que só declara error reprova no tsc, e o erro cita o evento', () => {
    expectLogTypeError(
      sample("log.info('casecellshop.demo.failed', {}, 'm');"),
      { code: 'TS2345', text: 'casecellshop.demo.failed' },
    );
  }, 60_000);

  it('OBS-07 error num evento que só declara info reprova no tsc, e o erro cita o evento', () => {
    expectLogTypeError(
      sample("log.error('casecellshop.demo.started', { port: 1 }, 'm');"),
      { code: 'TS2345', text: 'casecellshop.demo.started' },
    );
  }, 60_000);

  it('OBS-07 warn num evento que não declara warn reprova no tsc, ainda que declare info e error', () => {
    expectLogTypeError(
      sample("log.warn('casecellshop.demo.finished', { status: 200 }, 'm');"),
      { code: 'TS2345', text: 'casecellshop.demo.finished' },
    );
  }, 60_000);
});

describe('OBS-07 eventLogger: o campo que o evento não declara', () => {
  it('OBS-07 um campo que o evento não declara reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(
        "log.info('casecellshop.demo.started', { port: 1, hostname: 'x' }, 'm');",
      ),
      { code: FIELD_ERROR_CODES, text: 'hostname' },
    );
  }, 60_000);

  it('OBS-07 o campo de outro evento reprova no tsc, porque cada evento declara os seus', () => {
    expectLogTypeError(
      sample(
        "log.info('casecellshop.demo.started', { reason: 'cancelled' }, 'm');",
      ),
      { code: FIELD_ERROR_CODES, text: 'reason' },
    );
  }, 60_000);

  it('OBS-07 o campo event dado à mão reprova no tsc: o nome do evento só entra pelo primeiro argumento', () => {
    expectLogTypeError(
      sample("log.info('casecellshop.demo.started', { event: 'outro' }, 'm');"),
      { code: FIELD_ERROR_CODES, text: 'event' },
    );
  }, 60_000);
});

// A16: o `tsc` só conferia campo a mais num objeto literal escrito na própria chamada. O tipo exato recusa também o
// objeto montado antes dela, como o `fields` do log da requisição.
describe('OBS-07 eventLogger: o campo a mais num objeto montado antes da chamada (A16)', () => {
  it('OBS-07 controle: um objeto montado antes, só com campos declarados e de correlação, compila', () => {
    expectLogCompiles(
      sample(`const finished = { status: 200, route: '/x' };
log.info('casecellshop.demo.finished', finished, 'm');
const started = { port: 1, correlationId: 'r', trace_id: 't', span_id: 's' };
log.info('casecellshop.demo.started', started, 'm');
const empty = {};
log.info('casecellshop.demo.stopped', empty, 'm');
const base = { status: 503 };
const spread = { ...base, route: '/y' };
log.error('casecellshop.demo.finished', spread, 'm');`),
    );
  }, 60_000);

  it('OBS-07 um objeto montado antes com um campo que o evento não declara reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(`const fields = { status: 200, url: '/x' };
log.info('casecellshop.demo.finished', fields, 'm');`),
      { code: 'TS2345', text: 'url' },
    );
  }, 60_000);

  it('OBS-07 um objeto montado antes com o campo de outro evento reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(`const fields = { port: 1, reason: 'cancelled' };
log.info('casecellshop.demo.started', fields, 'm');`),
      { code: 'TS2345', text: 'reason' },
    );
  }, 60_000);

  it('OBS-07 um objeto montado antes com o campo event reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(`const fields = { port: 1, event: 'outro' };
log.info('casecellshop.demo.started', fields, 'm');`),
      { code: 'TS2345', text: 'event' },
    );
  }, 60_000);

  it('OBS-07 um objeto montado antes por espalhamento (spread) com um campo a mais reprova no tsc', () => {
    expectLogTypeError(
      sample(`const base = { status: 200 };
const fields = { ...base, sku: 'ABC' };
log.error('casecellshop.demo.finished', fields, 'm');`),
      { code: 'TS2345', text: 'sku' },
    );
  }, 60_000);
});

// O código do erro de atribuição depende de quantas propriedades faltam: TS2322 (tipo incompatível), TS2741 (falta o
// marcador) e TS2739/TS2740 (faltam várias).
const NOT_ASSIGNABLE_CODES = ['TS2322', 'TS2739', 'TS2740', 'TS2741'] as const;

// A17: fora de `src/shared/logging.ts`, o código recebe um `AppLogger` que só cria filhos. Escrever um log passa
// pelo `eventLogger`, que é o único a escrever; o marcador do tipo é um `unique symbol` que só o módulo conhece.
describe('OBS-07 AppLogger opaco: só cria filhos e só escreve pelo eventLogger (A17)', () => {
  it('OBS-07 controle: child devolve um AppLogger, que o eventLogger escreve; createLogger e fromPino também devolvem um', () => {
    expectLogCompiles(
      sample(`const child: AppLogger = appLogger.child({ orderId: 'pedido-1' });
const grandchild: AppLogger = child.child({ attempt: 2 });
const created: AppLogger = createLogger({ serviceName: 'casecellshop-worker' });
const wrapped: AppLogger = fromPino(pino());
eventLogger(grandchild, EVENTS).info('casecellshop.demo.started', { port: 1 }, 'm');
eventLogger(created, EVENTS).warn('casecellshop.demo.degraded', { reason: 'x' }, 'm');
eventLogger(wrapped.child({ orderId: 'p' }), EVENTS).error('casecellshop.demo.failed', {}, 'm');`),
    );
  }, 60_000);

  it('OBS-07 info, warn, error, fatal, debug e trace num AppLogger reprovam no tsc: o tipo não os tem', () => {
    expectLogTypeError(
      sample(`appLogger.info({}, 'm');
appLogger.warn({}, 'm');
appLogger.error({}, 'm');
appLogger.fatal({}, 'm');
appLogger.debug({}, 'm');
appLogger.trace({}, 'm');`),
      {
        code: 'TS2339',
        text: ['info', 'warn', 'error', 'fatal', 'debug', 'trace'].map(
          (name) => `Property '${name}' does not exist`,
        ),
      },
    );
  }, 60_000);

  it('OBS-07 o que o createLogger e o fromPino devolvem também não escreve: info e warn reprovam no tsc', () => {
    expectLogTypeError(
      sample(`createLogger({ serviceName: 'casecellshop-worker' }).info({}, 'm');
fromPino(pino()).warn({}, 'm');
appLogger.child({ orderId: 'p' }).error({}, 'm');`),
      {
        code: 'TS2339',
        text: ['info', 'warn', 'error'].map(
          (name) => `Property '${name}' does not exist`,
        ),
      },
    );
  }, 60_000);

  it('OBS-07 um logger do pino passado como AppLogger reprova no tsc: só o fromPino o envolve', () => {
    expectLogTypeError(sample('const raw: AppLogger = pino();'), {
      code: NOT_ASSIGNABLE_CODES,
      text: 'AppLogger',
    });
  }, 60_000);

  it('OBS-07 o eventLogger recusa o logger do pino cru no tsc', () => {
    expectLogTypeError(
      sample(
        "eventLogger(pino(), EVENTS).info('casecellshop.demo.stopped', {}, 'm');",
      ),
      { code: 'TS2345', text: 'AppLogger' },
    );
  }, 60_000);

  it('OBS-07 um objeto montado fora, só com child, não serve como AppLogger no tsc: o marcador é do módulo', () => {
    expectLogTypeError(
      sample('const forged: AppLogger = { child: () => appLogger };'),
      { code: NOT_ASSIGNABLE_CODES, text: 'AppLogger' },
    );
  }, 60_000);
});

// O nome do evento só entra pelo `eventLogger`: um filho com `event` fixo nos campos duplicaria a chave na linha.
describe('OBS-07 AppLogger: o child não aceita o campo event (A17)', () => {
  it('OBS-07 controle: child com orderId e attempt, escrito na chamada ou montado antes, compila e devolve um AppLogger', () => {
    expectLogCompiles(
      sample(`const direct: AppLogger = appLogger.child({ orderId: 'pedido-1', attempt: 2 });
const bindings = { orderId: 'pedido-1', attempt: 2 };
const prebuilt: AppLogger = appLogger.child(bindings);
const empty: AppLogger = appLogger.child({});
eventLogger(direct, EVENTS).info('casecellshop.demo.started', { port: 1 }, 'm');
eventLogger(prebuilt.child(bindings), EVENTS).info('casecellshop.demo.stopped', {}, 'm');
eventLogger(empty, EVENTS).info('casecellshop.demo.stopped', {}, 'm');`),
    );
  }, 60_000);

  it('OBS-07 appLogger.child({ event }) reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(sample("appLogger.child({ event: 'x' });"), {
      code: FIELD_ERROR_CODES,
      text: 'event',
    });
  }, 60_000);

  it('OBS-07 child com event e outros campos reprova no tsc', () => {
    expectLogTypeError(
      sample("appLogger.child({ orderId: 'pedido-1', event: 'x' });"),
      { code: FIELD_ERROR_CODES, text: 'event' },
    );
  }, 60_000);

  it('OBS-07 child com um objeto montado antes que tem event reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(`const bindings = { orderId: 'pedido-1', event: 'x' };
appLogger.child(bindings);`),
      { code: 'TS2345', text: 'event' },
    );
  }, 60_000);

  it('OBS-07 o child do filho (appLogger.child({ orderId }).child({ event })) também reprova no tsc', () => {
    expectLogTypeError(
      sample("appLogger.child({ orderId: 'p' }).child({ event: 'x' });"),
      { code: FIELD_ERROR_CODES, text: 'event' },
    );
  }, 60_000);
});

// A3: os campos que a linha já escreve (o pino e o logger) repetiriam a chave se um filho os fixasse.
const RESERVED_LINE_FIELDS = [
  'event',
  'level',
  'msg',
  'time',
  'service',
  'env',
  'version',
] as const;

describe('OBS-01 AppLogger: o child não aceita os nomes reservados da linha (A3)', () => {
  it('OBS-01 controle: child com orderId, attempt e correlationId compila, também montado antes e no filho do filho', () => {
    expectLogCompiles(
      sample(`const direct: AppLogger = appLogger.child({ orderId: 'p', attempt: 1, correlationId: 'c' });
const bindings = { orderId: 'p', attempt: 2 };
const prebuilt: AppLogger = appLogger.child(bindings).child({ attempt: 3 });
eventLogger(direct, EVENTS).info('casecellshop.demo.stopped', {}, 'm');
eventLogger(prebuilt, EVENTS).info('casecellshop.demo.stopped', {}, 'm');`),
    );
  }, 60_000);

  for (const name of RESERVED_LINE_FIELDS) {
    it(`OBS-01 appLogger.child({ ${name} }) reprova no tsc, e o erro cita o campo`, () => {
      expectLogTypeError(sample(`appLogger.child({ ${name}: 'x' });`), {
        code: FIELD_ERROR_CODES,
        text: name,
      });
    }, 60_000);
  }

  it('OBS-01 child com um nome reservado e outros campos reprova no tsc', () => {
    expectLogTypeError(
      sample("appLogger.child({ orderId: 'p', service: 'filho' });"),
      { code: FIELD_ERROR_CODES, text: 'service' },
    );
  }, 60_000);

  it('OBS-01 child com um objeto montado antes que tem um nome reservado reprova no tsc, e o erro cita o campo', () => {
    expectLogTypeError(
      sample(`const bindings = { orderId: 'p', version: '9' };
appLogger.child(bindings);`),
      { code: 'TS2345', text: 'version' },
    );
  }, 60_000);

  it('OBS-01 o child do filho com um nome reservado também reprova no tsc', () => {
    expectLogTypeError(
      sample("appLogger.child({ orderId: 'p' }).child({ env: 'x' });"),
      { code: FIELD_ERROR_CODES, text: 'env' },
    );
  }, 60_000);
});
