import { afterAll, describe, it } from 'vitest';
import {
  expectLogCompiles,
  expectLogTypeError,
  type SampleCase,
} from '../../test/helpers/event-logger-sample.ts';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import { repoRoot } from '../../test/helpers/repo-root.ts';

// OBS-07 (AD-029): o `eventLogger` sobre a declaração real da borda HTTP (`HTTP_LOG_EVENTS`). O fim da requisição
// sai em `info` e, na resposta 5xx, em `error`; o erro sem tratamento só em `error`. A prova é o tsc do projeto
// sobre uma amostra que importa a declaração real: um erro de tipo não se prova por execução.

afterAll(cleanupTempDirs);

function sample(calls: string): SampleCase {
  return {
    imports: `import { HTTP_LOG_EVENTS } from '${repoRoot}/src/http/telemetry.ts';`,
    specs: 'HTTP_LOG_EVENTS',
    calls,
  };
}

describe('OBS-07 eventLogger sobre os eventos da borda HTTP', () => {
  it('OBS-07 o casecellshop.http.request.completed compila em info e em error, com os campos que declara', () => {
    expectLogCompiles(
      sample(`log.info(
  'casecellshop.http.request.completed',
  { route: '/products', method: 'GET', status: 200, duration_ms: 12, orderId: 'o-1' },
  'requisição concluída',
);
log.error(
  'casecellshop.http.request.completed',
  { route: '/products', method: 'GET', status: 503, duration_ms: 12 },
  'requisição concluída',
);
log.info(
  'casecellshop.http.request.completed',
  { route: '/hang', method: 'GET', duration_ms: 3 },
  'requisição concluída',
);`),
    );
  }, 60_000);

  it('OBS-07 o casecellshop.http.request.completed aceita os campos de correlação que o log da requisição passa à mão', () => {
    expectLogCompiles(
      sample(`log.info(
  'casecellshop.http.request.completed',
  { correlationId: 'req-1', trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), route: '/x', method: 'GET' },
  'requisição concluída',
);`),
    );
  }, 60_000);

  it('OBS-07 o casecellshop.http.request.completed em warn reprova no tsc, porque só declara info e error', () => {
    expectLogTypeError(
      sample(
        "log.warn('casecellshop.http.request.completed', { status: 200 }, 'm');",
      ),
      { code: 'TS2345', text: 'casecellshop.http.request.completed' },
    );
  }, 60_000);

  it('OBS-07 o casecellshop.http.request.failed compila em error', () => {
    expectLogCompiles(
      sample(
        "log.error('casecellshop.http.request.failed', { err: new Error('x') }, 'm');",
      ),
    );
  }, 60_000);

  it('OBS-07 o casecellshop.http.request.failed em info reprova no tsc, porque só declara error', () => {
    expectLogTypeError(
      sample(
        "log.info('casecellshop.http.request.failed', { err: new Error('x') }, 'm');",
      ),
      { code: 'TS2345', text: 'casecellshop.http.request.failed' },
    );
  }, 60_000);

  it('OBS-07 o nome antigo http_request reprova no tsc', () => {
    expectLogTypeError(sample("log.info('http_request', {}, 'm');"), {
      code: 'TS2345',
      text: 'http_request',
    });
  }, 60_000);

  it('OBS-07 um campo que o casecellshop.http.request.completed não declara reprova no tsc', () => {
    expectLogTypeError(
      sample(
        "log.info('casecellshop.http.request.completed', { status: 200, url: '/x' }, 'm');",
      ),
      { code: 'TS2353', text: 'url' },
    );
  }, 60_000);
});
