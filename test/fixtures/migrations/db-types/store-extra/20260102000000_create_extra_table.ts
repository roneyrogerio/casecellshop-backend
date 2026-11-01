import type { Kysely } from 'kysely';

// Migração nova do FND-09: cria uma tabela no schema da loja (public) que os tipos versionados não conhecem.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd09_extra')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd09_extra').execute();
}
