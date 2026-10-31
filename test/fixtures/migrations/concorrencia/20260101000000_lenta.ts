import { type Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_conc_a')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
  // A pausa dentro da migração força a sobreposição de duas chamadas quando não há lock.
  await sql`select pg_sleep(0.5)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_conc_a').execute();
}
