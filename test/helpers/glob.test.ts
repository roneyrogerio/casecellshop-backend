import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  globToRegExp,
  overrideFilesMatch,
  restrictedGroupResult,
} from './glob.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import { oxlintBin } from './lint-tree.ts';
import { runCommand } from './run-node.ts';

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
const PARITY_TIMEOUT_MS = 120_000;

interface Report {
  file: string;
  line: number;
}

interface OxlintRun {
  status: number | null;
  stderr: string;
  reports: Report[];
}

function runOxlint(tree: string, config: unknown, name: string): OxlintRun {
  writeFileIn(tree, name, JSON.stringify(config));
  const result = runCommand(
    oxlintBin,
    ['-c', name, '--format=unix', '--disable-nested-config', '.'],
    { cwd: tree },
  );
  const reports = [...result.stdout.matchAll(/^(\S+?):(\d+):\d+: /gm)].map(
    (match): Report => ({
      file: (match[1] ?? '').replace(/^\.\//, ''),
      line: Number(match[2]),
    }),
  );
  return { status: result.status, stderr: result.stderr, reports };
}

// Sem as categorias, só a regra da vez fica ligada: o que sai da saída é o que a regra e o glob casaram.
function singleRuleConfig(overrides: unknown[], rules: unknown = {}) {
  return { categories: { correctness: 'off' }, rules, overrides };
}

// Um arquivo por amostra com `debugger;`: o oxlint reporta o arquivo se o override com `no-debugger` o casar.
const FILE_SAMPLES = [
  'a/b.js',
  'axb.js',
  'ayb.js',
  'sub/x.ts',
  'x.ts',
  'a/b/c.ts',
];

const OVERRIDE_GLOBS = [
  'a[!x]b.js',
  'a[^x]b.js',
  'a[/y]b.js',
  'a[xy]b.js',
  'a?b.js',
  '*.ts',
  './x.ts',
  'sub/*.ts',
  '**/*.ts',
  'a/**',
  '{a,sub}/**/*.ts',
  '!**/*.js',
];

describe('FND-13 paridade dos files dos overrides com o oxlint', () => {
  const measured = new Map<string, string[]>();
  const failures: string[] = [];

  beforeAll(() => {
    const tree = makeTempDir('glob-parity-');
    for (const file of FILE_SAMPLES) writeFileIn(tree, file, 'debugger;\n');
    OVERRIDE_GLOBS.forEach((glob, index) => {
      const run = runOxlint(
        tree,
        singleRuleConfig([
          { files: [glob], rules: { 'no-debugger': 'error' } },
        ]),
        `override-${String(index)}.json`,
      );
      if (run.stderr !== '' || (run.status !== 0 && run.status !== 1))
        failures.push(`${glob}: status ${String(run.status)} ${run.stderr}`);
      measured.set(glob, run.reports.map((report) => report.file).sort());
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
    expect(measured.get('a?b.js')).toEqual(['axb.js', 'ayb.js']);
  });

  it.each(OVERRIDE_GLOBS)(
    'FND-13 o overrideFilesMatch casa as mesmas amostras que o oxlint: %s',
    (glob) => {
      const expected = FILE_SAMPLES.filter((file) =>
        overrideFilesMatch([glob], file),
      ).sort();
      expect(expected).toEqual(measured.get(glob));
    },
  );
});

const MODULES = [
  'Foo/bar',
  'foo/baz',
  'node:child_process',
  './local/x.js',
] as const;

interface GroupCase {
  group: string[];
  caseSensitive?: boolean;
}

const GROUP_CASES: GroupCase[] = [
  { group: ['foo/*'] },
  { group: ['FOO/*'] },
  { group: ['FOO/*'], caseSensitive: true },
  { group: ['foo/*', '!foo/baz'] },
  { group: ['!foo/baz', 'foo/*'] },
  { group: ['bar'] },
  { group: ['node:child_process'] },
];

function groupLabel({ group, caseSensitive }: GroupCase): string {
  return `${JSON.stringify(group)}${caseSensitive === true ? ' com caseSensitive' : ''}`;
}

describe('FND-13 paridade do group do no-restricted-imports com o oxlint', () => {
  const measured = new Map<GroupCase, string[]>();
  const failures: string[] = [];

  beforeAll(() => {
    const tree = makeTempDir('group-parity-');
    // Uma importação por linha: a linha do relatório diz qual módulo foi reportado.
    writeFileIn(
      tree,
      'lib/imports.ts',
      `${MODULES.map((module) => `import '${module}';`).join('\n')}\n`,
    );
    GROUP_CASES.forEach((groupCase, index) => {
      const pattern: Record<string, unknown> = {
        group: groupCase.group,
        message: 'x',
      };
      if (groupCase.caseSensitive !== undefined)
        pattern.caseSensitive = groupCase.caseSensitive;
      const run = runOxlint(
        tree,
        singleRuleConfig([], {
          'no-restricted-imports': ['error', { patterns: [pattern] }],
        }),
        `group-${String(index)}.json`,
      );
      if (run.stderr !== '' || (run.status !== 0 && run.status !== 1))
        failures.push(
          `${groupLabel(groupCase)}: status ${String(run.status)} ${run.stderr}`,
        );
      measured.set(
        groupCase,
        run.reports
          .filter((report) => report.file === 'lib/imports.ts')
          .map((report) => MODULES[report.line - 1] ?? `linha ${report.line}`)
          .sort(),
      );
    });
  }, PARITY_TIMEOUT_MS);

  afterAll(cleanupTempDirs);

  it('FND-13 controle: o oxlint rodou a regra e reportou importações em algum group', () => {
    expect(failures).toEqual([]);
    const reportedSomething = [...measured.values()].some(
      (modules) => modules.length > 0,
    );
    expect(reportedSomething).toBe(true);
    // Um group que não casa nada deixa o arquivo limpo: o controle distingue casar de não casar.
    expect(measured.get(GROUP_CASES[2] as GroupCase)).toEqual([]);
  });

  it.each(
    GROUP_CASES.map((groupCase): [string, GroupCase] => [
      groupLabel(groupCase),
      groupCase,
    ]),
  )(
    'FND-13 o restrictedGroupResult reprova os mesmos módulos que o oxlint: %s',
    (_label, groupCase) => {
      const expected = MODULES.filter(
        (module) =>
          restrictedGroupResult(
            groupCase.group,
            module,
            groupCase.caseSensitive,
          ) === 'found',
      ).sort();
      expect(expected).toEqual(measured.get(groupCase));
    },
  );
});
