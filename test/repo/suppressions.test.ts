import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { lintSampleFile } from '../helpers/lint-tree.ts';
import { repoRoot } from '../helpers/repo-root.ts';

afterAll(cleanupTempDirs);

// AI-47: nenhum comentário de supressão fica em src/, migrations/, scripts/ e .claude/hooks/, fora dos testes, em
// nenhuma extensão que o oxlint confere. Cada um cala uma checagem que o agente não pode afrouxar pela configuração
// (AI-04), e o comentário fica num arquivo que ele edita.
//
// Decisões sobre o que conta:
// - `eslint-disable` e `oxlint-disable` casam como texto, então valem as formas `-next-line`, `-line` e o bloco
//   `/* eslint-disable */`; as marcas `@public`, `@beta` e `@alias` do knip casam como palavra (`@publicFoo` não conta).
// - As marcas da cobertura seguem o padrão do ast-v8-to-istanbul, que a cobertura usa: `istanbul`, `v8`, `c8` ou
//   `node:coverage`, `ignore` depois, com qualquer espaço entre os dois (dois espaços e tab inclusive).
// - `// @ts-expect-error`, `// @ts-ignore` e `// @ts-nocheck` NÃO estão na lista: ficam com o
//   `typescript/ban-ts-comment` do .oxlintrc.json, configurado para reprovar todas, com ou sem descrição (os testes
//   de lint no fim deste arquivo provam isso).
// - A conferência é por texto, sem separar comentário de código: uma string com a diretiva também reprova, o que é
//   o lado seguro (o agente não esconde a supressão numa forma que o teste não leia).
const SUPPRESSION_PATTERN = new RegExp(
  [
    'oxlint-disable',
    'eslint-disable',
    '@(?:public|beta|alias)\\b',
    'jscpd:ignore',
    '(?:istanbul|[cv]8|node:coverage)\\s+ignore',
  ].join('|'),
);

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function findSuppressions(file: string, content: string): Occurrence[] {
  return content
    .split('\n')
    .flatMap((text, index) =>
      SUPPRESSION_PATTERN.test(text)
        ? [{ file, line: index + 1, text: text.trim() }]
        : [],
    );
}

function describeOccurrences(found: Occurrence[]): string[] {
  return found.map(({ file, line, text }) => `${file}:${line}  ${text}`);
}

const SCANNED_DIRS = ['src', 'migrations', 'scripts', '.claude/hooks'];

// As extensões que o oxlint confere; os testes (`*.test.<ext>`) ficam de fora, porque são eles que citam as marcas.
function isScannedSource(file: string): boolean {
  return (
    /\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/.test(file) &&
    !/\.test\.(?:ts|mts|cts|tsx|js|mjs|cjs)$/.test(file)
  );
}

function trackedSources(): string[] {
  const result = spawnSync('git', ['ls-files', '--', ...SCANNED_DIRS], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ls-files falhou: ${result.stderr}`);
  return result.stdout.split('\n').filter(isScannedSource);
}

describe('AI-47 nenhum comentário de supressão fora dos testes', () => {
  it('AI-47 src/, migrations/, scripts/ e .claude/hooks/ não têm comentário de supressão', () => {
    const files = trackedSources();
    // Controle: a varredura só vale se leu arquivos das quatro pastas.
    for (const dir of ['src/', 'migrations/', 'scripts/', '.claude/hooks/'])
      expect(
        files.some((file) => file.startsWith(dir)),
        `a varredura leu arquivos de ${dir}`,
      ).toBe(true);
    expect(files.some((file) => /\.test\.[cm]?[jt]sx?$/.test(file))).toBe(
      false,
    );

    const found = files.flatMap((file) =>
      findSuppressions(file, readFileSync(join(repoRoot, file), 'utf8')),
    );
    expect(describeOccurrences(found)).toEqual([]);
  });

  // Controle negativo do critério: um sql.raw com a diretiva acima reprova; o mesmo texto sem ela passa.
  const SQL_RAW = "export const q = sql.raw('on_hand');\n";

  it('AI-47 um sql.raw com // oxlint-disable-next-line acima reprova', () => {
    const content = `// oxlint-disable-next-line no-restricted-properties\n${SQL_RAW}`;
    const found = findSuppressions('src/x.ts', content);
    expect(describeOccurrences(found)).toEqual([
      'src/x.ts:1  // oxlint-disable-next-line no-restricted-properties',
    ]);
  });

  it('AI-47 o mesmo sql.raw sem a diretiva passa', () => {
    expect(findSuppressions('src/x.ts', SQL_RAW)).toEqual([]);
  });

  it.each([
    '// oxlint-disable-next-line no-restricted-properties',
    '// oxlint-disable-line',
    '/* oxlint-disable */',
    '// eslint-disable-next-line @typescript-eslint/no-unused-vars',
    '// eslint-disable-line no-console',
    '/* eslint-disable */',
    '/* eslint-disable no-console */',
    '/** @public */',
    '  * @public',
    '// jscpd:ignore-start',
    '// jscpd:ignore-end',
    '/* v8 ignore next */',
    '/* v8 ignore start */',
    '/* c8 ignore next 3 */',
    '/* istanbul ignore next */',
    '/** @beta */',
    '/** @alias */',
    '/* v8  ignore next */',
    '/* v8\tignore next */',
    '/* node:coverage ignore next */',
  ])('AI-47 reprova a forma %s e informa o arquivo e a linha', (text) => {
    const found = findSuppressions('scripts/y.ts', `const a = 1;\n${text}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'scripts/y.ts', line: 2 });
  });

  it.each([
    // Cada extensão que o oxlint confere entra na varredura, em qualquer das quatro pastas.
    'src/a.ts',
    'src/a.mts',
    'src/a.cts',
    'src/a.tsx',
    'scripts/a.js',
    '.claude/hooks/a.mjs',
    'migrations/store/20260101000000_a.cjs',
    'migrations/store/20260101000000_a.ts',
  ])('AI-47 o filtro da varredura inclui %s', (path) => {
    expect(isScannedSource(path)).toBe(true);
  });

  it.each([
    'src/a.json',
    'migrations/README.md',
    'src/a.test.ts',
    'scripts/a.test.ts',
    'src/a.test.mts',
    'src/a.test.tsx',
    'test/repo/a.ts.snap',
  ])('AI-47 o filtro da varredura não inclui %s', (path) => {
    expect(isScannedSource(path)).toBe(false);
  });

  it.each([
    '// @ts-expect-error motivo',
    '// @ts-ignore',
    '// @publicFoo não é a marca do knip',
    '// @betaFoo não é a marca do knip',
    '// @aliasFoo não é a marca do knip',
    '// v8 ignorar não é a marca',
    '// o oxlint e o eslint leem comentários de diretiva',
    '// disable não basta',
    '// ignore também não',
  ])('AI-47 não reprova %s', (text) => {
    expect(findSuppressions('src/z.ts', `${text}\n`)).toEqual([]);
  });
});

// As diretivas do TypeScript ficam com o `typescript/ban-ts-comment`: o padrão da regra aceita `@ts-expect-error` e
// `@ts-ignore` com descrição, então o .oxlintrc.json precisa ligá-la para todas. O oxlint roda numa árvore temporária
// com a configuração do projeto, sobre um arquivo com erro de tipo.
const TYPE_ERROR = "export const n: number = 'texto';\n";

const lintSample = (content: string) =>
  lintSampleFile('ai47-ts-comment-', content);

describe('AI-47 o typescript/ban-ts-comment reprova as diretivas do TypeScript, com ou sem descrição', () => {
  // Controle: sem diretiva, a amostra passa; assim a reprovação dos testes seguintes vem da diretiva.
  it('AI-47 controle: o arquivo com erro de tipo e sem diretiva passa no oxlint', () => {
    const run = lintSample(TYPE_ERROR);
    expect(run.output).not.toContain('ban-ts-comment');
    expect(run.status).toBe(0);
  }, 180_000);

  // Controle: sem descrição a regra já reprova no padrão, o que prova que a árvore carrega a regra.
  it('AI-47 controle: // @ts-expect-error sem descrição reprova', () => {
    const run = lintSample(`// @ts-expect-error\n${TYPE_ERROR}`);
    expect(run.output).toContain('ban-ts-comment');
    expect(run.status).not.toBe(0);
  }, 180_000);

  it.each([
    '// @ts-expect-error motivo qualquer',
    '// @ts-ignore motivo qualquer',
    '// @ts-expect-error',
    '// @ts-ignore',
  ])(
    'AI-47 %s acima de uma linha com erro de tipo reprova o oxlint',
    (directive) => {
      const run = lintSample(`${directive}\n${TYPE_ERROR}`);
      expect(run.output).toContain('ban-ts-comment');
      expect(run.status).not.toBe(0);
    },
    180_000,
  );

  it('AI-47 // @ts-nocheck com descrição, no topo do arquivo, reprova o oxlint', () => {
    const run = lintSample(`// @ts-nocheck motivo qualquer\n${TYPE_ERROR}`);
    expect(run.output).toContain('ban-ts-comment');
    expect(run.status).not.toBe(0);
  }, 180_000);

  it('AI-47 o .oxlintrc.json liga o ban-ts-comment com as três diretivas em true', () => {
    const config = JSON.parse(
      readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'),
    ) as { rules: Record<string, unknown> };
    const rule = config.rules['typescript/ban-ts-comment'];

    expect(rule).toEqual([
      'error',
      expect.objectContaining({
        'ts-expect-error': true,
        'ts-ignore': true,
        'ts-nocheck': true,
      }),
    ]);
  });
});
