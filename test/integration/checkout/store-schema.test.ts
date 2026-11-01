import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';

// CHK-11: o status do pedido é pending, invoiced ou failed com o motivo. O design manda o banco
// garantir que só o pedido failed tem motivo, que todo failed tem um e que o motivo é um dos três.
// As linhas são gravadas direto no PostgreSQL, sem passar pela aplicação, porque a garantia é do banco.

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

// O código vem de err.code; a mensagem do driver não é contrato. O 23502 do PostgreSQL 18 não
// preenche o nome da restrição, só a coluna.
async function notNullViolation(
  promise: Promise<unknown>,
): Promise<
  { code: string | undefined; column: string | undefined } | undefined
> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const { code, column } = error as { code?: string; column?: string };
    return { code, column };
  }
}

// O nome da restrição também é contrato: quem traduz a violação ou lê o log precisa de um nome que explique a regra.
const PAIR_CONSTRAINT = 'orders_failure_reason_matches_status';

async function violation(
  promise: Promise<unknown>,
): Promise<
  { code: string | undefined; constraint: string | undefined } | undefined
> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const { code, constraint } = error as {
      code?: string;
      constraint?: string;
    };
    return { code, constraint };
  }
}

const PAIR_VIOLATION = { code: '23514', constraint: PAIR_CONSTRAINT };

function insertOrder(
  status: string | null,
  failureReason: string | null,
): Promise<unknown> {
  return database.pool.query(
    'INSERT INTO public.orders (status, failure_reason) VALUES ($1, $2)',
    [status, failureReason],
  );
}

async function createOrder(
  status: string,
  failureReason: string | null,
): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    'INSERT INTO public.orders (status, failure_reason) VALUES ($1, $2) RETURNING id',
    [status, failureReason],
  );
  return result.rows[0]!.id;
}

function updateOrder(
  id: string,
  status: string,
  failureReason: string | null,
): Promise<unknown> {
  return database.pool.query(
    'UPDATE public.orders SET status = $2, failure_reason = $3 WHERE id = $1',
    [id, status, failureReason],
  );
}

async function readOrder(
  id: string,
): Promise<{ status: string; failure_reason: string | null }> {
  const result = await database.pool.query<{
    status: string;
    failure_reason: string | null;
  }>('SELECT status, failure_reason FROM public.orders WHERE id = $1', [id]);
  return result.rows[0]!;
}

const FAILURE_REASONS = ['erp_rejected', 'erp_out_of_stock', 'cancelled'];

describe('CHK-11 o banco garante o motivo do pedido falho no INSERT', () => {
  it('CHK-11 pedido failed sem motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('failed', null))).toEqual(
      PAIR_VIOLATION,
    );
  });

  it('CHK-11 pedido pending com motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('pending', 'erp_rejected'))).toEqual(
      PAIR_VIOLATION,
    );
  });

  it('CHK-11 pedido invoiced com motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('invoiced', 'erp_rejected'))).toEqual(
      PAIR_VIOLATION,
    );
  });

  it('CHK-11 pedido failed com motivo fora dos três é recusado com check_violation', async () => {
    expect(await violation(insertOrder('failed', 'timeout'))).toEqual(
      PAIR_VIOLATION,
    );
  });

  it('CHK-11 pedido pending com motivo fora dos três é recusado com check_violation', async () => {
    expect(await violation(insertOrder('pending', 'timeout'))).toEqual(
      PAIR_VIOLATION,
    );
  });

  it('CHK-11 pedido com status fora de pending, invoiced e failed é recusado com check_violation', async () => {
    expect(await violation(insertOrder('shipped', null))).toEqual({
      code: '23514',
      constraint: 'orders_status_check',
    });
  });

  it('CHK-11 pedido com status nulo é recusado com not_null_violation na coluna status', async () => {
    // Sem o NOT NULL o nulo passaria pelos dois CHECKs (um CHECK nulo é aceito). O 23502 não traz o nome da restrição.
    expect(await notNullViolation(insertOrder(null, null))).toEqual({
      code: '23502',
      column: 'status',
    });
  });

  it('CHK-11 pedido pending sem motivo é gravado', async () => {
    const id = await createOrder('pending', null);

    expect(await readOrder(id)).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('CHK-11 pedido invoiced sem motivo é gravado', async () => {
    const id = await createOrder('invoiced', null);

    expect(await readOrder(id)).toEqual({
      status: 'invoiced',
      failure_reason: null,
    });
  });

  for (const reason of FAILURE_REASONS) {
    it(`CHK-11 pedido failed com o motivo ${reason} é gravado`, async () => {
      const id = await createOrder('failed', reason);

      expect(await readOrder(id)).toEqual({
        status: 'failed',
        failure_reason: reason,
      });
    });
  }
});

describe('CHK-11 o banco garante o motivo do pedido falho no UPDATE', () => {
  it('CHK-11 UPDATE de pending para failed sem motivo é recusado e a linha não muda', async () => {
    const id = await createOrder('pending', null);

    expect(await violation(updateOrder(id, 'failed', null))).toEqual(
      PAIR_VIOLATION,
    );
    expect(await readOrder(id)).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('CHK-11 UPDATE de pending para failed com motivo fora dos três é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(await violation(updateOrder(id, 'failed', 'timeout'))).toEqual(
      PAIR_VIOLATION,
    );
    expect(await readOrder(id)).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('CHK-11 UPDATE só do motivo em pedido pending é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(
      await violation(
        database.pool.query(
          'UPDATE public.orders SET failure_reason = $2 WHERE id = $1',
          [id, 'cancelled'],
        ),
      ),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('CHK-11 UPDATE de failed para invoiced mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'erp_rejected');

    expect(
      await violation(
        database.pool.query(
          'UPDATE public.orders SET status = $2 WHERE id = $1',
          [id, 'invoiced'],
        ),
      ),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({
      status: 'failed',
      failure_reason: 'erp_rejected',
    });
  });

  it('CHK-11 UPDATE de failed para pending mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'cancelled');

    expect(
      await violation(
        database.pool.query(
          'UPDATE public.orders SET status = $2 WHERE id = $1',
          [id, 'pending'],
        ),
      ),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({
      status: 'failed',
      failure_reason: 'cancelled',
    });
  });

  it('CHK-11 UPDATE que deixa o status nulo é recusado com not_null_violation e a linha não muda', async () => {
    const id = await createOrder('pending', null);

    expect(
      await notNullViolation(
        database.pool.query(
          'UPDATE public.orders SET status = NULL WHERE id = $1',
          [id],
        ),
      ),
    ).toEqual({ code: '23502', column: 'status' });
    expect(await readOrder(id)).toEqual({
      status: 'pending',
      failure_reason: null,
    });
  });

  it('CHK-11 UPDATE que apaga o motivo de um pedido failed é recusado', async () => {
    const id = await createOrder('failed', 'erp_out_of_stock');

    expect(
      await violation(
        database.pool.query(
          'UPDATE public.orders SET failure_reason = NULL WHERE id = $1',
          [id],
        ),
      ),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({
      status: 'failed',
      failure_reason: 'erp_out_of_stock',
    });
  });

  for (const reason of FAILURE_REASONS) {
    it(`CHK-11 UPDATE de pending para failed com o motivo ${reason} é gravado`, async () => {
      const id = await createOrder('pending', null);

      await updateOrder(id, 'failed', reason);

      expect(await readOrder(id)).toEqual({
        status: 'failed',
        failure_reason: reason,
      });
    });
  }

  it('CHK-11 UPDATE de pending para invoiced sem motivo é gravado', async () => {
    const id = await createOrder('pending', null);

    await updateOrder(id, 'invoiced', null);

    expect(await readOrder(id)).toEqual({
      status: 'invoiced',
      failure_reason: null,
    });
  });
});

// O design (§ "Dados") manda o banco garantir as regras abaixo; o checkout (CHK-01 e CHK-03) depende
// delas como última defesa. Cada teste cria os próprios dados, com SKU único, e grava direto no banco.

let skuCounter = 0;

function uniqueSku(): string {
  skuCounter += 1;
  return `SCHEMA-SKU-${skuCounter}`;
}

async function createProduct(priceCents = 1000): Promise<string> {
  const sku = uniqueSku();
  await database.pool.query(
    'INSERT INTO public.products (sku, name, price_cents) VALUES ($1, $2, $3)',
    [sku, 'Capa de teste', priceCents],
  );
  return sku;
}

function insertInventory(
  sku: string,
  onHand: number,
  reserved = 0,
  soldTotal = 0,
): Promise<unknown> {
  return database.pool.query(
    'INSERT INTO public.inventory (sku, on_hand, reserved, sold_total) VALUES ($1, $2, $3, $4)',
    [sku, onHand, reserved, soldTotal],
  );
}

function insertItem(
  orderId: string | null,
  sku: string,
  quantity: number,
  unitPriceCents: number,
): Promise<unknown> {
  // Com orderId nulo o pedido é um uuid que não existe.
  return database.pool.query(
    'INSERT INTO public.order_items (order_id, sku, quantity, unit_price_cents) VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4)',
    [orderId, sku, quantity, unitPriceCents],
  );
}

function insertKey(key: string, orderId: string | null): Promise<unknown> {
  return database.pool.query(
    "INSERT INTO public.idempotency_keys (key, payload_hash, order_id) VALUES ($1, 'hash', coalesce($2::uuid, gen_random_uuid()))",
    [key, orderId],
  );
}

function insertOutbox(orderId: string | null): Promise<unknown> {
  return database.pool.query(
    "INSERT INTO public.outbox (order_id, correlation_id) VALUES (coalesce($1::uuid, gen_random_uuid()), 'corr-1')",
    [orderId],
  );
}

describe('CHK-01 o banco garante o estoque', () => {
  it('CHK-01 reserved e sold_total começam em 0', async () => {
    const sku = await createProduct();

    await database.pool.query(
      'INSERT INTO public.inventory (sku, on_hand) VALUES ($1, 5)',
      [sku],
    );

    const result = await database.pool.query(
      'SELECT on_hand, reserved, sold_total FROM public.inventory WHERE sku = $1',
      [sku],
    );
    expect(result.rows).toEqual([{ on_hand: 5, reserved: 0, sold_total: 0 }]);
  });

  it('CHK-01 reserved negativo é recusado com check_violation', async () => {
    const sku = await createProduct();

    expect(await violation(insertInventory(sku, 5, -1))).toEqual({
      code: '23514',
      constraint: 'inventory_reserved_check',
    });
  });

  it('CHK-01 on_hand negativo é recusado com check_violation', async () => {
    const sku = await createProduct();

    expect(await violation(insertInventory(sku, -1))).toEqual({
      code: '23514',
      constraint: 'inventory_on_hand_check',
    });
  });

  it('CHK-01 sold_total negativo é recusado com check_violation', async () => {
    const sku = await createProduct();

    expect(await violation(insertInventory(sku, 5, 0, -1))).toEqual({
      code: '23514',
      constraint: 'inventory_sold_total_check',
    });
  });

  it('CHK-01 o UPDATE que deixaria reserved negativo é recusado e a linha não muda', async () => {
    const sku = await createProduct();
    await insertInventory(sku, 5, 2);

    expect(
      await violation(
        database.pool.query(
          'UPDATE public.inventory SET reserved = reserved - 3 WHERE sku = $1',
          [sku],
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'inventory_reserved_check' });
    const result = await database.pool.query(
      'SELECT reserved FROM public.inventory WHERE sku = $1',
      [sku],
    );
    expect(result.rows).toEqual([{ reserved: 2 }]);
  });

  it('CHK-01 estoque de um SKU sem produto é recusado com foreign_key_violation', async () => {
    expect(await violation(insertInventory(uniqueSku(), 5))).toEqual({
      code: '23503',
      constraint: 'inventory_sku_fkey',
    });
  });
});

describe('CHK-01 o banco garante os itens do pedido', () => {
  it.each([0, -1])(
    'CHK-01 item com quantidade %i é recusado com check_violation',
    async (quantity) => {
      const sku = await createProduct();
      const orderId = await createOrder('pending', null);

      expect(await violation(insertItem(orderId, sku, quantity, 1000))).toEqual(
        {
          code: '23514',
          constraint: 'order_items_quantity_check',
        },
      );
    },
  );

  it('CHK-01 item com preço unitário negativo é recusado com check_violation', async () => {
    const sku = await createProduct();
    const orderId = await createOrder('pending', null);

    expect(await violation(insertItem(orderId, sku, 1, -1))).toEqual({
      code: '23514',
      constraint: 'order_items_unit_price_cents_check',
    });
  });

  it('CHK-01 o mesmo SKU duas vezes no mesmo pedido é recusado com unique_violation', async () => {
    const sku = await createProduct();
    const orderId = await createOrder('pending', null);
    await insertItem(orderId, sku, 1, 1000);

    expect(await violation(insertItem(orderId, sku, 2, 1000))).toEqual({
      code: '23505',
      constraint: 'order_items_pkey',
    });
  });

  it('CHK-01 o mesmo SKU em dois pedidos diferentes é gravado', async () => {
    const sku = await createProduct();
    const first = await createOrder('pending', null);
    const second = await createOrder('pending', null);

    await insertItem(first, sku, 1, 1000);
    await insertItem(second, sku, 1, 1000);

    const result = await database.pool.query(
      'SELECT count(*)::int AS total FROM public.order_items WHERE sku = $1',
      [sku],
    );
    expect(result.rows).toEqual([{ total: 2 }]);
  });

  it('CHK-01 item de um pedido que não existe é recusado com foreign_key_violation', async () => {
    const sku = await createProduct();

    expect(await violation(insertItem(null, sku, 1, 1000))).toEqual({
      code: '23503',
      constraint: 'order_items_order_id_fkey',
    });
  });

  it('CHK-01 item de um SKU sem produto é recusado com foreign_key_violation', async () => {
    const orderId = await createOrder('pending', null);

    expect(await violation(insertItem(orderId, uniqueSku(), 1, 1000))).toEqual({
      code: '23503',
      constraint: 'order_items_sku_fkey',
    });
  });
});

describe('CHK-01 o banco garante o preço do produto', () => {
  it('CHK-01 produto com preço negativo é recusado com check_violation', async () => {
    expect(
      await violation(
        database.pool.query(
          'INSERT INTO public.products (sku, name, price_cents) VALUES ($1, $2, -1)',
          [uniqueSku(), 'Capa de teste'],
        ),
      ),
    ).toEqual({ code: '23514', constraint: 'products_price_cents_check' });
  });
});

describe('CHK-03 o banco garante a chave de idempotência', () => {
  it('CHK-03 a mesma chave duas vezes é recusada com unique_violation', async () => {
    const first = await createOrder('pending', null);
    const second = await createOrder('pending', null);
    const key = `chave-${first}`;
    await insertKey(key, first);

    expect(await violation(insertKey(key, second))).toEqual({
      code: '23505',
      constraint: 'idempotency_keys_pkey',
    });
    const result = await database.pool.query(
      'SELECT order_id FROM public.idempotency_keys WHERE key = $1',
      [key],
    );
    expect(result.rows).toEqual([{ order_id: first }]);
  });

  it('CHK-03 chave de um pedido que não existe é recusada com foreign_key_violation', async () => {
    expect(
      await violation(insertKey(`chave-sem-pedido-${uniqueSku()}`, null)),
    ).toEqual({
      code: '23503',
      constraint: 'idempotency_keys_order_id_fkey',
    });
  });
});

describe('CHK-03 o banco garante uma só mensagem de outbox por pedido', () => {
  // A fila é o SQS (AD-021): a outbox nasce não publicada e sem estado de chamada, e já não guarda status nem
  // tentativas (os testes do status e do attempts provavam a fila na tabela).
  it('CHK-03 a mensagem nasce não publicada, sem chamada ao ERP e sem marca de DLQ', async () => {
    const orderId = await createOrder('pending', null);

    await database.pool.query(
      "INSERT INTO public.outbox (order_id, correlation_id) VALUES ($1, 'corr-1')",
      [orderId],
    );

    const result = await database.pool.query(
      'SELECT published_at, first_sent_at, last_call_at, call_token, dead_at FROM public.outbox WHERE order_id = $1',
      [orderId],
    );
    expect(result.rows).toEqual([
      {
        published_at: null,
        first_sent_at: null,
        last_call_at: null,
        call_token: null,
        dead_at: null,
      },
    ]);
  });

  it('CHK-03 uma segunda mensagem para o mesmo pedido é recusada com unique_violation', async () => {
    const orderId = await createOrder('pending', null);
    await insertOutbox(orderId);

    expect(await violation(insertOutbox(orderId))).toEqual({
      code: '23505',
      constraint: 'outbox_pkey',
    });
  });

  it('CHK-03 mensagem de um pedido que não existe é recusada com foreign_key_violation', async () => {
    expect(await violation(insertOutbox(null))).toEqual({
      code: '23503',
      constraint: 'outbox_order_id_fkey',
    });
  });
});

describe('CHK-11 o pedido nasce pending', () => {
  it('CHK-11 pedido gravado sem informar o status começa em pending, sem motivo', async () => {
    const result = await database.pool.query<{
      status: string;
      failure_reason: string | null;
    }>(
      'INSERT INTO public.orders DEFAULT VALUES RETURNING status, failure_reason',
    );

    expect(result.rows).toEqual([{ status: 'pending', failure_reason: null }]);
  });
});
