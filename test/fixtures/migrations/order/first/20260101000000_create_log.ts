import type { Kysely } from 'kysely';

// A tabela de registro nasce aqui; a pasta "second" só escreve nela, então só funciona depois desta.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_order_log')
    .addColumn('id', 'integer', (col) => col.generatedAlwaysAsIdentity().primaryKey())
    .addColumn('who', 'text', (col) => col.notNull())
    .execute();
  await db.insertInto('fnd11_order_log').values({ who: 'first-1' }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_order_log').execute();
}
