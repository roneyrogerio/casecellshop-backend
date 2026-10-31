import type { Kysely } from 'kysely';

// Migração nova do FND-09: cria uma tabela no schema erp_sim que os tipos versionados não conhecem.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createSchema('erp_sim').ifNotExists().execute();
  await db.schema
    .withSchema('erp_sim')
    .createTable('fnd09_extra')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.withSchema('erp_sim').dropTable('fnd09_extra').execute();
}
