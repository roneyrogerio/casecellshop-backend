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
    expect(await sqlState(insertOrder('failed', null))).toBe('23514');
  });

  it('CHK-11 pedido pending com motivo é recusado com check_violation', async () => {
    expect(await sqlState(insertOrder('pending', 'erp_rejected'))).toBe('23514');
  });

  it('CHK-11 pedido invoiced com motivo é recusado com check_violation', async () => {
    expect(await sqlState(insertOrder('invoiced', 'erp_rejected'))).toBe('23514');
  });

  it('CHK-11 pedido failed com motivo fora dos três é recusado com check_violation', async () => {
    expect(await sqlState(insertOrder('failed', 'timeout'))).toBe('23514');
  });

  it('CHK-11 pedido pending com motivo fora dos três é recusado com check_violation', async () => {
    expect(await sqlState(insertOrder('pending', 'timeout'))).toBe('23514');
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

    expect(await sqlState(updateOrder(id, 'failed', null))).toBe('23514');
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE de pending para failed com motivo fora dos três é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(await sqlState(updateOrder(id, 'failed', 'timeout'))).toBe('23514');
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE só do motivo em pedido pending é recusado', async () => {
    const id = await createOrder('pending', null);

    expect(
      await sqlState(database.pool.query('UPDATE public.orders SET failure_reason = $2 WHERE id = $1', [id, 'cancelled'])),
    ).toBe('23514');
    expect(await readOrder(id)).toEqual({ status: 'pending', failure_reason: null });
  });

  it('CHK-11 UPDATE de failed para invoiced mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'erp_rejected');

    expect(
      await sqlState(database.pool.query('UPDATE public.orders SET status = $2 WHERE id = $1', [id, 'invoiced'])),
    ).toBe('23514');
    expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: 'erp_rejected' });
  });

  it('CHK-11 UPDATE de failed para pending mantendo o motivo é recusado', async () => {
    const id = await createOrder('failed', 'cancelled');

    expect(
      await sqlState(database.pool.query('UPDATE public.orders SET status = $2 WHERE id = $1', [id, 'pending'])),
    ).toBe('23514');
    expect(await readOrder(id)).toEqual({ status: 'failed', failure_reason: 'cancelled' });
  });

  it('CHK-11 UPDATE que apaga o motivo de um pedido failed é recusado', async () => {
    const id = await createOrder('failed', 'erp_out_of_stock');

    expect(
      await sqlState(database.pool.query('UPDATE public.orders SET failure_reason = NULL WHERE id = $1', [id])),
    ).toBe('23514');
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
