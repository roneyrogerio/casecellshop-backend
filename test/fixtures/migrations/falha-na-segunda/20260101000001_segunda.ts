import type { Kysely } from 'kysely';

// Cria uma tabela e falha em seguida: o que ela fez antes de lançar também precisa sumir.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_falha_segunda')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
  throw new Error('falha de propósito na segunda migração');
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_falha_segunda').execute();
}
