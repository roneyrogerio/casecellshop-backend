import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  restrictedGroupResult,
  restrictedImportMatches,
  type RestrictionOptions,
} from './restricted-imports.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import {
  PARITY_TIMEOUT_MS,
  runOxlint,
  singleRuleConfig,
  type OxlintRun,
} from './lint-tree.ts';

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

// Imports com nome, em linhas separadas: o oxlint decide por nome importado quando o item traz `importNames` ou
// `allowImportNames`, então o mesmo módulo aparece com nomes diferentes. O nome local é único por linha (`as v0`),
// para a amostra não ter declaração repetida.
const NAMED_IMPORTS = [
  { module: 'foo/baz', name: 'a' },
  { module: 'foo/baz', name: 'b' },
  { module: 'Foo/bar', name: 'a' },
  { module: 'Foo/bar', name: 'b' },
] as const;

function namedLabel({ module, name }: (typeof NAMED_IMPORTS)[number]): string {
  return `${module}:${name}`;
}

interface RestrictCase {
  label: string;
  options: RestrictionOptions;
  // O que o oxlint reprova nos imports sem nome (`import 'x'`), medido; a tabela é a descrição da regra, e o oxlint
  // instalado a confere.
  expected: string[];
  // O mesmo nos imports com nome de NAMED_IMPORTS (`módulo:nome`). Só os casos com `importNames` ou
  // `allowImportNames` têm a tabela: nos outros o resultado repete o de `expected` para os dois nomes.
  expectedNamed?: string[];
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
  // A3 do #35: o oxlint decide por nome importado quando o item traz `importNames` ou `allowImportNames`. No import
  // sem nome o `group` vale sem olhar os nomes do item.
  {
    label:
      'group com importNames: trava só o nome listado (import sem nome: o módulo)',
    options: {
      patterns: [{ group: ['foo/*'], importNames: ['a'], message: 'x' }],
    },
    expected: ['Foo/bar', 'foo/baz'],
    expectedNamed: ['Foo/bar:a', 'foo/baz:a'],
  },
  {
    label:
      'group negado com importNames: a whitelist tira o módulo, só do nome listado',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], importNames: ['a'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a'],
  },
  {
    label:
      'group negado sem importNames: a whitelist tira o módulo, de todos os nomes',
    options: {
      patterns: [{ group: ['foo/*', '!foo/baz'], message: 'x' }],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a', 'Foo/bar:b'],
  },
  {
    label:
      'a whitelist de um item com importNames não anula o outro item no nome que ele não lista (negado antes)',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], importNames: ['a'], message: 'x' },
        { group: ['foo/*'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a', 'Foo/bar:b', 'foo/baz:b'],
  },
  {
    label:
      'a whitelist de um item com importNames não anula o outro item no nome que ele não lista (negado depois)',
    options: {
      patterns: [
        { group: ['foo/*'], message: 'x' },
        { group: ['foo/*', '!foo/baz'], importNames: ['a'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a', 'Foo/bar:b', 'foo/baz:b'],
  },
  {
    label:
      'a whitelist de um item com importNames: [b] anula o outro item só no nome b',
    options: {
      patterns: [
        { group: ['foo/*'], message: 'x' },
        { group: ['foo/*', '!foo/baz'], importNames: ['b'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a', 'Foo/bar:b', 'foo/baz:a'],
  },
  {
    label:
      'a whitelist e o group em itens com importNames diferentes: cada um vale para o seu nome',
    options: {
      patterns: [
        { group: ['foo/*'], importNames: ['a'], message: 'x' },
        { group: ['!foo/baz'], importNames: ['b'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:a', 'foo/baz:a'],
  },
  {
    label:
      'group negado com allowImportNames: trava os nomes fora da lista, menos o módulo da whitelist',
    options: {
      patterns: [
        { group: ['foo/*', '!foo/baz'], allowImportNames: ['a'], message: 'x' },
      ],
    },
    expected: ['Foo/bar'],
    expectedNamed: ['Foo/bar:b'],
  },
  {
    label:
      'regex com importNames: trava só o nome listado (import sem nome: nada)',
    options: {
      patterns: [{ regex: 'foo', importNames: ['a'], message: 'x' }],
    },
    expected: [],
    expectedNamed: ['foo/baz:a'],
  },
  {
    label:
      'paths com importNames: trava só o nome listado (import sem nome: nada)',
    options: {
      paths: [{ name: 'foo/baz', importNames: ['a'], message: 'x' }],
    },
    expected: [],
    expectedNamed: ['foo/baz:a'],
  },
  {
    label:
      'paths com allowImportNames: trava os nomes fora da lista (import sem nome: o módulo)',
    options: {
      paths: [{ name: 'foo/baz', allowImportNames: ['a'], message: 'x' }],
    },
    expected: ['foo/baz'],
    expectedNamed: ['foo/baz:b'],
  },
];

describe('FND-13 paridade das opções inteiras do no-restricted-imports com o oxlint', () => {
  // `bare`: os módulos de RESTRICT_MODULES importados sem nome; `named`: os `módulo:nome` de NAMED_IMPORTS.
  const measured = new Map<string, { bare: string[]; named: string[] }>();
  const failures: string[] = [];

  // Os rótulos que o oxlint reportou no arquivo, um por linha de amostra. Um import reprovado por dois itens sai duas
  // vezes no relatório e conta uma só.
  function reportedIn(
    run: OxlintRun,
    file: string,
    labels: readonly string[],
  ): string[] {
    return [
      ...new Set(
        run.reports
          .filter((report) => report.file === file)
          .map((report) => labels[report.line - 1] ?? `linha ${report.line}`),
      ),
    ].sort();
  }

  beforeAll(() => {
    const tree = makeTempDir('restrict-parity-');
    writeFileIn(
      tree,
      'lib/imports.ts',
      `${RESTRICT_MODULES.map((module) => `import '${module}';`).join('\n')}\n`,
    );
    writeFileIn(
      tree,
      'lib/named.ts',
      `${NAMED_IMPORTS.map(
        ({ module, name }, index) =>
          `import { ${name} as v${String(index)} } from '${module}';`,
      ).join('\n')}\n`,
    );
    RESTRICT_CASES.forEach(({ label, options }, index) => {
      const run = runOxlint(
        tree,
        singleRuleConfig([], { 'no-restricted-imports': ['error', options] }),
        `restrict-${String(index)}.json`,
      );
      if (run.stderr !== '' || (run.status !== 0 && run.status !== 1))
        failures.push(`${label}: status ${String(run.status)} ${run.stderr}`);
      measured.set(label, {
        bare: reportedIn(run, 'lib/imports.ts', RESTRICT_MODULES),
        named: reportedIn(run, 'lib/named.ts', NAMED_IMPORTS.map(namedLabel)),
      });
    });
  }, PARITY_TIMEOUT_MS);

  afterAll(cleanupTempDirs);

  it('FND-13 controle: o oxlint rodou a regra sobre as opções inteiras', () => {
    expect(failures).toEqual([]);
    expect([...measured.values()].some(({ bare }) => bare.length > 0)).toBe(
      true,
    );
    // O oxlint também distingue o nome importado: o mesmo módulo é reprovado com `a` e liberado com `b`.
    const byName = measured.get(
      'group com importNames: trava só o nome listado (import sem nome: o módulo)',
    );
    expect(byName?.named).toContain('foo/baz:a');
    expect(byName?.named).not.toContain('foo/baz:b');
  });

  it.each(RESTRICT_CASES.map((c): [string, RestrictCase] => [c.label, c]))(
    'FND-13 o oxlint reprova os módulos esperados: %s',
    (label, testCase) => {
      expect(measured.get(label)?.bare).toEqual([...testCase.expected].sort());
    },
  );

  it.each(
    RESTRICT_CASES.filter((c) => c.expectedNamed !== undefined).map(
      (c): [string, RestrictCase] => [c.label, c],
    ),
  )(
    'FND-13 o oxlint reprova os imports com nome esperados: %s',
    (label, testCase) => {
      expect(measured.get(label)?.named).toEqual(
        [...(testCase.expectedNamed ?? [])].sort(),
      );
    },
  );

  // O leitor que os testes de configuração usam tem de reprovar os mesmos módulos que o oxlint mediu.
  it.each(RESTRICT_CASES.map((c): [string, RestrictCase] => [c.label, c]))(
    'FND-13 o restrictedImportMatches reprova os mesmos módulos que o oxlint: %s',
    (label, testCase) => {
      const bare = RESTRICT_MODULES.filter((module) =>
        restrictedImportMatches(testCase.options, module, undefined),
      ).sort();
      const named = NAMED_IMPORTS.filter(({ module, name }) =>
        restrictedImportMatches(testCase.options, module, name),
      )
        .map(namedLabel)
        .sort();
      expect({ bare, named }).toEqual(measured.get(label));
    },
  );
});
