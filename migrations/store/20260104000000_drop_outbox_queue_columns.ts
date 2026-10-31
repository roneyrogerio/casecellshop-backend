import { type Kysely, sql } from 'kysely';

// Tira da outbox as colunas da fila na tabela: o SQS passa a guardar a fila (AD-021).
export async function up(db: Kysely<any>): Promise<void> {
  // Antes de perder o status, marca como publicada toda linha já encerrada, morta ou cancelada:
  // sem isso o relay as publicaria no SQS como se fossem mensagens novas.
  await sql`update outbox set published_at = now() where status <> 'pending' and published_at is null`.execute(db);

  await db.schema.dropIndex('outbox_status_next_attempt_idx').execute();
  await db.schema
    .alterTable('outbox')
    .dropColumn('status')
    .dropColumn('attempts')
    .dropColumn('lease_until')
    .dropColumn('claim_token')
    .dropColumn('next_attempt_at')
    .dropColumn('reconciled_at')
    .execute();
}

// Recria o formato da fila na tabela; o conteúdo perdido não volta (o estado vem do `published_at`).
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('outbox')
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'dead', 'done', 'cancelled')`),
    )
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0).check(sql`attempts >= 0`))
    .addColumn('lease_until', 'timestamptz')
    .addColumn('claim_token', 'uuid')
    .addColumn('next_attempt_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('reconciled_at', 'timestamptz')
    .execute();
  await db.schema.createIndex('outbox_status_next_attempt_idx').on('outbox').columns(['status', 'next_attempt_at']).execute();
}
