import { type Kysely, sql } from 'kysely';

// Índices parciais das consultas de observabilidade sobre `orders` (OBS-04, OBS-02).
export async function up(db: Kysely<any>): Promise<void> {
  // A verificação dos pedidos sem desfecho em 60 s lê só os que ainda podem receber a marca. O pedido entregue no
  // prazo nunca recebe `sli_breached_at`, então o predicado também o exclui: sem isso quase todo pedido entraria no
  // índice e cada rodada releria o histórico. O limiar é constante porque o PostgreSQL só prova que a consulta
  // implica o predicado se ele for o mesmo literal ("parameterized query clauses do not work with a partial index").
  await db.schema
    .createIndex('orders_sli_pending_idx')
    .on('orders')
    .column('accepted_at')
    .where(
      sql<boolean>`sli_breached_at IS NULL AND (outcome_at IS NULL OR outcome_at - accepted_at > interval '60 seconds')`,
    )
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
  await db.schema.dropIndex('orders_sli_pending_idx').execute();
}
