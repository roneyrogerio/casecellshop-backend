import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
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
