import { type Kysely, sql } from 'kysely';

// Marca de envio e verificação tardia (AD-031): `create_calls` conta as criações mandadas ao ERP,
// `late_checked_at` e `late_finding` guardam o resultado da verificação tardia.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('outbox')
    .addColumn('create_calls', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('late_checked_at', 'timestamptz')
    .addColumn('late_finding', 'text', (col) =>
      col.check(sql`late_finding in ('failed_order', 'duplicate')`),
    )
    // Início da última criação enviada: o cancel mede a janela de assentamento daqui, e não do
    // `last_call_at`, que consultas e reconciliações também regravam.
    .addColumn('last_create_at', 'timestamptz')
    .execute();

  // Linhas anteriores à coluna: quem tem `first_sent_at` mandou ao menos uma criação; com
  // `first_sent_at < last_call_at` houve outra chamada depois da primeira, então conta duas.
  await sql`update outbox set create_calls = case when first_sent_at < last_call_at then 2 else 1 end
    where first_sent_at is not null`.execute(db);
  // Sem registro melhor, a última chamada é a aproximação segura da última criação.
  await sql`update outbox set last_create_at = last_call_at where create_calls >= 1`.execute(
    db,
  );

  // A verificação lê só os pedidos ainda não verificados e com algum envio; o índice parcial fica
  // pequeno depois que a maioria das linhas recebe a marca ou nunca chamou o ERP.
  await db.schema
    .createIndex('outbox_late_check_idx')
    .on('outbox')
    .column('last_call_at')
    .where(sql.ref('late_checked_at'), 'is', null)
    .where(sql.ref('create_calls'), '>=', 1)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('outbox_late_check_idx').execute();
  await db.schema
    .alterTable('outbox')
    .dropColumn('create_calls')
    .dropColumn('late_checked_at')
    .dropColumn('late_finding')
    .dropColumn('last_create_at')
    .execute();
}
