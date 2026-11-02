import { type Kysely, sql } from 'kysely';

// Estado da sincronização com o ERP: uma linha só. A chave booleana com CHECK impede uma segunda linha, e a
// vitrine lê `last_completed_at` para saber se já houve uma rodada completa (nulo antes da primeira).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('sync_state')
    .addColumn('id', 'boolean', (col) => col.primaryKey().defaultTo(true).check(sql`id`))
    .addColumn('last_completed_at', 'timestamptz')
    .execute();

  await db.insertInto('sync_state').values({ id: true }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sync_state').execute();
}
