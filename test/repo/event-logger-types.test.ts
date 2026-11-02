import { afterAll, describe, it } from 'vitest';
import {
  expectLogCompiles,
  expectLogTypeError,
  type SampleCase,
} from '../helpers/event-logger-sample.ts';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';

// OBS-07 (AD-029): o que o `tsc` aceita e recusa no `eventLogger` de src/shared/logging.ts: o evento fora da
// declaração, o evento num nível que ele não declara e o campo que o evento não declara reprovam. A prova é o tsc do
// projeto sobre uma amostra que importa o `eventLogger` real: um erro de tipo não se prova por execução. Fica em
// `test/repo/` porque um teste de `src/shared/` não importa os helpers de `test/` (AD-025). A linha que sai, em
// execução, está em src/shared/logging.test.ts; a declaração real da borda HTTP, em src/http/log-events.test.ts.

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
      { code: 'TS2353', text: 'hostname' },
    );
  }, 60_000);

  it('OBS-07 o campo de outro evento reprova no tsc, porque cada evento declara os seus', () => {
    expectLogTypeError(
      sample(
        "log.info('casecellshop.demo.started', { reason: 'cancelled' }, 'm');",
      ),
      { code: 'TS2353', text: 'reason' },
    );
  }, 60_000);

  it('OBS-07 o campo event dado à mão reprova no tsc: o nome do evento só entra pelo primeiro argumento', () => {
    expectLogTypeError(
      sample("log.info('casecellshop.demo.started', { event: 'outro' }, 'm');"),
      { code: 'TS2353', text: 'event' },
    );
  }, 60_000);
});
