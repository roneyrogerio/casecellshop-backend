import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMigratedDatabase, type TestDatabase } from '../../helpers/database.ts';

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

// O código vem de err.code; a mensagem do driver não é contrato.
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// O nome da restrição também é contrato: quem traduz a violação ou lê o log precisa de um nome que explique a regra.
const PAIR_CONSTRAINT = 'orders_failure_reason_matches_status';

async function violation(promise: Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const { code, constraint } = error as { code?: string; constraint?: string };
    return { code, constraint };
  }
}

const PAIR_VIOLATION = { code: '23514', constraint: PAIR_CONSTRAINT };

function insertOrder(status: string, failureReason: string | null): Promise<unknown> {
  return database.pool.query('INSERT INTO public.orders (status, failure_reason) VALUES ($1, $2)', [
    status,
    failureReason,
  ]);
}

async function createOrder(status: string, failureReason: string | null): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    'INSERT INTO public.orders (status, failure_reason) VALUES ($1, $2) RETURNING id',
    [status, failureReason],
  );
  return result.rows[0]!.id;
}

function updateOrder(id: string, status: string, failureReason: string | null): Promise<unknown> {
  return database.pool.query('UPDATE public.orders SET status = $2, failure_reason = $3 WHERE id = $1', [
    id,
    status,
    failureReason,
  ]);
}

async function readOrder(id: string): Promise<{ status: string; failure_reason: string | null }> {
  const result = await database.pool.query<{ status: string; failure_reason: string | null }>(
    'SELECT status, failure_reason FROM public.orders WHERE id = $1',
    [id],
  );
  return result.rows[0]!;
}

const FAILURE_REASONS = ['erp_rejected', 'erp_out_of_stock', 'cancelled'];

describe('CHK-11 o banco garante o motivo do pedido falho no INSERT', () => {
  it('CHK-11 pedido failed sem motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('failed', null))).toEqual(PAIR_VIOLATION);
  });

  it('CHK-11 pedido pending com motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('pending', 'erp_rejected'))).toEqual(PAIR_VIOLATION);
  });

  it('CHK-11 pedido invoiced com motivo é recusado com check_violation', async () => {
    expect(await violation(insertOrder('invoiced', 'erp_rejected'))).toEqual(PAIR_VIOLATION);
  });

  it('CHK-11 pedido failed com motivo fora dos três é recusado com check_violation', async () => {
    expect(await violation(insertOrder('failed', 'timeout'))).toEqual(PAIR_VIOLATION);
  });

  it('CHK-11 pedido pending com motivo fora dos três é recusado com check_violation', async () => {
    expect(await violation(insertOrder('pending', 'timeout'))).toEqual(PAIR_VIOLATION);
  });

  it('CHK-11 pedido com status fora de pending, invoiced e failed é recusado com check_violation', async () => {
    expect(await sqlState(insertOrder('shipped', null))).toBe('23514');
  });

  it('CHK-11 pedido pending sem motivo é gravado', async () => {
    const id = await createOrder('pending', null);

    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 pedido invoiced sem motivo é gravado', async () => {
    const id = await createOrder('invoiced', null);

    expect(await readOrder(id)).toEqual({ status: 'invoiced', failure_reason: null });
  });

  for (const reason of FAILURE_REASONS) {
    it(`CHK-11 pedido failed com o motivo ${reason} é gravado`, async () => {
      const id = await createOrder('failed', reason);

      expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: reason });
    });
  }
});

describe('CHK-11 o banco garante o motivo do pedido falho no UPDATE', () => {
  it('CHK-11 UPDATE de pending para failed sem motivo é recusado e a linha não muda', async () => {
    const id = await createOrder('pending', null);

    expect(await violation(updateOrder(id, 'failed', null))).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE de pending para failed com motivo fora dos três é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(await violation(updateOrder(id, 'failed', 'timeout'))).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE só do motivo em pedido pending é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(
      await violation(database.pool.query('UPDATE public.orders SET failure_reason = $2 WHERE id = $1', [id, 'cancelled'])),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE de failed para invoiced mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'erp_rejected');

    expect(
      await violation(database.pool.query('UPDATE public.orders SET status = $2 WHERE id = $1', [id, 'invoiced'])),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: 'erp_rejected' });
  });

  it('CHK-11 UPDATE de failed para pending mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'cancelled');

    expect(
      await violation(database.pool.query('UPDATE public.orders SET status = $2 WHERE id = $1', [id, 'pending'])),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: 'cancelled' });
  });

  it('CHK-11 UPDATE que apaga o motivo de um pedido failed é recusado', async () => {
    const id = await createOrder('failed', 'erp_out_of_stock');

    expect(
      await violation(database.pool.query('UPDATE public.orders SET failure_reason = NULL WHERE id = $1', [id])),
    ).toEqual(PAIR_VIOLATION);
    expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: 'erp_out_of_stock' });
  });

  for (const reason of FAILURE_REASONS) {
    it(`CHK-11 UPDATE de pending para failed com o motivo ${reason} é gravado`, async () => {
      const id = await createOrder('pending', null);

      await updateOrder(id, 'failed', reason);

      expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: reason });
    });
  }

  it('CHK-11 UPDATE de pending para invoiced sem motivo é gravado', async () => {
    const id = await createOrder('pending', null);

    await updateOrder(id, 'invoiced', null);

    expect(await readOrder(id)).toEqual({ status: 'invoiced', failure_reason: null });
  });
});
