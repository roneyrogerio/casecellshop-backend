import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/repo-root.ts';

// AI-47: nenhum comentário de supressão fica em src/, scripts/ e .claude/hooks/, fora dos testes. Cada um cala uma
// checagem que o agente não pode afrouxar pela configuração (AI-04), e o comentário fica num arquivo que ele edita.
//
// Decisões sobre o que conta:
// - `eslint-disable` e `oxlint-disable` casam como texto, então valem as formas `-next-line`, `-line` e o bloco
//   `/* eslint-disable */`; o `@public` do knip casa como palavra (`@publicFoo` não conta).
// - `// @ts-expect-error` e `// @ts-ignore` NÃO estão na lista: o `typescript/ban-ts-comment` do .oxlintrc.json já
//   os reprova, e o critério não os cita.
// - A conferência é por texto, sem separar comentário de código: uma string com a diretiva também reprova, o que é
//   o lado seguro (o agente não esconde a supressão numa forma que o teste não leia).
const SUPPRESSIONS = [
  'oxlint-disable',
  'eslint-disable',
  '@public',
  'jscpd:ignore',
  'v8 ignore',
  'c8 ignore',
  'istanbul ignore',
];

const SUPPRESSION_PATTERN = new RegExp(
  SUPPRESSIONS.map((token) =>
    token.endsWith('public') ? `${token}\\b` : token,
  ).join('|'),
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

function trackedSources(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '--', 'src', 'scripts', '.claude/hooks'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(`git ls-files falhou: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .filter(
      (file) => /\.(ts|mjs|js)$/.test(file) && !file.endsWith('.test.ts'),
    );
}

describe('AI-47 nenhum comentário de supressão fora dos testes', () => {
  it('AI-47 src/, scripts/ e .claude/hooks/ não têm comentário de supressão', () => {
    const files = trackedSources();
    // Controle: a varredura só vale se leu arquivos das três pastas.
    for (const dir of ['src/', 'scripts/', '.claude/hooks/'])
      expect(
        files.some((file) => file.startsWith(dir)),
        `a varredura leu arquivos de ${dir}`,
      ).toBe(true);
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);

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
  ])('AI-47 reprova a forma %s e informa o arquivo e a linha', (text) => {
    const found = findSuppressions('scripts/y.ts', `const a = 1;\n${text}\n`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: 'scripts/y.ts', line: 2 });
  });

  it.each([
    '// @ts-expect-error motivo',
    '// @ts-ignore',
    '// @publicFoo não é a marca do knip',
    '// o oxlint e o eslint leem comentários de diretiva',
    '// disable não basta',
    '// ignore também não',
  ])('AI-47 não reprova %s', (text) => {
    expect(findSuppressions('src/z.ts', `${text}\n`)).toEqual([]);
  });
});
