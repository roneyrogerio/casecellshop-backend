import type { Kysely } from 'kysely';

// Sem down: o Kysely aceita (o down é opcional para ele), o projeto não.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_semdown')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}
