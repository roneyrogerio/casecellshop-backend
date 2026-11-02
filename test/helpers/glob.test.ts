import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globToRegExp, overrideFilesMatch } from './glob.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import { PARITY_TIMEOUT_MS, runOxlint, singleRuleConfig } from './lint-tree.ts';

// FND-13 e FND-14: a conferência do lint lida como dado (`files` dos overrides do .oxlintrc.json) decide pelo
// `globToRegExp`; se ele traduz errado, a conferência libera ou reprova o arquivo errado sem avisar.

interface GlobCase {
  glob: string;
  matches: string[];
  rejects: string[];
}

// O que a configuração do lint já usa e o helper já traduzia certo: o controle da correção.
const SUPPORTED: GlobCase[] = [
  {
    glob: 'src/*.ts',
    matches: ['src/a.ts', 'src/.ts'],
    rejects: ['src/a/b.ts', 'src/a.tsx', 'lib/a.ts'],
  },
  {
    glob: '**/*.ts',
    matches: ['a.ts', 'src/a.ts', 'src/a/b/c.ts'],
    rejects: ['a.js', 'src/a.ts.map'],
  },
  {
    glob: 'src/**',
    matches: ['src/a', 'src/a/b/c.ts'],
    rejects: ['lib/a'],
  },
  {
    glob: 'test/**/helpers',
    matches: ['test/helpers', 'test/a/b/helpers'],
    rejects: ['test/helpers/x', 'tests/helpers'],
  },
  {
    glob: 'a?c',
    matches: ['abc', 'a-c'],
    rejects: ['ac', 'abbc', 'a/c'],
  },
  {
    glob: '*.[jt]s',
    matches: ['a.js', 'a.ts'],
    rejects: ['a.cs', 'a.jts'],
  },
  {
    glob: '*.{ts,js}',
    matches: ['a.ts', 'a.js'],
    rejects: ['a.cs', 'a.ts,js', 'a.'],
  },
  {
    glob: 'a.b',
    matches: ['a.b'],
    rejects: ['axb'],
  },
  {
    glob: 'a,b',
    matches: ['a,b'],
    rejects: ['a', 'b'],
  },
];

// Os dois defeitos achados na revisão (A18): vírgula fora de chaves depois de um grupo, e classe negada `[!…]`.
const COMMA_OUTSIDE_BRACES: GlobCase[] = [
  {
    glob: '{a,b}/x,y',
    matches: ['a/x,y', 'b/x,y'],
    rejects: ['a/x', 'a/y', 'b/y', 'y'],
  },
  {
    glob: '{a,b}x,y',
    matches: ['ax,y', 'bx,y'],
    rejects: ['ax', 'y', 'by'],
  },
  {
    glob: 'x,{a,b}',
    matches: ['x,a', 'x,b'],
    rejects: ['x', 'a', 'b', 'xa'],
  },
  {
    glob: '{a,b}/x,y/{c,d}.ts',
    matches: ['a/x,y/c.ts', 'b/x,y/d.ts'],
    rejects: ['a/x', 'y/c.ts', 'a/x,y/e.ts'],
  },
];

// A classe negada traduzida para `[^…]` vale para estes casos, em que a classe fica dentro de um trecho do caminho.
// Fora deles o oxlint não segue a regex: no fast-glob 1.1.1 que ele traz, `[!x]` e `[^x]` casam também a `/` (a
// paridade com o oxlint real está em "FND-13 paridade dos files dos overrides com o oxlint").
const NEGATED_CLASS: GlobCase[] = [
  {
    glob: 'a[!x]',
    matches: ['ab', 'a1', 'a!'],
    rejects: ['ax', 'a'],
  },
  {
    glob: '[!a-c].ts',
    matches: ['d.ts', 'z.ts', '!.ts'],
    rejects: ['a.ts', 'b.ts', 'c.ts'],
  },
  {
    glob: 'src/[!_]*.ts',
    matches: ['src/a.ts', 'src/main.ts'],
    rejects: ['src/_a.ts'],
  },
];

// Chaves aninhadas: o helper conta a profundidade, então a vírgula só vira alternativa dentro de alguma chave.
const NESTED_BRACES: GlobCase[] = [
  {
    glob: '{a,{b,c}}/x',
    matches: ['a/x', 'b/x', 'c/x'],
    rejects: ['d/x', 'a', 'x'],
  },
  {
    glob: '{a,b{c,d}}/x,y',
    matches: ['a/x,y', 'bc/x,y', 'bd/x,y'],
    rejects: ['b/x,y', 'a/x', 'bc/y'],
  },
];

function expectCase({ glob, matches, rejects }: GlobCase) {
  const regExp = globToRegExp(glob);
  expect({
    glob,
    matched: matches.filter((sample) => regExp.test(sample)),
    rejected: rejects.filter((sample) => !regExp.test(sample)),
  }).toEqual({ glob, matched: matches, rejected: rejects });
}

describe('FND-13 globToRegExp', () => {
  it.each(SUPPORTED)(
    'FND-13 traduz o que a configuração já usa: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(COMMA_OUTSIDE_BRACES)(
    'FND-13 a vírgula fora de chaves é literal, mesmo depois de um grupo: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(NEGATED_CLASS)(
    'FND-13 a classe negada [!…] casa o que não está nela: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(NESTED_BRACES)(
    'FND-13 chaves aninhadas viram alternativas só dentro das chaves: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );
});

// ---------------------------------------------------------------- paridade com o oxlint instalado

// O que o oxlint reporta é a medida: cada teste roda o binário do projeto sobre uma árvore temporária (fora do
// repositório) e compara o que ele casou com o que o helper diz. Um processo por glob, feitos uma vez no `beforeAll`.

// Um arquivo por amostra com `debugger;`: o oxlint reporta o arquivo se o override com `no-debugger` o casar.
const FILE_SAMPLES = [
  'a/b.js',
  'axb.js',
  'ayb.js',
  'sub/x.ts',
  'x.ts',
  'a/b/c.ts',
];

// Cada caso é o `files` inteiro de um override: um padrão só, ou vários (o `GlobSet` casa se algum casar).
const OVERRIDE_FILES: string[][] = [
  ['a[!x]b.js'],
  ['a[^x]b.js'],
  ['a[/y]b.js'],
  ['a[xy]b.js'],
  ['a?b.js'],
  ['*.ts'],
  ['./x.ts'],
  ['sub/*.ts'],
  ['**/*.ts'],
  ['a/**'],
  ['{a,sub}/**/*.ts'],
  ['!**/*.js'],
  ['!*.ts'],
  ['!!**/*.js'],
  ['x.ts'],
  ['./sub/x.ts'],
  ['./*.ts'],
  // O `!` vale para o glob inteiro, pasta e nome (A1 do #35).
  ['!sub/*.[jt]s'],
  ['!sub/[a-z]*.?s'],
  ['!**/*.[jt]s'],
  // Mais de um padrão (A3 do #35): o conjunto casa se algum padrão casar, e um `!` dentro dele não exclui nada.
  ['**/*.ts', '!x.ts'],
  ['!x.ts', '**/*.ts'],
  ['sub/*.ts', 'x.ts'],
  ['!sub/*.ts', '!x.ts'],
  // Controle: o `!x.ts` sozinho (sem `/`, vira `**/!x.ts`, um nome literal) não casa nada, então o `x.ts` que o
  // conjunto `['**/*.ts', '!x.ts']` reporta vem do `**/*.ts`, e não do `!x.ts`.
  ['!x.ts'],
];

function filesLabel(files: readonly string[]): string {
  return JSON.stringify(files);
}

describe('FND-13 paridade dos files dos overrides com o oxlint', () => {
  const measured = new Map<string, string[]>();
  const failures: string[] = [];

  beforeAll(() => {
    const tree = makeTempDir('glob-parity-');
    for (const file of FILE_SAMPLES) writeFileIn(tree, file, 'debugger;\n');
    OVERRIDE_FILES.forEach((files, index) => {
      const run = runOxlint(
        tree,
        singleRuleConfig([{ files, rules: { 'no-debugger': 'error' } }]),
        `override-${String(index)}.json`,
      );
      if (run.stderr !== '' || (run.status !== 0 && run.status !== 1))
        failures.push(
          `${filesLabel(files)}: status ${String(run.status)} ${run.stderr}`,
        );
      measured.set(
        filesLabel(files),
        run.reports.map((report) => report.file).sort(),
      );
    });
  }, PARITY_TIMEOUT_MS);

  afterAll(cleanupTempDirs);

  it('FND-13 controle: o oxlint rodou a regra e reportou arquivos em algum glob', () => {
    expect(failures).toEqual([]);
    const reportedSomething = [...measured.values()].some(
      (files) => files.length > 0,
    );
    expect(reportedSomething).toBe(true);
    // O oxlint também deixa de reportar o que o glob não casa: o `?` não casa a `/`, então a/b.js fica de fora.
    expect(measured.get(filesLabel(['a?b.js']))).toEqual(['axb.js', 'ayb.js']);
    // Um `!x.ts` dentro do conjunto não exclui o `x.ts`: sozinho ele não casa nada, e o conjunto reporta o `x.ts`
    // pelo outro padrão, em qualquer ordem.
    expect(measured.get(filesLabel(['!x.ts']))).toEqual([]);
    expect(measured.get(filesLabel(['**/*.ts', '!x.ts']))).toContain('x.ts');
    expect(measured.get(filesLabel(['!x.ts', '**/*.ts']))).toContain('x.ts');
  });

  it.each(
    OVERRIDE_FILES.map((files): [string, string[]] => [
      filesLabel(files),
      files,
    ]),
  )(
    'FND-13 o overrideFilesMatch casa as mesmas amostras que o oxlint: %s',
    (label, files) => {
      const expected = FILE_SAMPLES.filter((file) =>
        overrideFilesMatch(files, file),
      ).sort();
      expect(expected).toEqual(measured.get(label));
    },
  );
});
