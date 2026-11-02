import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  restrictedGroupResult,
  restrictedImportMatches,
  type RestrictionOptions,
} from './restricted-imports.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import { PARITY_TIMEOUT_MS, runOxlint, singleRuleConfig } from './lint-tree.ts';

// FND-13 e FND-14: a conferência do lint lida como dado (`no-restricted-imports` do .oxlintrc.json) decide por
// `restrictedGroupResult` e `restrictedImportMatches`; se eles divergem do oxlint, a conferência libera ou reprova o
// módulo errado sem avisar. Cada teste roda o binário do projeto e compara o que ele reprovou com o que o helper diz.

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

// ---------------------------------------------------------------- opções inteiras do no-restricted-imports

const RESTRICT_MODULES = [...MODULES, 'bar'] as const;

interface RestrictCase {
  label: string;
  options: RestrictionOptions;
  // O que o oxlint reprova, medido; a tabela é a descrição da regra, e o oxlint instalado a confere.
  expected: string[];
}

const RESTRICT_CASES: RestrictCase[] = [
  {
    label: 'string solta em patterns: node:child_process',
    options: { patterns: ['node:child_process'] },
    expected: ['node:child_process'],
  },
  {
    label: 'string solta em patterns: bar (sem barra ganha **/)',
    options: { patterns: ['bar'] },
    expected: ['Foo/bar', 'bar'],
  },
  {
    label: 'string solta em patterns: foo/* (glob, sem caixa)',
    options: { patterns: ['foo/*'] },
    expected: ['Foo/bar', 'foo/baz'],
  },
  {
    label: 'string solta em paths: exata e com caixa',
    options: { paths: ['foo/baz', 'Foo/bar'] },
    expected: ['Foo/bar', 'foo/baz'],
  },
  {
    label: 'string solta em paths: com outra caixa não casa',
    options: { paths: ['FOO/baz'] },
    expected: [],
  },
  {
    label: '(a) whitelist num item anula o found de OUTRO item (negado antes)',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], message: 'x' },
        { group: ['foo/*'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
  },
  {
    label: '(a) whitelist num item anula o found de OUTRO item (negado depois)',
    options: {
      patterns: [
        { group: ['foo/*'], message: 'x' },
        { group: ['foo/*', '!foo/baz'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
  },
  {
    label: '(a) controle: sem negação os dois itens somam',
    options: {
      patterns: [
        { group: ['foo/*'], message: 'x' },
        { group: ['bar'], message: 'x' },
      ],
    },
    expected: ['Foo/bar', 'foo/baz', 'bar'],
  },
  {
    label: '(b) a whitelist de um patterns não anula o paths do mesmo módulo',
    options: {
      paths: [{ name: 'foo/baz', message: 'x' }],
      patterns: [{ group: ['foo/*', '!foo/baz'], message: 'x' }],
    },
    expected: ['Foo/bar', 'foo/baz'],
  },
  {
    label:
      'a whitelist de um group anula também o regex de outro item (depois)',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], message: 'x' },
        { regex: 'baz', message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
  },
  {
    label: 'o regex de um item ANTES da whitelist já reprovou o módulo',
    options: {
      patterns: [
        { regex: 'baz', message: 'x' },
        { group: ['foo/*', '!foo/baz'], message: 'x' },
      ],
    },
    expected: ['Foo/bar', 'foo/baz'],
  },
  {
    label: 'a whitelist de um group anula o regex do mesmo item',
    options: {
      patterns: [{ group: ['foo/*', '!foo/baz'], regex: 'baz', message: 'x' }],
    },
    expected: ['Foo/bar'],
  },
  {
    label:
      'o regex de um item DEPOIS da whitelist não reprova; o group do item sim',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], message: 'x' },
        { group: ['bar'], regex: 'baz', message: 'x' },
      ],
    },
    expected: ['Foo/bar', 'bar'],
  },
  {
    label: 'o regex não depende do caseSensitive: false do item',
    options: {
      patterns: [
        { regex: '^foo/', caseSensitive: false, message: 'x' },
        { regex: '^BAR$', caseSensitive: false, message: 'x' },
      ],
    },
    expected: ['foo/baz'],
  },
  {
    label: '(b) controle: o paths sozinho trava o módulo',
    options: { paths: [{ name: 'foo/baz', message: 'x' }] },
    expected: ['foo/baz'],
  },
];

describe('FND-13 paridade das opções inteiras do no-restricted-imports com o oxlint', () => {
  const measured = new Map<string, string[]>();
  const failures: string[] = [];

  beforeAll(() => {
    const tree = makeTempDir('restrict-parity-');
    writeFileIn(
      tree,
      'lib/imports.ts',
      `${RESTRICT_MODULES.map((module) => `import '${module}';`).join('\n')}\n`,
    );
    RESTRICT_CASES.forEach(({ label, options }, index) => {
      const run = runOxlint(
        tree,
        singleRuleConfig([], { 'no-restricted-imports': ['error', options] }),
        `restrict-${String(index)}.json`,
      );
      if (run.stderr !== '' || (run.status !== 0 && run.status !== 1))
        failures.push(`${label}: status ${String(run.status)} ${run.stderr}`);
      measured.set(
        label,
        run.reports
          .filter((report) => report.file === 'lib/imports.ts')
          .map(
            (report) =>
              RESTRICT_MODULES[report.line - 1] ?? `linha ${report.line}`,
          )
          .sort(),
      );
    });
  }, PARITY_TIMEOUT_MS);

  afterAll(cleanupTempDirs);

  it('FND-13 controle: o oxlint rodou a regra sobre as opções inteiras', () => {
    expect(failures).toEqual([]);
    expect([...measured.values()].some((modules) => modules.length > 0)).toBe(
      true,
    );
  });

  it.each(RESTRICT_CASES.map((c): [string, RestrictCase] => [c.label, c]))(
    'FND-13 o oxlint reprova os módulos esperados: %s',
    (label, testCase) => {
      expect(measured.get(label)).toEqual([...testCase.expected].sort());
    },
  );

  // O leitor que os testes de configuração usam tem de reprovar os mesmos módulos que o oxlint mediu.
  it.each(RESTRICT_CASES.map((c): [string, RestrictCase] => [c.label, c]))(
    'FND-13 o restrictedImportMatches reprova os mesmos módulos que o oxlint: %s',
    (label, testCase) => {
      const expected = RESTRICT_MODULES.filter((module) =>
        restrictedImportMatches(testCase.options, module, 'default'),
      ).sort();
      expect(expected).toEqual(measured.get(label));
    },
  );
});
