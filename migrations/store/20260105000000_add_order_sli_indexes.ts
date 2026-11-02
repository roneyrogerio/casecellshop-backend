import { type Kysely, sql } from 'kysely';

// Índices parciais das consultas de observabilidade sobre `orders` (OBS-04, OBS-02): ficam pequenos porque a maior
// parte dos pedidos já tem a marca e já saiu de `pending`.
export async function up(db: Kysely<any>): Promise<void> {
  // A verificação dos pedidos sem desfecho em 60 s lê só os que ainda não têm a marca.
  await db.schema
    .createIndex('orders_sli_unbreached_idx')
    .on('orders')
    .column('accepted_at')
    .where(sql.ref('sli_breached_at'), 'is', null)
    .execute();

  // O gauge da idade da outbox junta com os pedidos pendentes.
  await db.schema
    .createIndex('orders_pending_idx')
    .on('orders')
    .column('accepted_at')
    .where(sql.ref('status'), '=', 'pending')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('orders_pending_idx').execute();
  await db.schema.dropIndex('orders_sli_unbreached_idx').execute();
}
