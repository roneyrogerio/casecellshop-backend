import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, writeFileIn } from '../helpers/git-sandbox.ts';
import {
  newLintTree,
  oxlintBin,
  typecheckSample,
} from '../helpers/lint-tree.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-19: a conferência do Kysely é parte do `npm run lint`. Aqui o oxlint roda com o .oxlintrc.json do projeto
// sobre uma árvore temporária que tem uma pasta src/, com cwd nela. Os `files` dos overrides (src/**) casam pelo
// caminho relativo à pasta do arquivo de configuração, e não ao cwd: com `-c` apontando para a raiz do repositório,
// um arquivo da árvore temporária nunca cai nas regras de src/ (verificado). Por isso a árvore leva um link para o
// próprio .oxlintrc.json do projeto e outro para scripts/ (o jsPlugins resolve o plugin a partir da configuração):
// é a mesma configuração, sem cópia, e nada é escrito dentro do repositório. A árvore fica na pasta temporária do
// sistema. Os casos de cada regra, um a um, estão em scripts/lint-rules/kysely.test.ts.
interface Diagnostic {
  code: string;
  filename: string;
  message: string;
}

// Só as regras do Kysely contam: o resto do lint pode reclamar da amostra por outro motivo.
const KYSELY_RULE = /kysely|no-restricted-properties/;

afterAll(cleanupTempDirs);

function newTree(): string {
  return newLintTree('ai19-lint-');
}

function lintJson(cwd: string, paths: string[]): Diagnostic[] {
  const result = runCommand(
    oxlintBin,
    ['-c', join(cwd, '.oxlintrc.json'), '-f', 'json', ...paths],
    { cwd },
  );
  const parsed = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  return parsed.diagnostics;
}

function kyselyCodesOf(diagnostics: Diagnostic[], file: string): string[] {
  return diagnostics
    .filter((d) => d.filename === file && KYSELY_RULE.test(d.code))
    .map((d) => d.code);
}

// As formas que o no-restricted-properties nativo reprova, uma por linha: cada uma com o que a amostra declara
// (o oxlint com tipos não deixa nome solto), e o corpo que o verificador antigo reprovava.
const NATIVE: [string, string][] = [
  [
    'sql.raw',
    "declare const sql: { raw: (t: string) => unknown };\nexport const q = sql.raw('on_hand');\n",
  ],
  [
    'sql.lit',
    'declare const sql: { lit: (v: number) => unknown };\nexport const q = sql.lit(1);\n',
  ],
  [
    'sql.ref',
    "declare const sql: { ref: (t: string) => unknown };\nexport const q = sql.ref('inventory.on_hand');\n",
  ],
  [
    'sql.id',
    "declare const sql: { id: (t: string) => unknown };\nexport const q = sql.id('inventory');\n",
  ],
  [
    'sql.table',
    "declare const sql: { table: (t: string) => unknown };\nexport const q = sql.table('inventory');\n",
  ],
  [
    'db.dynamic',
    'declare const db: { dynamic: { ref: (c: string) => unknown } };\nexport const q = db.dynamic.ref(column);\ndeclare const column: string;\n',
  ],
  [
    '.dynamic de outro receptor',
    "export class Repo {\n  readonly connection = { dynamic: { ref: (c: string): unknown => c } };\n  ref(): unknown {\n    return this.connection.dynamic.ref('a');\n  }\n}\n",
  ],
  [
    'CompiledQuery.raw',
    "declare const CompiledQuery: { raw: (t: string) => unknown };\nexport const q = CompiledQuery.raw('select 1');\n",
  ],
  [
    'executeQuery',
    'declare const db: { executeQuery: (q: unknown) => unknown };\ndeclare const compiled: unknown;\nexport const r = db.executeQuery(compiled);\n',
  ],
  [
    'getExecutor',
    'declare const db: { getExecutor: () => unknown };\nexport const e = db.getExecutor();\n',
  ],
  // A11 do #21: o executeQuery desestruturado, sozinho e com o CompiledQuery.raw dentro (a forma do critério).
  [
    'executeQuery desestruturado',
    'declare const db: { executeQuery: (q: unknown) => unknown };\ndeclare const compiled: unknown;\nconst { executeQuery } = db;\nexport const r = executeQuery(compiled);\n',
  ],
  [
    'executeQuery desestruturado com CompiledQuery.raw',
    "declare const db: { executeQuery: (q: unknown) => unknown };\ndeclare const CompiledQuery: { raw: (t: string) => unknown };\nconst { executeQuery } = db;\nexport const r = executeQuery(CompiledQuery.raw('select 1'));\n",
  ],
  [
    'executeQuery desestruturado com outro nome',
    'declare const db: { executeQuery: (q: unknown) => unknown };\ndeclare const compiled: unknown;\nconst { executeQuery: run } = db;\nexport const r = run(compiled);\n',
  ],
];

// Revisão 2 do #21: o encadeamento opcional também reprova. Basta uma regra do Kysely acusar o arquivo (o
// no-restricted-properties ou a regra local), então o teste não fixa qual.
const OPTIONAL_CHAIN: [string, string][] = [
  [
    'sql?.raw',
    "declare const sql: { raw: (t: string) => unknown } | undefined;\nexport const q = sql?.raw('x');\n",
  ],
  [
    'sql?.lit',
    'declare const sql: { lit: (v: number) => unknown } | undefined;\nexport const q = sql?.lit(1);\n',
  ],
  [
    'sql?.table',
    "declare const sql: { table: (t: string) => unknown } | undefined;\nexport const q = sql?.table('inventory');\n",
  ],
  [
    'db?.dynamic',
    'declare const db: { dynamic: { ref: (c: string) => unknown } } | undefined;\nexport const q = db?.dynamic.ref("a");\n',
  ],
  [
    'db?.getExecutor',
    'declare const db: { getExecutor: () => unknown } | undefined;\nexport const e = db?.getExecutor();\n',
  ],
];

// As formas da regra local: o corpo, o nome da regra que acusa.
const PLUGIN: [string, string, string][] = [
  [
    'set com callback',
    'declare const q: { set: (v: unknown) => unknown };\nexport const r = q.set((eb: unknown) => ({ reserved: eb }));\n',
    'no-callback-values',
  ],
  [
    'values com callback',
    'declare const q: { values: (v: unknown) => unknown };\nexport const r = q.values(() => ({ sku: 1 }));\n',
    'no-callback-values',
  ],
  [
    'sql com uma coluna dos tipos gerados',
    'declare const sql: (t: TemplateStringsArray) => unknown;\nexport const q = sql`on_hand - reserved`;\n',
    'no-sql-column',
  ],
  [
    'sql que é um comando inteiro',
    'declare const sql: (t: TemplateStringsArray) => unknown;\nexport const q = sql`SELECT 1`;\n',
    'no-sql-command',
  ],
  [
    'sql guardado em outra variável',
    'declare const sql: (t: TemplateStringsArray) => unknown;\nexport const s = sql;\n',
    'no-sql-alias',
  ],
  [
    'sql importado com outro nome',
    "import { sql as s } from 'kysely';\nexport const q = s`now()`;\n",
    'no-sql-alias',
  ],
  // A13 e A14 do #21: as formas novas da no-sql-alias chegam à regra pelo .oxlintrc.json do projeto.
  [
    'sql guardado por bind',
    "import { sql } from 'kysely';\nexport const b = sql.bind(null);\n",
    'no-sql-alias',
  ],
  [
    'sql chamado por call',
    "import { sql } from 'kysely';\nexport const c = sql.call(null, ['x']);\n",
    'no-sql-alias',
  ],
  [
    'sql chamado por apply',
    "import { sql } from 'kysely';\nexport const a = sql.apply(null, [['x']]);\n",
    'no-sql-alias',
  ],
  [
    'sql importado com outro nome de um módulo nosso',
    "import { sql as q } from './outro-modulo.ts';\nexport { q };\n",
    'no-sql-alias',
  ],
  ['reexport em bloco do kysely', "export * from 'kysely';\n", 'no-sql-alias'],
  [
    'sql lido do namespace do import dinâmico',
    "const k = await import('kysely');\nexport const q = k.sql`now()`;\n",
    'no-sql-alias',
  ],
  // A6 e A7 do #27: todo import('kysely') reprova, mesmo lendo outro nome do namespace, e o namespace do
  // import * só passa como objeto de membro não computado ou em posição de tipo; as duas chegam pelo .oxlintrc.json.
  [
    'import dinâmico do kysely que só lê outro nome do namespace (k.Kysely)',
    "const k = await import('kysely');\nexport const c = k.Kysely;\n",
    'no-sql-alias',
  ],
  [
    'import dinâmico do kysely com then',
    "export const p = import('kysely').then((k) => k.sql);\n",
    'no-sql-alias',
  ],
  [
    'import dinâmico do kysely com o sql desestruturado com o mesmo nome',
    "const { sql } = await import('kysely');\nexport const q = sql`now()`;\n",
    'no-sql-alias',
  ],
  [
    'namespace do import * guardado em outra variável',
    "import * as k from 'kysely';\nexport const k2 = k;\n",
    'no-sql-alias',
  ],
  [
    'namespace do import * passado como argumento',
    "import * as k from 'kysely';\ndeclare function f(x: unknown): void;\nf(k);\n",
    'no-sql-alias',
  ],
];

const QUERY_BODY =
  "declare const pool: { query: (t: string) => unknown };\nexport const r = pool.query('select 1');\n";
const TRANSACTION_BODY =
  'declare const db: { transaction: () => unknown; startTransaction: () => unknown };\nexport const a = db.transaction();\nexport const b = db.startTransaction();\n';

// Formas que passam em qualquer pasta de src/ (e fora dela).
const CLEAN_BODY = [
  'declare const sql: (t: TemplateStringsArray) => unknown;',
  'declare const q: { set: (v: unknown) => unknown; values: (v: unknown) => unknown };',
  'declare const eb: { ref: (c: string) => unknown };',
  'declare const req: { query: { sku: string } };',
  'export const a = q.set({ reserved: 1 });',
  "export const b = q.values([{ sku: 'a' }]);",
  "export const c = eb.ref('reserved');",
  'export const d = sql`now()`;',
  'export const e = sql`make_interval(secs => ${5})`;',
  'export const f = String.raw`on_hand`;',
  'export const sku = req.query.sku;',
  'declare const builder: { execute: () => unknown; executeTakeFirst: () => unknown };',
  'export const g = builder.execute();',
  'export const h = builder.executeTakeFirst();',
  'declare const file: string;',
  'export const dynamicImport = await import(file);',
  "// sql.raw('x') e db.dynamic ficam proibidos, mas citados em comentário não contam",
  '',
].join('\n');

// O sql.raw e a coluna, que reprovam em src/, passam fora dele e nos testes.
const FORBIDDEN_BODY =
  "declare const sql: { raw: (t: string) => unknown };\nexport const q = sql.raw('on_hand');\n";
const COLUMN_BODY =
  'declare const sql: (t: TemplateStringsArray) => unknown;\nexport const q = sql`on_hand > 0`;\n';

const REJECTED: [string, string, string][] = [
  ...['src/checkout', 'src/db'].flatMap((dir) => [
    ...NATIVE.map(([label, body], i): [string, string, string] => [
      `${label} em ${dir}`,
      `${dir}/native-${i}.ts`,
      body,
    ]),
    ...PLUGIN.map(([label, body], i): [string, string, string] => [
      `${label} em ${dir}`,
      `${dir}/plugin-${i}.ts`,
      body,
    ]),
    ...OPTIONAL_CHAIN.map(([label, body], i): [string, string, string] => [
      `${label} em ${dir}`,
      `${dir}/chain-${i}.ts`,
      body,
    ]),
  ]),
  // .query(), .transaction() e .startTransaction() fora de src/db/ (também nas pastas que só começam com db).
  ...['src/checkout', 'src/health', 'src/dbx', 'src/database'].flatMap(
    (dir): [string, string, string][] => [
      [`.query( do pg em ${dir}`, `${dir}/query.ts`, QUERY_BODY],
      [
        `.transaction( e startTransaction( em ${dir}`,
        `${dir}/transaction.ts`,
        TRANSACTION_BODY,
      ],
    ],
  ),
];

const ACCEPTED: [string, string, string][] = [
  ['as formas permitidas em src/checkout', 'src/checkout/ok.ts', CLEAN_BODY],
  ['as formas permitidas em src/db', 'src/db/ok.ts', CLEAN_BODY],
  // Controle do A13 e do A14 do #21: o sql como tag, o import normal e o namespace sem o sql passam.
  [
    'o sql importado do kysely, como tag e como membro do Kysely, em src/checkout',
    'src/checkout/sql-ok.ts',
    "import { Kysely, sql } from 'kysely';\nexport const a = sql`now()`;\nexport const b = sql.join([a, a]);\nexport const c = new Kysely<never>({} as never);\n",
  ],
  [
    'o namespace do import * lido como membro não computado e em posição de tipo, em src/checkout',
    'src/checkout/namespace-ok.ts',
    "import * as k from 'kysely';\nexport const c = k.Kysely;\nexport type T = k.Kysely<never>;\nexport type U = typeof k;\n",
  ],
  ['.query( do pg em src/db/', 'src/db/pool.ts', QUERY_BODY],
  ['.query( do pg em src/db/sub/', 'src/db/sub/pool.ts', QUERY_BODY],
  ['.transaction( em src/db/', 'src/db/transaction.ts', TRANSACTION_BODY],
  [
    '.transaction( em src/db/sub/',
    'src/db/sub/transaction.ts',
    TRANSACTION_BODY,
  ],
  [
    'req.query (propriedade, sem chamada) em src/checkout',
    'src/checkout/req.ts',
    'declare const req: { query: { sku: string } };\nexport const sku = req.query.sku;\n',
  ],
  [
    'req.query (propriedade, sem chamada) em src/db',
    'src/db/req.ts',
    'declare const req: { query: { sku: string } };\nexport const sku = req.query.sku;\n',
  ],
  [
    'sql.raw num *.test.ts de src/',
    'src/checkout/ruim.test.ts',
    FORBIDDEN_BODY,
  ],
  [
    'uma coluna no sql num *.test.ts de src/',
    'src/checkout/coluna.test.ts',
    COLUMN_BODY,
  ],
  [
    '.query( do pg num *.test.ts de src/',
    'src/checkout/query.test.ts',
    QUERY_BODY,
  ],
  [
    'a coluna no sql nos tipos gerados (src/db/types/)',
    'src/db/types/gerado.ts',
    COLUMN_BODY,
  ],
  [
    'sql.raw e a coluna numa migração, fora de src/',
    'migrations/store/20240101000000_checagem.ts',
    "declare const sql: { raw: (t: string) => unknown } & ((t: TemplateStringsArray) => unknown);\nexport const a = sql.raw('on_hand');\nexport const b = sql`on_hand > 0`;\n",
  ],
];

describe('AI-19 o oxlint com o .oxlintrc.json do projeto aplica as formas do Kysely em src/', () => {
  let tree: string;
  let diagnostics: Diagnostic[];

  beforeAll(() => {
    tree = newTree();
    for (const [, file, body] of [...REJECTED, ...ACCEPTED])
      writeFileIn(tree, file, body);
    diagnostics = lintJson(tree, ['src', 'migrations']);
  }, 180_000);

  // Controle: o que passa só vale se a conferência está carregada e acusa a árvore.
  function expectLoaded(): void {
    expect(
      diagnostics.some((d) => KYSELY_RULE.test(d.code)),
      'as regras do Kysely estão carregadas e acusam a árvore',
    ).toBe(true);
  }

  it.each(REJECTED.filter(([, file]) => /native-\d+\.ts$/.test(file)))(
    'AI-19 reprova %s (proibição de propriedade)',
    (_label, file) => {
      expect(kyselyCodesOf(diagnostics, file).join(' ')).toContain(
        'no-restricted-properties',
      );
    },
  );

  it.each(
    REJECTED.filter(([, file]) => /chain-\d+\.ts$/.test(file)).map(
      ([label, file]) => [label, file] as const,
    ),
  )(
    'AI-19 reprova %s (encadeamento opcional, por qualquer regra do Kysely)',
    (_label, file) => {
      expect(kyselyCodesOf(diagnostics, file)).not.toEqual([]);
    },
  );

  it('AI-19 reprova .set((eb) => …) em src/ pela regra no-callback-values', () => {
    expect(
      kyselyCodesOf(diagnostics, 'src/checkout/plugin-0.ts').join(' '),
    ).toContain('no-callback-values');
  });

  it.each(
    PLUGIN.flatMap(([label, , rule], i) =>
      ['src/checkout', 'src/db'].map((dir): [string, string, string] => [
        `${label} em ${dir}`,
        rule,
        `${dir}/plugin-${i}.ts`,
      ]),
    ),
  )('AI-19 reprova %s com a regra local %s', (_label, rule, file) => {
    expect(kyselyCodesOf(diagnostics, file).join(' ')).toContain(rule);
  });

  it.each(
    ['src/checkout', 'src/health', 'src/dbx', 'src/database'].map((dir) => [
      dir,
    ]),
  )(
    'AI-19 reprova pool.query() e db.transaction() fora de src/db/ (%s) pela regra no-direct-query',
    (dir) => {
      expect(kyselyCodesOf(diagnostics, `${dir}/query.ts`).join(' ')).toContain(
        'no-direct-query',
      );
      expect(
        kyselyCodesOf(diagnostics, `${dir}/transaction.ts`).join(' '),
      ).toContain('no-direct-query');
    },
  );

  it.each(ACCEPTED)('AI-19 aceita %s', (_label, file) => {
    expectLoaded();
    expect(kyselyCodesOf(diagnostics, file)).toEqual([]);
  });

  it('AI-19 as colunas vêm dos tipos gerados de src/db/types/: on_hand reprova e now() passa', () => {
    expect(
      kyselyCodesOf(diagnostics, 'src/checkout/plugin-2.ts').join(' '),
    ).toContain('no-sql-column');
    expect(kyselyCodesOf(diagnostics, 'src/checkout/ok.ts')).toEqual([]);
    expectLoaded();
  });
});

// O critério deixa para o typecheck as formas do TypeScript que não são apagáveis (erasableSyntaxOnly): a regra
// local não precisa vê-las.
describe('AI-19 as formas não apagáveis do sql reprovam no typecheck pelo erasableSyntaxOnly', () => {
  it.each([
    ['export = sql', "import { sql } from 'kysely';\nexport = sql;\n"],
    [
      'import s = sql',
      "import { sql } from 'kysely';\nimport s = sql;\nexport const q = s`now()`;\n",
    ],
  ])(
    'AI-19 %s reprova no tsc do projeto',
    (_label, source) => {
      const result = typecheckSample('ai19-tsc-', source);

      expect(result.status).not.toBe(0);
      expect(result.status).not.toBeNull();
      expect(result.output).toContain('erasableSyntaxOnly');
    },
    60_000,
  );

  it('AI-19 o mesmo arquivo com o import normal e o sql como tag passa no tsc', () => {
    const result = typecheckSample(
      'ai19-tsc-',
      "import { sql } from 'kysely';\nexport const q = sql`now()`;\n",
    );

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});

describe('AI-19 o oxlint como processo: saída e código de saída', () => {
  function lintText(files: Record<string, string>): {
    status: number | null;
    out: string;
  } {
    const dir = newTree();
    for (const [file, body] of Object.entries(files))
      writeFileIn(dir, file, body);
    const result = runCommand(
      oxlintBin,
      ['-c', join(dir, '.oxlintrc.json'), 'src'],
      { cwd: dir },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it('AI-19 uma árvore com uma forma proibida em src/ sai com código diferente de 0 e cita o arquivo na saída', () => {
    const { status, out } = lintText({
      'src/checkout/ruim.ts': FORBIDDEN_BODY,
    });

    expect(status).not.toBe(0);
    expect(out).toContain('src/checkout/ruim.ts');
  });

  it('AI-19 a mesma árvore sem a forma proibida sai com 0', () => {
    const { status, out } = lintText({
      'src/checkout/bom.ts':
        'declare const sql: (t: TemplateStringsArray) => unknown;\nexport const q = sql`now()`;\n',
    });

    expect({ status, out: out.includes('bom.ts') }).toEqual({
      status: 0,
      out: false,
    });
  });

  it('AI-19 uma forma proibida num *.test.ts de src/ não reprova o lint', () => {
    const { status } = lintText({
      'src/checkout/ruim.test.ts': FORBIDDEN_BODY,
    });

    expect(status).toBe(0);
  });
});

describe('AI-19 o código atual de src/ não tem violação do Kysely', () => {
  it('AI-19 o oxlint com a configuração do projeto sobre src/ não acusa nenhuma regra do Kysely', () => {
    const tree = newTree();
    writeFileIn(tree, 'src/checkout/ruim.ts', FORBIDDEN_BODY);
    const control = lintJson(tree, ['src']);
    expect(
      control.some((d) => KYSELY_RULE.test(d.code)),
      'as regras do Kysely estão carregadas e acusam a árvore de controle',
    ).toBe(true);

    const real = lintJson(root, ['src']);

    expect(
      real
        .filter((d) => KYSELY_RULE.test(d.code))
        .map((d) => `${d.filename}: ${d.code}`),
    ).toEqual([]);
  }, 180_000);
});
