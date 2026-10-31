import { type Kysely, sql } from 'kysely';

// Tabelas da loja usadas pelo checkout (M2) e pelo worker (M3). A outbox já nasce
// com todas as colunas do design, para o M3 não precisar de migração. O banco
// guarda as regras (CHECKs) como defesa em profundidade.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('products')
    .addColumn('sku', 'text', (col) => col.primaryKey())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('price_cents', 'integer', (col) => col.notNull().check(sql`price_cents >= 0`))
    .addColumn('synced_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('inventory')
    .addColumn('sku', 'text', (col) => col.primaryKey().references('products.sku'))
    .addColumn('on_hand', 'integer', (col) => col.notNull().check(sql`on_hand >= 0`))
    .addColumn('reserved', 'integer', (col) => col.notNull().defaultTo(0).check(sql`reserved >= 0`))
    .addColumn('sold_total', 'integer', (col) => col.notNull().defaultTo(0).check(sql`sold_total >= 0`))
    .addColumn('synced_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // uuid gerado pelo banco: o identificador não tem ordem previsível.
  await db.schema
    .createTable('orders')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'invoiced', 'failed')`),
    )
    .addColumn('failure_reason', 'text')
    .addColumn('accepted_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('outcome_at', 'timestamptz')
    // Marca do SLI de 60 s: preenchida quando o pedido passa do prazo sem desfecho.
    .addColumn('sli_breached_at', 'timestamptz')
    // O banco garante: só pedido `failed` tem motivo, todo `failed` tem um, e é um dos três.
    // É CHECK de tabela, não de coluna: lê `status` além de `failure_reason`, e a documentação
    // do PostgreSQL pede que o CHECK de coluna cite só a própria coluna. Também ganha nome
    // estável (o de coluna sairia como `orders_check`). Motivo nulo passa no `in` (resultado
    // nulo), e a primeira condição já exige o nulo fora do `failed`.
    .addCheckConstraint(
      'orders_failure_reason_matches_status',
      sql`(status = 'failed') = (failure_reason is not null) and failure_reason in ('erp_rejected', 'erp_out_of_stock', 'cancelled')`,
    )
    .execute();

  await db.schema
    .createTable('order_items')
    .addColumn('order_id', 'uuid', (col) => col.notNull().references('orders.id'))
    .addColumn('sku', 'text', (col) => col.notNull().references('products.sku'))
    .addColumn('quantity', 'integer', (col) => col.notNull().check(sql`quantity > 0`))
    .addColumn('unit_price_cents', 'integer', (col) => col.notNull().check(sql`unit_price_cents >= 0`))
    .addPrimaryKeyConstraint('order_items_pkey', ['order_id', 'sku'])
    .execute();

  await db.schema
    .createTable('idempotency_keys')
    .addColumn('key', 'text', (col) => col.primaryKey())
    .addColumn('payload_hash', 'text', (col) => col.notNull())
    .addColumn('order_id', 'uuid', (col) => col.notNull().references('orders.id'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createTable('outbox')
    .addColumn('order_id', 'uuid', (col) => col.primaryKey().references('orders.id'))
    .addColumn('status', 'text', (col) =>
      col
        .notNull()
        .defaultTo('pending')
        .check(sql`status in ('pending', 'dead', 'done', 'cancelled')`),
    )
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0).check(sql`attempts >= 0`))
    .addColumn('lease_until', 'timestamptz')
    .addColumn('claim_token', 'uuid')
    .addColumn('first_sent_at', 'timestamptz')
    .addColumn('last_call_at', 'timestamptz')
    .addColumn('next_attempt_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('reconciled_at', 'timestamptz')
    .addColumn('traceparent', 'text')
    .addColumn('correlation_id', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // O worker escolhe as mensagens pendentes pelo prazo da próxima tentativa.
  await db.schema.createIndex('outbox_status_next_attempt_idx').on('outbox').columns(['status', 'next_attempt_at']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('outbox').execute();
  await db.schema.dropTable('idempotency_keys').execute();
  await db.schema.dropTable('order_items').execute();
  await db.schema.dropTable('orders').execute();
  await db.schema.dropTable('inventory').execute();
  await db.schema.dropTable('products').execute();
}
