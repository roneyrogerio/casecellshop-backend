import { type Kysely, sql } from 'kysely';

// Estado do ERP simulado: produtos e faturas. Só o módulo src/erp/sim/ acessa este schema.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createSchema('erp_sim').ifNotExists().execute();
  const schema = db.schema.withSchema('erp_sim');
  await schema
    .createTable('products')
    .addColumn('sku', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('price_cents', 'integer', (col) => col.notNull().check(sql`price_cents >= 0`))
    .addColumn('on_hand', 'integer', (col) => col.notNull().check(sql`on_hand >= 0`))
    .execute();
  // A referência única é a H1b: criar duas vezes devolve a mesma fatura.
  await schema
    .createTable('invoices')
    .addColumn('id', 'bigint', (col) => col.generatedAlwaysAsIdentity().primaryKey())
    .addColumn('reference', 'text', (col) => col.notNull().unique())
    .addColumn('items', 'jsonb', (col) => col.notNull())
    .addColumn('total_cents', 'bigint', (col) => col.notNull().check(sql`total_cents >= 0`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const schema = db.schema.withSchema('erp_sim');
  await schema.dropTable('invoices').execute();
  await schema.dropTable('products').execute();
}
