import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findKyselyViolations, readGeneratedColumns, type SourceFile } from './check-kysely-usage.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const script = path.join(root, 'scripts', 'check-kysely-usage.ts');

// Um punhado de colunas basta para as regras; a lista real vem do arquivo gerado (testada mais abaixo).
const COLUMNS: ReadonlySet<string> = new Set(['on_hand', 'reserved', 'sku', 'reference', 'status']);

const APP_FILE = 'src/checkout/reserve.ts';
const DB_FILE = 'src/db/database.ts';

function violationsIn(content: string, filePath = APP_FILE): string[] {
  return findKyselyViolations([{ path: filePath, content }], COLUMNS);
}

describe('AI-19 set, values e doUpdateSet com callback reprovam; a forma de objeto passa', () => {
  it.each([
    ['set com arrow e parênteses', "db.updateTable('inventory').set((eb) => ({ reserved: eb('reserved', '+', 1) })).execute();"],
    ['set com arrow sem parênteses', "db.updateTable('inventory').set(eb => ({ reserved: eb('reserved', '+', 1) })).execute();"],
    ['set com arrow sem argumento', "db.updateTable('inventory').set(() => ({ reserved: 1 })).execute();"],
    ['set com function', "db.updateTable('inventory').set(function (eb) { return { reserved: 1 }; }).execute();"],
    ['set com a callback na linha seguinte', "db.updateTable('inventory').set(\n  (eb) => ({ reserved: 1 }),\n).execute();"],
    ['values com arrow sem argumento', "db.insertInto('products').values(() => ({ sku: 'a' })).execute();"],
    ['values com arrow e parâmetro', "db.insertInto('products').values((eb) => ({ sku: 'a' })).execute();"],
    [
      'doUpdateSet com callback',
      "db.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet((eb) => ({ reserved: eb.ref('excluded.reserved') }))).execute();",
    ],
  ])('AI-19 reprova %s', (_label, source) => {
    expect(violationsIn(source)).toHaveLength(1);
  });

  it.each([
    ['set com objeto', "db.updateTable('inventory').set({ reserved: 1 }).execute();"],
    [
      'set com objeto e callback por coluna',
      "db.updateTable('inventory').set({ reserved: (eb) => eb('reserved', '+', q) }).execute();",
    ],
    ['set com uma variável', "db.updateTable('inventory').set(patch).execute();"],
    ['values com objeto', "db.insertInto('products').values({ sku: 'a' }).execute();"],
    ['values com lista de objetos', "db.insertInto('products').values([{ sku: 'a' }, { sku: 'b' }]).execute();"],
    [
      'doUpdateSet com objeto, dentro de uma callback do onConflict',
      "db.insertInto('inventory').values({ sku: 'a' }).onConflict((oc) => oc.column('sku').doUpdateSet({ reserved: (eb) => eb.ref('excluded.reserved') })).execute();",
    ],
    ['uma callback em outro método com nome parecido (reset, offset)', 'reset(() => 1); offset((x) => x);'],
    ['Object.values e values() de um Map, que não são do Kysely', 'Object.values(obj).map((v) => v); map.values();'],
  ])('AI-19 passa %s', (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });

  it('AI-19 a forma proibida citada em comentário não conta', () => {
    expect(violationsIn("// não use set((eb) => ({ reserved: 1 })) nem sql.raw('x')\nconst a = 1;")).toEqual([]);
  });
});

describe('AI-19 sql com texto fixo que cita uma coluna reprova', () => {
  it.each([
    ['duas colunas e um operador', 'const q = sql`on_hand - reserved`;'],
    ['uma coluna, com o tipo genérico', 'const q = sql<number>`reserved + 1`;'],
    ['uma coluna entre aspas', 'const q = sql`"on_hand"`;'],
    ['uma coluna qualificada pela tabela', 'const q = sql`inventory.on_hand`;'],
    ['uma coluna numa função', "const q = sql`coalesce(reference, '')`;"],
    ['uma coluna ao lado de um valor interpolado', 'const q = sql`${value} + on_hand`;'],
    ['uma coluna numa segunda linha do fragmento', 'const q = sql`now()\n  and status`;'],
  ])('AI-19 reprova %s', (_label, source) => {
    expect(violationsIn(source).length).toBeGreaterThan(0);
  });

  it('AI-19 um fragmento com uma coluna só dá uma violação', () => {
    expect(violationsIn('const q = sql`reserved + 1`;')).toHaveLength(1);
  });

  it.each([
    ['now()', 'const q = sql`now()`;'],
    ['make_interval com valor interpolado', 'const q = sql`make_interval(secs => ${seconds})`;'],
    ['literal com o tipo genérico', 'const q = sql<number>`1`;'],
    ['count(*)', 'const q = sql`count(*)`;'],
    ['função somada a um valor interpolado', 'const q = sql`now() + ${interval}`;'],
    ['um valor interpolado que se chama como a coluna', 'const reserved = 3;\nconst q = sql`now() + ${reserved}`;'],
    ['um nome que só contém a coluna (overreserved)', 'const q = sql`overreserved()`;'],
    ['a coluna num texto comum', "const label = 'reserved'; const t = `on_hand ${label}`;"],
    ['outra tag de template', 'const q = html`on_hand`;'],
    ['eb.ref com a coluna', "const e = eb.ref('reserved');"],
    ['eb com a coluna', "const e = eb('reserved', '+', 1);"],
    ['where com a coluna', "db.selectFrom('inventory').where('sku', '=', sku).execute();"],
  ])('AI-19 passa %s', (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });
});

describe('AI-19 sql que é um comando inteiro reprova', () => {
  it.each([
    ['SELECT', 'const q = sql`SELECT 1`;'],
    ['select em minúsculas', 'const q = sql`select 1`;'],
    ['Select misturado', 'const q = sql`Select 1`;'],
    ['INSERT', 'const q = sql`INSERT INTO t VALUES (1)`;'],
    ['UPDATE com espaço antes', 'const q = sql`   UPDATE t SET a = 1`;'],
    ['DELETE', 'const q = sql`DELETE FROM t`;'],
    ['WITH com quebra de linha antes', 'const q = sql`\n  WITH a AS (SELECT 1) SELECT * FROM a`;'],
    ['with em minúsculas', 'const q = sql`with a as (select 1) select * from a`;'],
    ['SELECT com o tipo genérico', 'const q = sql<number>`SELECT ${x}`;'],
  ])('AI-19 reprova %s', (_label, source) => {
    expect(violationsIn(source).length).toBeGreaterThan(0);
  });

  it.each([
    ['now()', 'const q = sql`now()`;'],
    ['selection(), que só começa como select', 'const q = sql`selection()`;'],
    ['withdraw(), que só começa como with', 'const q = sql`withdraw()`;'],
    ['deleted(), que só começa como delete', 'const q = sql`deleted()`;'],
    ['updated_now()', 'const q = sql`updated_now()`;'],
    ['SELECT num texto comum', "const text = 'SELECT 1'; const t = `SELECT 1`;"],
  ])('AI-19 passa %s', (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });
});

describe('AI-19 as formas que montam SQL fora do builder reprovam em qualquer arquivo de src/', () => {
  const FORBIDDEN: [string, string][] = [
    ['sql.raw', "const q = sql.raw('on_hand');"],
    ['sql.lit', 'const q = sql.lit(1);'],
    ['sql.ref', "const q = sql.ref('inventory.on_hand');"],
    ['sql.id', "const q = sql.id('inventory');"],
    ['sql.table', "const q = sql.table('inventory');"],
    ['db.dynamic', 'const ref = db.dynamic.ref(column);'],
    ['.dynamic de outro receptor', 'const ref = this.connection.dynamic.ref(column);'],
    ['CompiledQuery.raw', "const compiled = CompiledQuery.raw('select 1');"],
    ['executeQuery', 'await db.executeQuery(compiled);'],
    ['executeQuery sem receptor', 'await executeQuery(compiled);'],
    ['getExecutor', 'const executor = db.getExecutor();'],
  ];

  it.each(FORBIDDEN.flatMap(([label, source]) => [APP_FILE, DB_FILE].map((file): [string, string, string] => [label, file, source])))(
    'AI-19 reprova %s em %s',
    (_label, file, source) => {
      expect(violationsIn(source, file)).toHaveLength(1);
    },
  );

  it.each([
    ['execute() do builder', "await db.selectFrom('inventory').selectAll().execute();"],
    ['executeTakeFirst() do builder', "await db.selectFrom('inventory').selectAll().executeTakeFirst();"],
    ['sql com função e execute', 'await sql`now()`.execute(db);'],
    ['um nome parecido com dynamic', 'const dynamicImport = await import(file);'],
    ['a forma citada em comentário', "// sql.raw('x') e db.dynamic ficam proibidos\nconst a = 1;"],
  ])('AI-19 passa %s', (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });
});

describe('AI-19 query do pg, transaction e startTransaction só passam dentro de src/db/', () => {
  const OUTSIDE_ONLY: [string, string][] = [
    ['.query( do pg', "await pool.query('select 1');"],
    ['.transaction(', 'await db.transaction().execute(async (trx) => { await work(trx); });'],
    ['startTransaction(', 'const trx = await db.startTransaction().execute();'],
  ];

  it.each(
    OUTSIDE_ONLY.flatMap(([label, source]) =>
      [APP_FILE, 'src/health/repository.ts', 'src/dbx/outro.ts', 'src/database/outro.ts'].map(
        (file): [string, string, string] => [label, file, source],
      ),
    ),
  )('AI-19 reprova %s fora de src/db/ (%s)', (_label, file, source) => {
    expect(violationsIn(source, file)).toHaveLength(1);
  });

  it.each(
    OUTSIDE_ONLY.flatMap(([label, source]) =>
      [DB_FILE, 'src/db/transaction.ts', 'src/db/sub/pasta.ts'].map((file): [string, string, string] => [
        label,
        file,
        source,
      ]),
    ),
  )('AI-19 passa %s dentro de src/db/ (%s)', (_label, file, source) => {
    expect(violationsIn(source, file)).toEqual([]);
  });

  it.each([
    ['req.query como propriedade, sem chamada', 'const sku = req.query.sku;'],
    ['execute() do builder', "await db.selectFrom('inventory').selectAll().execute();"],
    ['um nome que só contém Transaction', 'await inTransaction(db, async (trx) => { await work(trx); });'],
  ])('AI-19 passa %s fora de src/db/', (_label, source) => {
    expect(violationsIn(source)).toEqual([]);
  });

  it('AI-19 as formas dos fragmentos e dos executores continuam reprovando dentro de src/db/', () => {
    expect(violationsIn("const q = sql.raw('x');", DB_FILE)).toHaveLength(1);
    expect(violationsIn('const q = sql`on_hand + 1`;', DB_FILE).length).toBeGreaterThan(0);
  });
});

describe('AI-19 cada violação é uma frase com o caminho e a linha', () => {
  const content = [
    'const a = 1;',
    'const b = 2;',
    "db.updateTable('inventory').set((eb) => ({ reserved: 1 }));",
    'const c = 3;',
    'const q = sql.raw(x);',
  ].join('\n');

  it('AI-19 uma frase por ocorrência, com o caminho e o número da linha de cada uma', () => {
    const violations = violationsIn(content);

    expect(violations).toHaveLength(2);
    for (const violation of violations) {
      expect(typeof violation).toBe('string');
      expect(violation).toContain(APP_FILE);
    }
    const afterPath = (violation: string): string => violation.slice(violation.indexOf(APP_FILE) + APP_FILE.length);
    expect(violations.some((violation) => /^\D{0,14}3(?!\d)/.test(afterPath(violation)))).toBe(true);
    expect(violations.some((violation) => /^\D{0,14}5(?!\d)/.test(afterPath(violation)))).toBe(true);
  });

  it('AI-19 uma violação que vem depois de um comentário de várias linhas cita a linha do arquivo', () => {
    const violations = violationsIn('/*\n * nota\n */\nconst q = sql.raw(x);');

    expect(violations).toHaveLength(1);
    expect(violations[0]?.slice((violations[0]?.indexOf(APP_FILE) ?? 0) + APP_FILE.length)).toMatch(/^\D{0,14}4(?!\d)/);
  });

  it('AI-19 vários arquivos: cada violação cita o próprio caminho', () => {
    const files: SourceFile[] = [
      { path: 'src/a.ts', content: 'const q = sql.raw(x);' },
      { path: 'src/b.ts', content: 'const ok = 1;' },
      { path: 'src/c/d.ts', content: 'const e = db.dynamic.ref(x);' },
    ];

    const violations = findKyselyViolations(files, COLUMNS);

    expect(violations).toHaveLength(2);
    expect(violations.some((violation) => violation.includes('src/a.ts'))).toBe(true);
    expect(violations.some((violation) => violation.includes('src/c/d.ts'))).toBe(true);
    expect(violations.some((violation) => violation.includes('src/b.ts'))).toBe(false);
  });

  it('AI-19 sem violação, a lista é vazia', () => {
    expect(findKyselyViolations([], COLUMNS)).toEqual([]);
    expect(violationsIn("db.updateTable('inventory').set({ reserved: 1 }).execute();")).toEqual([]);
  });

  // Os testes ficam fora da conferência: os controles negativos precisam das formas proibidas.
  it('AI-19 um arquivo *.test.ts com as formas proibidas não conta', () => {
    expect(violationsIn("const q = sql.raw('on_hand');", 'src/checkout/reserve.test.ts')).toEqual([]);
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

    expect([...columns].sort()).toEqual(['criado_em', 'nome_cliente', 'pedido_id', 'sku', 'total_cents']);
    expect(columns.has('itens')).toBe(false);
    expect(columns.has('loja.pedidos')).toBe(false);
    expect(columns.has('x')).toBe(false);
  });

  it('AI-19 junta as colunas de todos os arquivos da pasta', () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, 'um.ts'), GENERATED);
    writeFileSync(path.join(dir, 'dois.ts'), 'export interface Marcas {\n  cor_externa: string;\n}\n\nexport interface DB {\n  marcas: Marcas;\n}\n');

    const columns = readGeneratedColumns(dir);

    expect(columns.has('cor_externa')).toBe(true);
    expect(columns.has('total_cents')).toBe(true);
    expect(columns.has('marcas')).toBe(false);
  });

  it('AI-19 em src/db/types/ há as colunas reais (on_hand, reserved, reference) e nenhum nome de tabela ou de tipo', () => {
    const columns = readGeneratedColumns(path.join(root, 'src', 'db', 'types'));

    for (const column of ['on_hand', 'reserved', 'reference', 'sku', 'price_cents', 'claim_token', 'total_cents']) {
      expect(columns.has(column), column).toBe(true);
    }
    for (const notColumn of ['DB', 'erp_sim.invoices', 'inventory', 'outbox', 'x']) {
      expect(columns.has(notColumn), notColumn).toBe(false);
    }
  });

  it('AI-19 com as colunas lidas dos arquivos, o fragmento que cita on_hand reprova e now() passa', () => {
    const columns = readGeneratedColumns(path.join(root, 'src', 'db', 'types'));
    const check = (content: string): string[] => findKyselyViolations([{ path: APP_FILE, content }], columns);

    expect(check('const q = sql`on_hand - reserved`;').length).toBeGreaterThan(0);
    expect(check('const q = sql`now()`;')).toEqual([]);
  });
});

describe('AI-19 o código atual de src/ não tem violação', () => {
  it('AI-19 findKyselyViolations sobre todos os .ts de src/ (fora os testes e src/db/types/), com as colunas reais, devolve zero', () => {
    const srcDir = path.join(root, 'src');
    const files: SourceFile[] = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .map((relative) => relative.split(path.sep).join('/'))
      .filter((relative) => relative.endsWith('.ts') && !relative.endsWith('.test.ts') && !relative.startsWith('db/types/'))
      .map((relative) => ({
        path: `src/${relative}`,
        content: readFileSync(path.join(srcDir, relative), 'utf8'),
      }));
    expect(files.length).toBeGreaterThan(0);

    const violations = findKyselyViolations(files, readGeneratedColumns(path.join(srcDir, 'db', 'types')));

    expect(violations).toEqual([]);
  });
});

// A fiação: o script rodado como processo. A regra mora em findKyselyViolations; aqui só a leitura de src/,
// a saída de erro e o código de saída, numa cópia do repositório mínimo (o script não pode apontar para outra pasta).
describe('AI-19 o script como processo', () => {
  function makeTree(sources: Record<string, string>): string {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    cpSync(script, path.join(dir, 'scripts', 'check-kysely-usage.ts'));
    cpSync(path.join(root, 'scripts', 'lib'), path.join(dir, 'scripts', 'lib'), { recursive: true });
    cpSync(path.join(root, 'package.json'), path.join(dir, 'package.json'));
    cpSync(path.join(root, 'src', 'db', 'types'), path.join(dir, 'src', 'db', 'types'), { recursive: true });
    symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    for (const [file, content] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), content);
    }
    return dir;
  }

  function run(cwd: string, file = path.join(cwd, 'scripts', 'check-kysely-usage.ts')): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, [file], { cwd, encoding: 'utf8' });
  }

  it('AI-19 sobre o repositório sai com 0', () => {
    const result = run(root, script);

    expect({ status: result.status, stderr: String(result.stderr) }).toEqual({ status: 0, stderr: '' });
  });

  it('AI-19 numa árvore com uma forma proibida em src/ sai com código diferente de 0 e cita o arquivo na saída de erro', () => {
    const dir = makeTree({ 'src/checkout/ruim.ts': "export const q = sql.raw('on_hand');\n" });

    const result = run(dir);

    expect(result.status).not.toBe(0);
    expect(String(result.stderr)).toContain('src/checkout/ruim.ts');
  });

  it('AI-19 a mesma árvore sem a forma proibida sai com 0', () => {
    const dir = makeTree({ 'src/checkout/bom.ts': "export const q = sql`now()`;\n" });

    const result = run(dir);

    expect({ status: result.status, stderr: String(result.stderr) }).toEqual({ status: 0, stderr: '' });
  });

  it('AI-19 uma forma proibida num *.test.ts de src/ não reprova', () => {
    const dir = makeTree({ 'src/checkout/ruim.test.ts': "export const q = sql.raw('on_hand');\n" });

    expect(run(dir).status).toBe(0);
  });
});
