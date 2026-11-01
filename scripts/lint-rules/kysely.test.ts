import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuleTester } from 'oxlint/plugins-dev';
import { afterEach, describe, expect, it } from 'vitest';
import plugin, { readGeneratedColumns } from './kysely.ts';

// AI-19: as regras de lint do Kysely, testadas com o RuleTester do oxlint. O nome de cada caso começa pelo ID do
// critério (AI-38 e AI-18): o RuleTester monta o nome sozinho a partir do código, então todo caso leva `name`.
// A parte nativa (sql.raw, sql.lit, sql.ref, sql.id, sql.table, CompiledQuery.raw, .dynamic, .executeQuery e
// .getExecutor, pelo no-restricted-properties) e a escolha de pastas (src/ sim, src/db/ e testes não) ficam em
// test/repo/kysely-lint.test.ts, que roda o oxlint com o .oxlintrc.json do projeto.
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { sourceType: 'module', parserOptions: { lang: 'ts' } },
});

type Valid = RuleTester.ValidTestCase;
type Invalid = RuleTester.InvalidTestCase;

const ok = (
  label: string,
  code: string,
  extra: Partial<Valid> = {},
): Valid => ({
  name: `AI-19 passa ${label}`,
  code,
  ...extra,
});

const bad = (
  label: string,
  code: string,
  errors: Invalid['errors'] = 1,
  extra: Partial<Invalid> = {},
): Invalid => ({
  name: `AI-19 reprova ${label}`,
  code,
  errors,
  ...extra,
});

// Um literal de expressão regular que o leitor léxico antigo lia como string, comentário ou template, e que
// engolia o código seguinte (A5 do #12, A11). Cada prefixo vem antes de um trecho que a regra deve acusar (a
// regra enxerga o código depois do regex) e de um que ela deve aceitar (não acusa nem inventa).
const REGEX_PREFIXES: [string, string][] = [
  ['uma aspa simples no regex', "v.replace(/'/g, '');"],
  ['barras escapadas no regex', '/^https?:\\/\\//.test(u);'],
  ['uma crase no regex', 'const re = /`/;'],
  ['um regex logo depois de ")"', "if (ok) /'/.test(v);"],
  ['um regex logo depois de ")" de um while', "while (more) /'/.test(v);"],
  [
    'um regex logo depois de "}" de uma função',
    'function f() {}\n/`/.test(v);',
  ],
  ['um regex logo depois de "}" de um bloco', "{}\n/'/.test(v);"],
  ['uma divisão entre variáveis', 'const x = a / b / c;'],
  ['uma divisão depois de parênteses', 'const x = (a + b) / 2 / c;'],
  ['uma divisão depois de um índice', 'const x = items[0] / 2 / c;'],
  ['uma divisão depois de um número', 'const x = 10 / 2 / 5;'],
];

function afterRegexCases(
  badTail: string,
  goodTail: string,
): { valid: Valid[]; invalid: Invalid[] } {
  return {
    valid: REGEX_PREFIXES.map(([label, prefix]) =>
      ok(`${label}, sem violação depois dele`, `${prefix}\n${goodTail}`),
    ),
    invalid: REGEX_PREFIXES.map(([label, prefix]) =>
      bad(`a violação que vem depois de ${label}`, `${prefix}\n${badTail}`),
    ),
  };
}

const UPDATE_CB = "db.updateTable('t').set((eb) => ({ a: 1 }));";
const UPDATE_OBJ = "db.updateTable('t').set({ a: 1 });";
const regexAfterCallback = afterRegexCases(UPDATE_CB, UPDATE_OBJ);

// set, values e doUpdateSet com callback (inline, na linha seguinte ou guardada num nome do arquivo)
tester.run('no-callback-values', plugin.rules['no-callback-values'], {
  valid: [
    ok(
      'set com objeto',
      "db.updateTable('inventory').set({ reserved: 1 }).execute();",
    ),
    ok(
      'set com objeto e callback por coluna',
      "db.updateTable('inventory').set({ reserved: (eb) => eb('reserved', '+', q) }).execute();",
    ),
    ok(
      'set com uma variável',
      "db.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'values com objeto',
      "db.insertInto('products').values({ sku: 'a' }).execute();",
    ),
    ok(
      'values com lista de objetos',
      "db.insertInto('products').values([{ sku: 'a' }, { sku: 'b' }]).execute();",
    ),
    ok(
      'doUpdateSet com objeto, dentro de uma callback do onConflict',
      "db.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet({ reserved: (eb) => eb.ref('excluded.reserved') })).execute();",
    ),
    ok(
      'uma callback em outro método com nome parecido (reset, offset)',
      'reset(() => 1); offset((x) => x);',
    ),
    ok(
      'Object.values e values() de um Map, que não são do Kysely',
      'Object.values(obj).map((v) => v); map.values();',
    ),
    ok(
      'a forma proibida citada em comentário',
      "// não use set((eb) => ({ reserved: 1 })) nem sql.raw('x')\nconst a = 1;",
    ),
    ok(
      'set com um objeto guardado em const',
      "const patch = { reserved: 1 };\ndb.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'set com um objeto que tem uma callback por coluna',
      "const patch = { reserved: (eb) => eb('reserved', '+', q) };\ndb.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'set com o resultado de uma chamada que recebe uma arrow',
      "const patch = makePatch((x) => x);\ndb.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'set com um identificador que não é declarado no arquivo (importado)',
      "import { patch } from './patch.ts';\ndb.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'set com um identificador cujo nome só aparece dentro do nome de uma função',
      "const cbExtra = (eb) => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    ok(
      'set com um objeto, enquanto outra função do arquivo tem outro nome',
      "const build = (eb) => ({ reserved: 1 });\nconst patch = { reserved: 2 };\ndb.updateTable('inventory').set(patch).execute();",
    ),
    ok(
      'values com uma lista guardada em const',
      "const rows = [{ sku: 'a' }];\ndb.insertInto('products').values(rows).execute();",
    ),
    ok(
      'doUpdateSet com um objeto guardado em const',
      "const patch = { reserved: 1 };\ndb.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet(patch)).execute();",
    ),
    ok(
      'uma função declarada no arquivo que não vai a set, values nem doUpdateSet',
      "const cb = (eb) => ({ reserved: 1 });\nconst out = cb(eb);\ndb.updateTable('inventory').set({ reserved: 1 }).execute();",
    ),
    ...regexAfterCallback.valid,
  ],
  invalid: [
    bad(
      'set com arrow e parênteses',
      "db.updateTable('inventory').set((eb) => ({ reserved: eb('reserved', '+', 1) })).execute();",
    ),
    bad(
      'set com arrow sem parênteses',
      "db.updateTable('inventory').set(eb => ({ reserved: eb('reserved', '+', 1) })).execute();",
    ),
    bad(
      'set com arrow sem argumento',
      "db.updateTable('inventory').set(() => ({ reserved: 1 })).execute();",
    ),
    bad(
      'set com function',
      "db.updateTable('inventory').set(function (eb) { return { reserved: 1 }; }).execute();",
    ),
    bad(
      'set com a callback na linha seguinte',
      "db.updateTable('inventory').set(\n  (eb) => ({ reserved: 1 }),\n).execute();",
    ),
    bad(
      'values com arrow sem argumento',
      "db.insertInto('products').values(() => ({ sku: 'a' })).execute();",
    ),
    bad(
      'values com arrow e parâmetro',
      "db.insertInto('products').values((eb) => ({ sku: 'a' })).execute();",
    ),
    bad(
      'doUpdateSet com callback (só ele, e não o onConflict que o envolve)',
      "db.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet((eb) => ({ reserved: eb.ref('excluded.reserved') }))).execute();",
    ),
    bad(
      'set com arrow guardada em const',
      "const cb = (eb) => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com arrow sem parênteses guardada em const',
      "const cb = eb => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com arrow async guardada em const',
      "const cb = async (eb) => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com function expression guardada em const',
      "const cb = function (eb) { return { reserved: 1 }; };\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com function declarada',
      "function cb(eb) { return { reserved: 1 }; }\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com function declarada depois do uso',
      "db.updateTable('inventory').set(cb).execute();\nfunction cb(eb) { return { reserved: 1 }; }",
    ),
    bad(
      'set com arrow exportada',
      "export const cb = (eb) => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com arrow guardada em let',
      "let cb = (eb) => ({ reserved: 1 });\ndb.updateTable('inventory').set(cb).execute();",
    ),
    bad(
      'set com a declaração na mesma linha',
      "const cb = (eb) => ({ reserved: 1 }); db.updateTable('inventory').set(cb);",
    ),
    bad(
      'values com arrow guardada em const',
      "const cb = (eb) => ({ sku: 'a' });\ndb.insertInto('products').values(cb).execute();",
    ),
    bad(
      'doUpdateSet com arrow guardada em const',
      "const cb = (eb) => ({ reserved: eb.ref('excluded.reserved') });\ndb.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet(cb)).execute();",
    ),
    // A violação é uma frase com o número da linha do arquivo.
    bad(
      'set com callback na terceira linha, citando a linha 3',
      "const a = 1;\nconst b = 2;\ndb.updateTable('inventory').set((eb) => ({ reserved: 1 }));",
      [{ message: /.+/, line: 3 }],
    ),
    ...regexAfterCallback.invalid,
  ],
});

// O sql com outro nome escaparia das outras regras, que procuram a palavra sql
const regexAfterAlias = afterRegexCases(
  'const s = sql;',
  'const q = sql`now()`;',
);

const SQL_IMPORT = "import { sql } from 'kysely';\n";

// Regressão do A1 do #21: formas em que o sql do import vira valor (e não tag nem membro) e que a lista de
// pais permitidos reprova, com um erro cada.
const aliasEscapes: [string, string][] = [
  ['o sql como corpo de uma seta', 'const f = () => sql;'],
  ['o sql como superclasse (extends sql)', 'class X extends sql {}'],
  [
    'o sql sob asserção de tipo, que escaparia do no-restricted-properties',
    '(sql as any).raw(1);',
  ],
  ['o sql em propriedade abreviada, com um só erro', 'const o = { sql };'],
  ['o sql dentro de um spread de argumento', 'f(...[sql]);'],
  ['o sql como valor padrão de desestruturação', 'const { s = sql } = k;'],
  ['o sql num operador lógico', 'const s = a || sql;'],
  ['o sql chamado como função, sem tag', "sql(['x']);"],
  // A13 do #21: bind, call e apply devolvem ou executam o sql sem passar por um nome que a regra veja
  ['o sql guardado por bind (sql.bind)', 'const b = sql.bind(null);'],
  ['o sql chamado por call (sql.call)', "sql.call(null, ['x']);"],
  ['o sql chamado por apply (sql.apply)', "sql.apply(null, [['x']]);"],
  [
    'o bind com encadeamento opcional (sql?.bind)',
    'const b = sql?.bind(null);',
  ],
  ['o bind lido sem chamada (sql.bind)', 'const f = sql.bind;'],
];

// A14 do #21: o sql levado por um módulo nosso que o reexporta, pelo namespace do import dinâmico ou por um
// reexport em bloco. Cada forma é inteira (sem o SQL_IMPORT na frente).
const aliasThroughModules: [string, string][] = [
  [
    'o import de sql com outro nome de qualquer módulo (e não só de kysely)',
    "import { sql as q } from './qualquer-modulo.ts';",
  ],
  [
    'o import de sql com outro nome de um módulo do pacote',
    "import { Kysely, sql as q } from '../db/kysely.ts';",
  ],
  ['o reexport em bloco do kysely (export * from)', "export * from 'kysely';"],
  [
    'o reexport direto de sql com outro nome, de qualquer módulo',
    "export { sql as q } from './qualquer-modulo.ts';",
  ],
  [
    'o sql lido do namespace do import dinâmico guardado (k.sql como tag)',
    "const k = await import('kysely');\nconst q = k.sql`now()`;",
  ],
  [
    'o sql lido do namespace do import dinâmico guardado (k.sql guardado)',
    "const k = await import('kysely');\nconst s = k.sql;",
  ],
  [
    'o sql lido do namespace do import dinâmico guardado (k.sql.raw)',
    "const k = await import('kysely');\nk.sql.raw('x');",
  ],
  [
    'o sql lido direto do import dinâmico ((await import(…)).sql como tag)',
    "const q = (await import('kysely')).sql`now()`;",
  ],
  [
    'o sql lido direto do import dinâmico ((await import(…)).sql guardado)',
    "const s = (await import('kysely')).sql;",
  ],
  [
    'o sql lido por colchete do namespace do import dinâmico',
    "const k = await import('kysely');\nconst s = k['sql'];",
  ],
];

// O que a regra deixa passar: posição de tipo, nome local que não é o import, membro opcional não computado e
// sql como chave escrita por extenso.
const aliasAllowed: [string, string][] = [
  [
    'o sql em posição de tipo (typeof sql)',
    `${SQL_IMPORT}type T = typeof sql;`,
  ],
  [
    'um parâmetro local chamado sql, sem import',
    'function f(sql) { return sql`1`; }',
  ],
  [
    'o sql como objeto de um membro opcional não computado',
    `${SQL_IMPORT}sql?.join(xs);`,
  ],
  ['o sql como nome de método de classe, sem import', 'class A { sql() {} }'],
  [
    'o sql como chave de objeto escrita por extenso, sem import',
    'const o = { sql: 1 };',
  ],
];

tester.run('no-sql-alias', plugin.rules['no-sql-alias'], {
  valid: [
    ok('o import normal de sql', "import { sql } from 'kysely';"),
    ok(
      'o import normal de sql entre outros nomes',
      "import { Kysely, sql, type Selectable } from 'kysely';",
    ),
    ok(
      'o import normal de sql em várias linhas',
      "import {\n  Kysely,\n  sql,\n} from 'kysely';",
    ),
    ok(
      'o apelido de outro nome do kysely',
      "import { Kysely as K, sql } from 'kysely';",
    ),
    ok(
      'o apelido de um nome parecido com sql',
      "import { sqlite as s } from 'kysely';",
    ),
    // A14 do #21 trocou o veredito de 'import { sql as s } from "./outro-modulo.ts"' (passava, agora reprova): ele
    // está em aliasThroughModules, nos inválidos. Os controles abaixo continuam passando.
    ok(
      'o import de sql com o mesmo nome vindo de outro módulo',
      "import { sql } from './outro-modulo.ts';\nconst q = sql`now()`;",
    ),
    ok(
      'o apelido de outro nome vindo de outro módulo',
      "import { Kysely as K } from './outro-modulo.ts';",
    ),
    ok(
      'o reexport em bloco de um módulo que não é o kysely',
      "export * from './outro-modulo.ts';",
    ),
    ok(
      'o reexport de outro nome do kysely',
      "export { Kysely } from 'kysely';\nexport type { Selectable } from 'kysely';",
    ),
    ok(
      'o import dinâmico do kysely lendo outro nome do namespace',
      "const k = await import('kysely');\nexport const db = new k.Kysely({});",
    ),
    ok(
      'o import dinâmico do kysely com o sql desestruturado com o mesmo nome',
      "const { sql } = await import('kysely');\nconst q = sql`now()`;",
    ),
    ok(
      'o sql lido do import dinâmico de outro módulo',
      "const k = await import('./outro-modulo.ts');\nconst q = k.sql;",
    ),
    ok(
      'o bind de outro objeto, com o sql como tag e como membro (A13)',
      "import { sql } from 'kysely';\nconst f = handler.bind(this);\nconst q = sql`now()`;\nconst j = sql.join(xs);",
    ),
    ok(
      'o sql usado como tag, com função e literal',
      "import { sql } from 'kysely';\nconst q = sql`now()`;",
    ),
    ok('o fragmento atribuído a uma variável', 'const s = sql`now()`;'),
    ok(
      'o fragmento com o tipo genérico atribuído a uma variável',
      'const s = sql<number>`1`;',
    ),
    ok('o sql executado', 'await sql`now()`.execute(db);'),
    // Controle do A1 do #21: a referência ao sql só passa como tag ou como objeto de um membro não computado
    ok(
      'o sql usado como tag, com o import',
      "import { sql } from 'kysely';\nconst q = sql`now()`;\nconst n = sql<number>`1`;",
    ),
    ok(
      'o sql como objeto de um membro não computado (sql.join e sql.val)',
      "import { sql } from 'kysely';\nconst a = sql.join(xs);\nconst b = sql.val(1);",
    ),
    ok(
      'uma variável local chamada sql, sem import do kysely, usada como membro',
      'const sql = makeSql();\nsql.val(1);',
    ),
    ok('um nome que só começa com sql', 'const s = sqlText;'),
    ok('um índice de um nome que só termina em sql', 'const first = mysql[0];'),
    ok('uma lista de fragmentos', 'const list = [sql`now()`];'),
    ok('o acesso por colchete a outro objeto', "const v = params['sql'];"),
    ok(
      'um fragmento passado como argumento (e não o sql em si)',
      'f(sql`now()`);',
    ),
    ok('um nome parecido passado como argumento', 'f(sqlText);'),
    ok(
      'o sql desestruturado com o mesmo nome',
      "import * as k from 'kysely';\nconst { sql } = k;",
    ),
    ok(
      'outro nome lido do import de namespace',
      "import * as k from 'kysely';\nexport const db = new k.Kysely({});",
    ),
    ok(
      'um sql lido de um namespace que não é o do kysely',
      "import * as k from './outro-modulo.ts';\nconst q = k.sql;",
    ),
    ok(
      'a forma proibida citada em comentário e em texto',
      "// const s = sql; import { sql as s } from 'kysely';\nconst t = 'const s = sql;';",
    ),
    ...aliasAllowed.map(([label, code]) => ok(label, code)),
    ...regexAfterAlias.valid,
  ],
  invalid: [
    bad('o import de sql com outro nome', "import { sql as s } from 'kysely';"),
    bad(
      'o import de sql com outro nome entre outros nomes',
      "import { Kysely, sql as s, type Selectable } from 'kysely';",
    ),
    bad(
      'o import de sql com outro nome em várias linhas',
      "import {\n  Kysely,\n  sql as s,\n} from 'kysely';",
    ),
    bad('a atribuição de sql a outra variável', 'const s = sql;'),
    bad('a atribuição de sql com let', 'let s = sql;'),
    bad('a atribuição de sql sem espaço', 'const s=sql;'),
    bad('o acesso por colchete a um método', "const q = sql['raw']('x');"),
    bad('o acesso por colchete com uma variável', 'const q = sql[method](x);'),
    bad(
      'o sql renomeado no import, mesmo quando só é usado como tag com a coluna escondida atrás do apelido',
      "import { sql as s } from 'kysely';\nconst q = s`on_hand - reserved`;",
    ),
    // As brechas do A5 do #12, que o verificador antigo deixava passar.
    bad(
      'o sql desestruturado com outro nome de um import de namespace (const { sql: s } = k)',
      "import * as k from 'kysely';\nconst { sql: s } = k;",
    ),
    bad(
      'o sql desestruturado com outro nome de um import dinâmico',
      "const { sql: s } = await import('kysely');",
    ),
    bad(
      "o sql lido por colchete de um import de namespace (k['sql'])",
      "import * as k from 'kysely';\nconst s = k['sql'];",
    ),
    bad('o sql passado como argumento (f(sql))', 'f(sql);'),
    bad('o sql passado como argumento, entre outros', "register('x', sql, 3);"),
    bad(
      'o sql lido de um import de namespace, usado como tag (k.sql`…`)',
      "import * as k from 'kysely';\nconst q = k.sql`now()`;",
    ),
    // A1 do #21: o sql guardado ou levado adiante por qualquer pai que não seja tag, membro não computado ou import
    bad(
      'o sql atribuído depois da declaração (s = sql)',
      "import { sql } from 'kysely';\nlet s;\ns = sql;\ns.raw(1);",
    ),
    bad(
      'o sql como valor padrão de parâmetro de seta',
      "import { sql } from 'kysely';\nconst f = (s = sql) => s.raw(1);",
    ),
    bad(
      'o sql como valor padrão de parâmetro de função',
      "import { sql } from 'kysely';\nfunction f(s = sql) {}",
    ),
    bad(
      'o sql como valor de propriedade de objeto',
      "import { sql } from 'kysely';\nconst o = { s: sql };",
    ),
    bad(
      'o sql como elemento de array',
      "import { sql } from 'kysely';\nconst a = [sql];",
    ),
    bad(
      'o sql devolvido por uma função',
      "import { sql } from 'kysely';\nfunction f() {\n  return sql;\n}",
    ),
    bad(
      'o sql num ramo de condicional',
      "import { sql } from 'kysely';\nconst s = cond ? sql : null;",
    ),
    bad(
      'a reexportação do sql importado com outro nome',
      "import { sql } from 'kysely';\nexport { sql as q };",
    ),
    bad(
      'a reexportação do sql importado com o mesmo nome',
      "import { sql } from 'kysely';\nexport { sql };",
    ),
    bad(
      'a reexportação direta do sql do kysely com outro nome',
      "export { sql as q } from 'kysely';",
    ),
    bad(
      'a reexportação direta do sql do kysely com o mesmo nome',
      "export { sql } from 'kysely';",
    ),
    ...aliasEscapes.map(([label, code]) => bad(label, `${SQL_IMPORT}${code}`)),
    ...aliasThroughModules.map(([label, code]) => bad(label, code)),
    ...regexAfterAlias.invalid,
  ],
});

// Um fragmento sql`…` cujo texto fixo cita uma coluna dos tipos gerados. Sem opção da regra: ela lê as colunas
// reais de src/db/types/ (nenhuma lista injetada), e os nomes abaixo (on_hand, reserved, sku, reference, status)
// são colunas de verdade nesses tipos. O diretório vem do lugar do plugin, e não do cwd do RuleTester.
const regexAfterColumn = afterRegexCases(
  'const q = sql`on_hand`;',
  'const q = sql`now()`;',
);

tester.run('no-sql-column', plugin.rules['no-sql-column'], {
  valid: [
    ok('now()', 'const q = sql`now()`;'),
    ok(
      'make_interval com valor interpolado',
      'const q = sql`make_interval(secs => ${seconds})`;',
    ),
    ok('literal com o tipo genérico', 'const q = sql<number>`1`;'),
    ok('count(*)', 'const q = sql`count(*)`;'),
    ok(
      'função somada a um valor interpolado',
      'const q = sql`now() + ${interval}`;',
    ),
    ok(
      'um valor interpolado que se chama como a coluna',
      'const reserved = 3;\nconst q = sql`now() + ${reserved}`;',
    ),
    ok(
      'um nome que só contém a coluna (overreserved)',
      'const q = sql`overreserved()`;',
    ),
    ok(
      'a coluna num texto comum',
      "const label = 'reserved'; const t = `on_hand ${label}`;",
    ),
    ok('outra tag de template', 'const q = html`on_hand`;'),
    ok('eb.ref com a coluna', "const e = eb.ref('reserved');"),
    ok('eb com a coluna', "const e = eb('reserved', '+', 1);"),
    ok(
      'where com a coluna',
      "db.selectFrom('inventory').where('sku', '=', sku).execute();",
    ),
    ok(
      'a coluna citada em comentário',
      '// sql`on_hand - reserved` não pode\nconst a = 1;',
    ),
    ...regexAfterColumn.valid,
  ],
  invalid: [
    bad(
      'duas colunas e um operador (uma violação por fragmento)',
      'const q = sql`on_hand - reserved`;',
    ),
    bad(
      'uma coluna, com o tipo genérico',
      'const q = sql<number>`reserved + 1`;',
    ),
    bad('uma coluna entre aspas', 'const q = sql`"on_hand"`;'),
    bad(
      'uma coluna qualificada pela tabela',
      'const q = sql`inventory.on_hand`;',
    ),
    bad('uma coluna numa função', "const q = sql`coalesce(reference, '')`;"),
    bad(
      'uma coluna ao lado de um valor interpolado',
      'const q = sql`${value} + on_hand`;',
    ),
    bad(
      'uma coluna numa segunda linha do fragmento',
      'const q = sql`now()\n  and status`;',
    ),
    bad('um fragmento com uma coluna só', 'const q = sql`reserved + 1`;'),
    bad(
      'a coluna depois de um comentário de várias linhas, citando a linha 4',
      '/*\n * nota\n */\nconst q = sql`on_hand`;',
      [{ message: /.+/, line: 4 }],
    ),
    bad(
      'a coluna depois de um regex com crase, citando a linha 2',
      'const re = /`/;\nconst q = sql`on_hand`;',
      [{ message: /.+/, line: 2 }],
    ),
    bad(
      'dois fragmentos, cada um com a sua violação',
      'const a = sql`on_hand`;\nconst b = sql`reserved`;',
      2,
    ),
    ...regexAfterColumn.invalid,
  ],
});

// Um fragmento sql`…` que é um comando inteiro
const regexAfterCommand = afterRegexCases(
  'const q = sql`SELECT 1`;',
  'const q = sql`now()`;',
);

tester.run('no-sql-command', plugin.rules['no-sql-command'], {
  valid: [
    ok('now()', 'const q = sql`now()`;'),
    ok('selection(), que só começa como select', 'const q = sql`selection()`;'),
    ok('withdraw(), que só começa como with', 'const q = sql`withdraw()`;'),
    ok('deleted(), que só começa como delete', 'const q = sql`deleted()`;'),
    ok('updated_now()', 'const q = sql`updated_now()`;'),
    ok(
      'SELECT num texto comum',
      "const text = 'SELECT 1'; const t = `SELECT 1`;",
    ),
    ok('outra tag de template com SELECT', 'const q = html`SELECT 1`;'),
    ok(
      'um comando citado em comentário',
      '// sql`SELECT 1` não pode\nconst a = 1;',
    ),
    ok(
      'o comando só no meio do texto',
      'const q = sql`now() or select_all()`;',
    ),
    ...regexAfterCommand.valid,
  ],
  invalid: [
    bad('SELECT', 'const q = sql`SELECT 1`;'),
    bad('select em minúsculas', 'const q = sql`select 1`;'),
    bad('Select misturado', 'const q = sql`Select 1`;'),
    bad('INSERT', 'const q = sql`INSERT INTO t VALUES (1)`;'),
    bad('UPDATE com espaço antes', 'const q = sql`   UPDATE t SET a = 1`;'),
    bad('DELETE', 'const q = sql`DELETE FROM t`;'),
    bad(
      'WITH com quebra de linha antes',
      'const q = sql`\n  WITH a AS (SELECT 1) SELECT * FROM a`;',
    ),
    bad(
      'with em minúsculas',
      'const q = sql`with a as (select 1) select * from a`;',
    ),
    bad('SELECT com o tipo genérico', 'const q = sql<number>`SELECT ${x}`;'),
    bad(
      'SELECT na terceira linha, citando a linha 3',
      'const a = 1;\nconst b = 2;\nconst q = sql`SELECT 1`;',
      [{ message: /.+/, line: 3 }],
    ),
    ...regexAfterCommand.invalid,
  ],
});

// .query() do pg, .transaction() e .startTransaction(): a regra acusa a chamada em qualquer arquivo; a pasta
// src/db/ fica de fora pela configuração, e o teste de integração prova isso.
const regexAfterQuery = afterRegexCases(
  "pool.query('select 1');",
  'req.query.sku;',
);

tester.run('no-direct-query', plugin.rules['no-direct-query'], {
  valid: [
    ok('req.query como propriedade, sem chamada', 'const sku = req.query.sku;'),
    ok('req.query desestruturado', 'const { query } = req;'),
    ok(
      'execute() do builder',
      "await db.selectFrom('inventory').selectAll().execute();",
    ),
    ok(
      'um nome que só contém Transaction',
      'await inTransaction(db, async (trx) => { await work(trx); });',
    ),
    ok(
      'runInTransaction',
      'await runInTransaction(db, async (trx) => { await work(trx); });',
    ),
    ok(
      'a chamada citada em comentário',
      "// pool.query('x') e db.transaction() não podem\nconst a = 1;",
    ),
    ...regexAfterQuery.valid,
  ],
  invalid: [
    bad('.query( do pg', "await pool.query('select 1');"),
    bad(
      '.query( encadeado',
      "const r = await this.pool.query('select 1', [1]);",
    ),
    bad(
      '.transaction(',
      'await db.transaction().execute(async (trx) => { await work(trx); });',
    ),
    bad(
      'startTransaction(',
      'const trx = await db.startTransaction().execute();',
    ),
    bad(
      '.query( na terceira linha, citando a linha 3',
      "const a = 1;\nconst b = 2;\nawait pool.query('select 1');",
      [{ message: /.+/, line: 3 }],
    ),
    ...regexAfterQuery.invalid,
  ],
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ai19-'));
  tempDirs.push(dir);
  return dir;
}

describe('AI-19 as colunas vêm dos arquivos de tipos gerados', () => {
  const GENERATED = `/**
 * This file was generated by kysely-codegen.
 * Please do not edit it manually.
 */

import type { ColumnType } from "kysely";

export type Generated<T> = T extends ColumnType<infer S, infer I, infer U>
  ? ColumnType<S, I | undefined, U>
  : ColumnType<T, T | undefined, T>;

export type JsonObject = {
  [x: string]: JsonValue | undefined;
};

export type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface Pedidos {
  criado_em: Generated<Timestamp>;
  nome_cliente: string | null;
  total_cents: number;
}

export interface Itens {
  pedido_id: string;
  sku: string;
}

export interface DB {
  "loja.pedidos": Pedidos;
  itens: Itens;
}
`;

  it('AI-19 lê as chaves de cada interface de tabela e ignora a interface DB e os tipos que não são tabela', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'amostra.ts'), GENERATED);

    const columns = readGeneratedColumns(dir);

    expect([...columns].sort()).toEqual([
      'criado_em',
      'nome_cliente',
      'pedido_id',
      'sku',
      'total_cents',
    ]);
    expect(columns.has('itens')).toBe(false);
    expect(columns.has('loja.pedidos')).toBe(false);
    expect(columns.has('x')).toBe(false);
  });

  it('AI-19 junta as colunas de todos os arquivos da pasta', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'um.ts'), GENERATED);
    writeFileSync(
      path.join(dir, 'dois.ts'),
      'export interface Marcas {\n  cor_externa: string;\n}\n\nexport interface DB {\n  marcas: Marcas;\n}\n',
    );

    const columns = readGeneratedColumns(dir);

    expect(columns.has('cor_externa')).toBe(true);
    expect(columns.has('total_cents')).toBe(true);
    expect(columns.has('marcas')).toBe(false);
  });

  it('AI-19 em src/db/types/ há as colunas reais (on_hand, reserved, reference) e nenhum nome de tabela ou de tipo', () => {
    const columns = readGeneratedColumns(
      path.join(import.meta.dirname, '..', '..', 'src', 'db', 'types'),
    );

    for (const column of [
      'on_hand',
      'reserved',
      'reference',
      'sku',
      'price_cents',
      'call_token',
      'total_cents',
    ]) {
      expect(columns.has(column), column).toBe(true);
    }
    for (const notColumn of [
      'DB',
      'erp_sim.invoices',
      'inventory',
      'outbox',
      'x',
    ]) {
      expect(columns.has(notColumn), notColumn).toBe(false);
    }
  });
});
