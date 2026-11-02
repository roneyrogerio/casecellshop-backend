import type pg from 'pg';

// Dados semeados direto nas tabelas da loja para os testes das métricas lidas do banco (OBS-04, OBS-06): os
// instantes saem do relógio do banco (`now()`), os mesmos que o código lê, e nada espera o tempo passar.

export interface OrderSeed {
  // Há quantos segundos o pedido foi aceito.
  acceptedAgoSeconds: number;
  // Quantos segundos depois do aceite o pedido teve desfecho; sem valor, o pedido segue `pending`.
  outcomeAfterSeconds?: number;
  // `failed` para o pedido recusado; o padrão é `invoiced` com desfecho e `pending` sem.
  status?: 'pending' | 'invoiced' | 'failed';
  // Pedido que uma verificação anterior já marcou com `sli_breached_at`.
  alreadyBreached?: boolean;
}

export async function seedOrder(
  pool: pg.Pool,
  seed: OrderSeed,
): Promise<string> {
  const hasOutcome = seed.outcomeAfterSeconds !== undefined;
  const status = seed.status ?? (hasOutcome ? 'invoiced' : 'pending');
  const result = await pool.query<{ id: string }>(
    `insert into orders (status, failure_reason, accepted_at, outcome_at, sli_breached_at)
     values (
       $1::text,
       case when $1::text = 'failed' then 'erp_rejected' else null end,
       now() - make_interval(secs => $2::float8),
       case when $3::float8 is null then null
            else now() - make_interval(secs => $2::float8) + make_interval(secs => $3::float8) end,
       case when $4::boolean then now() else null end
     )
     returning id`,
    [
      status,
      seed.acceptedAgoSeconds,
      seed.outcomeAfterSeconds ?? null,
      seed.alreadyBreached ?? false,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('o pedido semeado não voltou do INSERT');
  return row.id;
}

// Muitos pedidos iguais numa instrução só (`generate_series`), para os testes que dependem do volume, como o plano
// de uma consulta. O aceite de cada um recua mais 1 s que o anterior, para os instantes não coincidirem.
export async function seedOrders(
  pool: pg.Pool,
  count: number,
  seed: OrderSeed,
): Promise<void> {
  const hasOutcome = seed.outcomeAfterSeconds !== undefined;
  const status = seed.status ?? (hasOutcome ? 'invoiced' : 'pending');
  await pool.query(
    `insert into orders (status, failure_reason, accepted_at, outcome_at, sli_breached_at)
     select
       $1::text,
       case when $1::text = 'failed' then 'erp_rejected' else null end,
       now() - make_interval(secs => $2::float8 + n),
       case when $3::float8 is null then null
            else now() - make_interval(secs => $2::float8 + n) + make_interval(secs => $3::float8) end,
       case when $4::boolean then now() else null end
     from generate_series(1, $5::int) as n`,
    [
      status,
      seed.acceptedAgoSeconds,
      seed.outcomeAfterSeconds ?? null,
      seed.alreadyBreached ?? false,
      count,
    ],
  );
}

export interface OutboxSeed {
  // Há quantos segundos a linha da outbox foi criada.
  createdAgoSeconds: number;
  dead?: boolean;
  published?: boolean;
}

// Uma linha da outbox para um pedido já semeado.
export async function seedOutboxRow(
  pool: pg.Pool,
  orderId: string,
  seed: OutboxSeed,
): Promise<void> {
  await pool.query(
    `insert into outbox (order_id, correlation_id, created_at, dead_at, published_at)
     values (
       $1,
       $2,
       now() - make_interval(secs => $3::float8),
       case when $4::boolean then now() else null end,
       case when $5::boolean then now() else null end
     )`,
    [
      orderId,
      `corr-${orderId}`,
      seed.createdAgoSeconds,
      seed.dead ?? false,
      seed.published ?? false,
    ],
  );
}

// Esvazia as tabelas da loja: cada teste cria os dados que usa, sobre um banco do arquivo que os outros também usam.
export async function resetStore(pool: pg.Pool): Promise<void> {
  await pool.query(
    'truncate outbox, order_items, idempotency_keys, orders, inventory, products',
  );
}

// Quantos pedidos têm a marca do SLI.
export async function countBreached(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    'select count(*)::int as n from orders where sli_breached_at is not null',
  );
  return result.rows[0]?.n ?? 0;
}
