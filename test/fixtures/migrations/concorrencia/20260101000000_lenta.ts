import { type Kysely, sql } from 'kysely';

// Chave do advisory lock que o teste segura (BARRIER_KEY em migrate.test.ts). A migração só
// avança quando o teste solta a chave: a sobreposição das duas chamadas vem dessa condição, não de
// uma pausa. O lock é de transação, solto no COMMIT da migração, e vem antes do CREATE TABLE:
// sem o lock do migrador, as duas chamadas esperam aqui e só uma delas passa a criar a tabela.
const BARRIER_KEY = 7_311_001;

export async function up(db: Kysely<any>): Promise<void> {
  await sql`select pg_advisory_xact_lock(${sql.lit(BARRIER_KEY)})`.execute(db);
  await db.schema
    .createTable('fnd11_conc_a')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_conc_a').execute();
}
