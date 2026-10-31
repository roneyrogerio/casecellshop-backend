import { type Kysely, sql } from 'kysely';

// Migração lenta de propósito: o teste do FND-10 destrói o socket da conexão enquanto este
// pg_sleep roda no servidor (o número no texto é como o teste acha a consulta em pg_stat_activity).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`select pg_sleep(37)`.execute(db);
  await db.schema
    .createTable('fnd10_socket_destruido')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd10_socket_destruido').execute();
}
