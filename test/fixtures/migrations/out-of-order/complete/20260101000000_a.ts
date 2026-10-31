import type { Kysely } from 'kysely';

// Nome anterior ao da migração "b" que já rodou: chegou tarde, fora de ordem.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_order_a')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_order_a').execute();
}
