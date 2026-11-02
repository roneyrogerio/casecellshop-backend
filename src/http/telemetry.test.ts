import { afterAll, describe, it } from 'vitest';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import {
  expectCompiles,
  expectTypeError,
} from '../../test/helpers/metrics-sample.ts';

// OBS-07 (AD-029): a gravação da duração HTTP é tipada pela declaração. O atributo `required` é obrigatório, e o
// `conditionally_required` (o `error.type` só no 5xx; o `http.route` só se a requisição casou com uma rota; o
// `http.response.status_code` só se houve resposta, como na convenção) é opcional. A prova é o tsc do projeto sobre
// uma amostra que importa o acessor real (`httpMetrics(telemetry)`): um erro de tipo não se prova por execução.

afterAll(cleanupTempDirs);

const DURATION = 'http.server.request.duration';

const METHOD = "'http.request.method': 'GET'";
const ROUTE = "'http.route': '/products'";
const STATUS = "'http.response.status_code': 200";
const SCHEME = "'url.scheme': 'http'";
const ALL = [METHOD, ROUTE, STATUS, SCHEME];

function without(...removed: string[]): string[] {
  return ALL.filter((line) => !removed.includes(line));
}

function record(attributes: string[], name = DURATION): string {
  return `metrics.record('${name}', 0.01, { ${attributes.join(', ')} });`;
}

function expectHttpCompiles(attributes: string[]): void {
  expectCompiles('http', 'httpMetrics', record(attributes));
}

function expectHttpTypeError(
  attributes: string[],
  expected: { code: string; text: string },
  name = DURATION,
): void {
  expectTypeError('http', 'httpMetrics', record(attributes, name), expected);
}

describe('OBS-07 tipo da gravação da duração HTTP', () => {
  it('OBS-07 uma gravação sem http.request.method reprova no tsc, e o erro cita o atributo', () => {
    expectHttpTypeError(without(METHOD), {
      code: 'TS2345',
      text: 'http.request.method',
    });
  }, 60_000);

  it('OBS-07 uma gravação sem url.scheme reprova no tsc, porque ele é required', () => {
    expectHttpTypeError(without(SCHEME), {
      code: 'TS2345',
      text: 'url.scheme',
    });
  }, 60_000);

  it('OBS-07 uma gravação sem error.type compila, porque ele é conditionally_required', () => {
    expectHttpCompiles(ALL);
  }, 60_000);

  it('OBS-07 uma gravação com error.type compila também', () => {
    expectHttpCompiles([...ALL, "'error.type': '503'"]);
  }, 60_000);

  it('OBS-07 uma gravação sem http.route compila, porque ele é conditionally_required (só com rota casada)', () => {
    expectHttpCompiles(without(ROUTE));
  }, 60_000);

  it('OBS-07 uma gravação sem http.response.status_code compila, porque ele é conditionally_required (só com resposta)', () => {
    expectHttpCompiles(without(STATUS));
  }, 60_000);

  it('OBS-07 uma gravação só com o método e o esquema (sem rota e sem resposta) compila', () => {
    expectHttpCompiles([METHOD, SCHEME]);
  }, 60_000);

  it('OBS-07 uma gravação só com o esquema reprova no tsc, e o erro cita http.request.method', () => {
    expectHttpTypeError([SCHEME], {
      code: 'TS2345',
      text: 'http.request.method',
    });
  }, 60_000);

  it('OBS-07 um http.request.method fora do enum reprova no tsc, e o erro cita o valor', () => {
    expectHttpTypeError([...without(METHOD), "'http.request.method': 'FOO'"], {
      code: 'TS2322',
      text: 'FOO',
    });
  }, 60_000);

  it('OBS-07 um atributo não declarado na duração HTTP reprova no tsc, e o erro cita o atributo', () => {
    expectHttpTypeError([...ALL, "'casecellshop.nao.declarado': 'x'"], {
      code: 'TS2353',
      text: 'casecellshop.nao.declarado',
    });
  }, 60_000);

  it('OBS-07 um nome de métrica fora da declaração reprova no tsc, e o erro cita o nome', () => {
    expectHttpTypeError(
      ALL,
      { code: 'TS2345', text: 'casecellshop.nao.existe' },
      'casecellshop.nao.existe',
    );
  }, 60_000);
});
