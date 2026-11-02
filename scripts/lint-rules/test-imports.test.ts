import { RuleTester } from 'oxlint/plugins-dev';
import { describe, expect, it } from 'vitest';
import plugin from './test-imports.ts';

// FND-13 (Processos) e FND-14: a regra test-imports/no-restricted-dynamic-import reprova o import('…') de um módulo
// restrito, que o no-restricted-imports do oxlint não vê quando a entrada tem importNames. O nome de cada caso começa
// pelo ID do critério (AI-38 e AI-18). A escolha de pastas e de módulos por pasta fica em
// test/repo/restricted-imports.test.ts (a configuração lida como dado) e em test/repo/restricted-imports-lint.test.ts
// (o oxlint de verdade numa árvore temporária).
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: 'ts' }, sourceType: 'module' },
});

const CHILD_PROCESS_MESSAGE =
  'Processo filho dos testes passa pelo runCommand de test/helpers/run-node.ts (FND-13).';
const CONTAINERS_MESSAGE =
  'Os contêineres dos testes sobem por rodada no globalSetup (FND-14).';

// As opções seguem a forma do `paths` do no-restricted-imports: o nome do módulo e a mensagem.
const OPTIONS = [
  {
    paths: [
      { name: 'node:child_process', message: CHILD_PROCESS_MESSAGE },
      { name: 'testcontainers', message: CONTAINERS_MESSAGE },
    ],
  },
];

function ok(
  label: string,
  code: string,
  options: RuleTester.ValidTestCase['options'] = OPTIONS,
): RuleTester.ValidTestCase {
  return { code, options, name: `FND-13 passa ${label}` };
}

function bad(
  label: string,
  code: string,
  messages: string[] = [CHILD_PROCESS_MESSAGE],
): RuleTester.InvalidTestCase {
  return {
    code,
    options: OPTIONS,
    errors: messages.map((message) => ({ message })),
    name: `FND-13 reprova ${label}`,
  };
}

ruleTester.run(
  'no-restricted-dynamic-import',
  plugin.rules['no-restricted-dynamic-import'],
  {
    valid: [
      ok(
        "um import('node:fs'), que não é restrito",
        "await import('node:fs');",
      ),
      ok(
        "um módulo cujo nome só começa igual (import('node:child_process_extra'))",
        "await import('node:child_process_extra');",
      ),
      ok(
        "um subcaminho do módulo restrito (import('testcontainers/x'))",
        "await import('testcontainers/x');",
      ),
      ok(
        'um especificador calculado por variável (import(name)), lacuna documentada como na regra do Kysely',
        'const name = "node:child_process";\nawait import(name);',
      ),
      ok(
        'um especificador em template com expressão (import(`${a}`))',
        'await import(`${a}`);',
      ),
      ok(
        'um especificador em template com texto e expressão (import(`node:child_${x}`))',
        'await import(`node:child_${x}`);',
      ),
      ok(
        'um import estático do módulo restrito (é do no-restricted-imports, e não desta regra)',
        "import { spawnSync } from 'node:child_process';\nspawnSync('ls');",
      ),
      ok(
        'um import estático de namespace do módulo restrito',
        "import * as cp from 'node:child_process';\ncp.spawnSync('ls');",
      ),
      ok(
        "o nome do módulo citado só em comentário (// await import('node:child_process'))",
        "// await import('node:child_process');\nconst x = 1;",
      ),
      ok(
        'o nome do módulo citado só em string (const text = "import(\'node:child_process\')")',
        'const text = "import(\'node:child_process\')";',
      ),
      ok(
        'o nome do módulo como argumento de outra função (load(…))',
        "load('node:child_process');",
      ),
      ok(
        'um require do módulo (fora do escopo desta regra)',
        "const cp = require('node:child_process');",
      ),
      ok(
        'sem opções, nada é restrito',
        "await import('node:child_process');",
        [],
      ),
      ok(
        'com a lista vazia, nada é restrito',
        "await import('node:child_process');\nawait import('testcontainers');",
        [{ paths: [] }],
      ),
    ],
    invalid: [
      bad(
        "um await import('node:child_process')",
        "await import('node:child_process');",
      ),
      bad('um import com aspas duplas', 'await import("node:child_process");'),
      bad(
        "um import('node:child_process').then(…) sem await",
        "import('node:child_process').then((module) => module.spawnSync('ls'));",
      ),
      bad(
        'um import com template literal sem expressão',
        'await import(`node:child_process`);',
      ),
      bad(
        "um const { spawnSync } = await import('node:child_process')",
        "const { spawnSync } = await import('node:child_process');",
      ),
      bad(
        "um (await import('testcontainers')).GenericContainer, com a mensagem do módulo",
        "const Container = (await import('testcontainers')).GenericContainer;",
        [CONTAINERS_MESSAGE],
      ),
      bad(
        "um import('testcontainers') com a mensagem configurada para ele",
        "const module = await import('testcontainers');",
        [CONTAINERS_MESSAGE],
      ),
      bad(
        'um import dinâmico dentro de uma função, de um beforeAll',
        [
          'beforeAll(async () => {',
          "  ({ spawnSync } = await import('node:child_process'));",
          '});',
        ].join('\n'),
      ),
      bad(
        'um import dinâmico de cada módulo restrito, um erro por import e a mensagem de cada um',
        [
          "await import('node:child_process');",
          "await import('testcontainers');",
        ].join('\n'),
        [CHILD_PROCESS_MESSAGE, CONTAINERS_MESSAGE],
      ),
      bad(
        'dois imports dinâmicos do mesmo módulo, um erro por import',
        [
          "await import('node:child_process');",
          "await import('node:child_process');",
        ].join('\n'),
        [CHILD_PROCESS_MESSAGE, CHILD_PROCESS_MESSAGE],
      ),
      bad(
        "o import dinâmico ao lado de um import('node:fs') livre: só o restrito reprova",
        [
          "await import('node:fs');",
          "await import('node:child_process');",
        ].join('\n'),
      ),
    ],
  },
);

// A19 (OBS-07): a opção `patterns`, uma lista de { regex, message } como a do no-restricted-imports, para travar o
// módulo e os subcaminhos dele (import('pino/pino.js')) numa entrada só. O `paths` segue valendo como acima.
const PINO_MESSAGE =
  'O pino só entra por src/shared/logging.ts (OBS-07, AD-029).';
const PATTERN_OPTIONS = [
  { patterns: [{ regex: '^pino(/|$)', message: PINO_MESSAGE }] },
];
const MIXED_OPTIONS = [
  {
    paths: [{ name: 'node:child_process', message: CHILD_PROCESS_MESSAGE }],
    patterns: [{ regex: '^pino(/|$)', message: PINO_MESSAGE }],
  },
];

function okPattern(
  label: string,
  code: string,
  options: RuleTester.ValidTestCase['options'] = PATTERN_OPTIONS,
): RuleTester.ValidTestCase {
  return { code, options, name: `OBS-07 passa ${label}` };
}

function badPattern(
  label: string,
  code: string,
  messages: string[] = [PINO_MESSAGE],
  options: RuleTester.InvalidTestCase['options'] = PATTERN_OPTIONS,
): RuleTester.InvalidTestCase {
  return {
    code,
    options,
    errors: messages.map((message) => ({ message })),
    name: `OBS-07 reprova ${label}`,
  };
}

ruleTester.run(
  'no-restricted-dynamic-import com patterns',
  plugin.rules['no-restricted-dynamic-import'],
  {
    valid: [
      okPattern(
        "um import('pinot'), que só começa igual",
        "await import('pinot');",
      ),
      okPattern(
        "um import relativo ('./pino.ts')",
        "await import('./pino.ts');",
      ),
      okPattern(
        "um módulo que só contém o nome no meio (import('my-pino/x'))",
        "await import('my-pino/x');",
      ),
      okPattern(
        'um especificador calculado por variável, lacuna documentada',
        'const name = "pino";\nawait import(name);',
      ),
      okPattern(
        "o import('pino') citado só em comentário",
        "// await import('pino');\nconst x = 1;",
      ),
      okPattern(
        "um import estático de 'pino' (é do no-restricted-imports)",
        "import { pino } from 'pino';\npino();",
      ),
      okPattern(
        'o pino com a lista de patterns vazia',
        "await import('pino');",
        [{ patterns: [] }],
      ),
      okPattern(
        "o import('pino') quando só o paths está configurado para outro módulo",
        "await import('pino');",
        MIXED_OPTIONS.map(({ paths }) => ({ paths })),
      ),
    ],
    invalid: [
      badPattern("um await import('pino')", "await import('pino');"),
      badPattern(
        "um await import('pino/pino.js'), o subcaminho",
        "await import('pino/pino.js');",
      ),
      badPattern(
        "um import('pino/file') sem await, com then",
        "import('pino/file').then((module) => module.default);",
      ),
      badPattern('um import do pino com aspas duplas', 'await import("pino");'),
      badPattern(
        'um import do pino em template literal sem expressão',
        'await import(`pino/pino.js`);',
      ),
      badPattern(
        "um const { pino } = await import('pino') dentro de uma função",
        [
          'async function load() {',
          "  const { pino } = await import('pino');",
          '  return pino;',
          '}',
        ].join('\n'),
      ),
      badPattern(
        'dois imports do pino, um erro por import',
        ["await import('pino');", "await import('pino/pino.js');"].join('\n'),
        [PINO_MESSAGE, PINO_MESSAGE],
      ),
      badPattern(
        "o paths e o patterns juntos: o import('pino/pino.js') reprova pelo patterns",
        "await import('pino/pino.js');",
        [PINO_MESSAGE],
        MIXED_OPTIONS,
      ),
      badPattern(
        "o paths e o patterns juntos: o import('node:child_process') segue reprovando pelo paths",
        "await import('node:child_process');",
        [CHILD_PROCESS_MESSAGE],
        MIXED_OPTIONS,
      ),
      badPattern(
        'o paths e o patterns juntos: um erro por import, cada um com a mensagem da própria entrada',
        ["await import('node:child_process');", "await import('pino');"].join(
          '\n',
        ),
        [CHILD_PROCESS_MESSAGE, PINO_MESSAGE],
        MIXED_OPTIONS,
      ),
    ],
  },
);

// A19: o esquema recusa uma chave desconhecida (additionalProperties: false). O RuleTester só expõe a recusa como
// exceção dentro do `it` de um caso; por isso este teste roda um RuleTester à parte com um `describe` e um `it`
// que apenas coletam as exceções, e põe os do vitest de volta no fim.
function schemaErrors(
  options: NonNullable<RuleTester.ValidTestCase['options']>,
): unknown[] {
  const collected: unknown[] = [];
  const { describe: savedDescribe, it: savedIt } = RuleTester;
  RuleTester.describe = (_name, body) => {
    body();
  };
  RuleTester.it = (_name, body) => {
    try {
      body();
    } catch (error) {
      collected.push(error);
    }
  };
  try {
    new RuleTester({
      languageOptions: { parserOptions: { lang: 'ts' }, sourceType: 'module' },
    }).run(
      'no-restricted-dynamic-import com opções',
      plugin.rules['no-restricted-dynamic-import'],
      { valid: [{ code: "await import('pinot');", options }], invalid: [] },
    );
  } finally {
    RuleTester.describe = savedDescribe;
    RuleTester.it = savedIt;
  }
  return collected;
}

describe('OBS-07 o esquema das opções da regra', () => {
  it('OBS-07 controle: as opções paths e patterns, com as chaves conhecidas, passam pelo esquema', () => {
    expect(schemaErrors(MIXED_OPTIONS)).toEqual([]);
  });

  it.each([
    ['no objeto de opções', [{ patterns: [], extra: true }]],
    [
      'numa entrada de patterns',
      [
        {
          patterns: [{ regex: '^pino$', message: PINO_MESSAGE, extra: true }],
        },
      ],
    ],
    [
      'numa entrada de paths',
      [{ paths: [{ name: 'x', message: 'm', extra: true }] }],
    ],
  ])('OBS-07 o esquema recusa uma chave desconhecida %s', (_where, options) => {
    const messages = schemaErrors(options).map((error) => String(error));

    expect(messages.length).toBeGreaterThan(0);
    // A recusa é pela chave de mais, e não por outro defeito das opções.
    expect(messages.some((message) => message.includes('"extra"'))).toBe(true);
    expect(
      messages.some((message) =>
        message.includes('Unexpected property "patterns"'),
      ),
    ).toBe(false);
  });
});
