import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventKeyLines } from '../helpers/event-key-scan.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// OBS-07 (AD-029): nenhum log de `src/` escreve o campo `event` por fora do logger tipado. Só o
// `src/shared/logging.ts`, que implementa o `eventLogger`, pode ter a chave `event` num objeto de log; as outras
// pastas escrevem os eventos pelo `eventLogger`, e o `tsc` confere o nome, o nível e os campos. A conferência é
// estrutural: procura a chave `event` num objeto (`event: ...`, `'event': ...`, `['event']: ...` e `{ event }`),
// depois de tirar os comentários e o conteúdo das cadeias, e não o texto `event` solto.

const SRC = join(repoRoot, 'src');
const LOGGER_FILE = 'src/shared/logging.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

// Os arquivos de `src/` (fora dos testes) que escrevem a chave `event`, com a linha, fora o do logger.
function writersOfEventKey(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([path]) => path !== LOGGER_FILE)
    .flatMap(([path, source]) =>
      eventKeyLines(source).map((line) => `${path}:${line}`),
    );
}

describe('OBS-07 controle negativo: o que a conferência acusa', () => {
  it.each([
    [
      'o objeto de log com event e outros campos',
      "logger.info({ event: 'x', orderId }, 'mensagem');",
    ],
    [
      'o objeto de log só com event',
      "logger.info({ event: 'x' }, 'mensagem');",
    ],
    [
      'o event numa linha própria, no meio de um objeto multilinha',
      "logger.warn(\n  {\n    orderId,\n    event: 'x',\n    reason,\n  },\n  'mensagem',\n);",
    ],
    ['a chave entre aspas simples', "logger.info({ 'event': 'x' }, 'm');"],
    ['a chave entre aspas duplas', 'logger.info({ "event": "x" }, "m");'],
    ['a chave computada', "logger.info({ ['event']: 'x' }, 'm');"],
    ['o atalho { event }', 'logger.info({ event }, "m");'],
    ['o atalho no meio de um objeto', "logger.info({ a, event, b }, 'm');"],
    ['o atalho no fim de um objeto', "logger.info({ a, event }, 'm');"],
    [
      'o event dentro de um spread de objeto',
      "const fields = { ...base, event: 'x' };",
    ],
    ['o event em um logger filho', "const log = logger.child({ event: 'x' });"],
    [
      'o event em um objeto montado fora da chamada',
      "const entry = { event: 'checkout.accepted', orderId };\nlogger.info(entry, 'm');",
    ],
  ])('OBS-07 controle negativo: %s é acusado', (_label, source) => {
    expect(writersOfEventKey({ 'src/amostra/amostra.ts': source })).not.toEqual(
      [],
    );
  });

  it('OBS-07 controle negativo: o achado cita o arquivo e a linha da chave', () => {
    const source = "const a = 1;\nlogger.info(\n  { event: 'x' },\n  'm',\n);";

    expect(writersOfEventKey({ 'src/amostra/amostra.ts': source })).toEqual([
      'src/amostra/amostra.ts:3',
    ]);
  });

  it('OBS-07 controle negativo: o arquivo do logger tipado é o único que pode ter a chave, e outro com o mesmo conteúdo é acusado', () => {
    const source = 'logger[level]({ event: name, ...fields }, message);';

    expect(writersOfEventKey({ [LOGGER_FILE]: source })).toEqual([]);
    expect(writersOfEventKey({ 'src/billing/outro.ts': source })).toEqual([
      'src/billing/outro.ts:1',
    ]);
  });
});

describe('OBS-07 controle positivo: o que a conferência aceita', () => {
  it.each([
    [
      'a chamada pelo eventLogger',
      "log.info('casecellshop.checkout.accepted', { orderId }, 'checkout aceito');",
    ],
    ['um log sem o campo event', "logger.info({ orderId }, 'mensagem');"],
    [
      'um comentário com event:',
      "// event: 'x' vira o nome do evento\nlogger.info({ orderId }, 'm');",
    ],
    [
      'um bloco de comentário com { event: x }',
      "/* antes: { event: 'x' } */\nlogger.info({ orderId }, 'm');",
    ],
    [
      'o texto event: dentro de uma mensagem',
      "logger.info({ orderId }, 'event: aceito');",
    ],
    [
      'o texto { event: x } dentro de um modelo de texto',
      'const texto = `{ event: ${nome} }`;',
    ],
    [
      'a lista de campos de um evento com o texto event',
      "const fields = ['orderId', 'event', 'reason'];",
    ],
    [
      'o event como valor de uma condicional',
      'const nome = ok ? event : outro;',
    ],
    [
      'o acesso github.event.pull_request',
      'const n = github.event.pull_request;',
    ],
    ['uma palavra que termina em event', 'const body = { prevent: 1 };'],
    [
      'o campo cujo nome começa por event',
      'const body = { eventCount: 1, events: [] };',
    ],
  ])('OBS-07 controle positivo: %s não é acusado', (_label, source) => {
    expect(writersOfEventKey({ 'src/amostra/amostra.ts': source })).toEqual([]);
  });
});

describe('OBS-07 nenhum log de src/ escreve o campo event por fora do logger tipado', () => {
  const files = Object.fromEntries(
    sourceFiles(SRC).map((path) => [
      relative(repoRoot, path),
      readFileSync(path, 'utf8'),
    ]),
  );

  it('OBS-07 a conferência lê os arquivos de src/ fora dos testes, entre eles o logger e os telemetry.ts', () => {
    const paths = Object.keys(files);
    expect(paths).toContain(LOGGER_FILE);
    expect(paths).toContain('src/http/telemetry.ts');
    expect(paths).toContain('src/billing/worker.ts');
    expect(paths.some((path) => path.endsWith('.test.ts'))).toBe(false);
  });

  it('OBS-07 só o src/shared/logging.ts tem a chave event num objeto de log', () => {
    expect(writersOfEventKey(files)).toEqual([]);
  });
});
