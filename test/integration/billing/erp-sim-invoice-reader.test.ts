import { describe, expect, it, onTestFinished } from 'vitest';
import { settle } from '../../helpers/async.ts';
import {
  advanceAndDrain,
  begin,
  countInvoices,
  createErpHarness,
  ERP_TIMEOUT_MS,
  orderFor,
  uniqueName,
  useErpScenarios,
} from '../../helpers/erp.ts';
import { createTestPool } from '../../helpers/pool.ts';

// A leitura do banco do ERP do simulado (AD-031; design.md, "ERP simulado e camada anticorrupção"): o
// `invoiceReader` conta as linhas de erp_sim.invoices da referência, com e sem a H1b, e segue o roteiro com a
// operação `countInvoices` (normal, slow, unavailable e hang; os outros comportamentos valem como normal).

const { database, newScenario } = useErpScenarios();

function neverAborted(): AbortSignal {
  return new AbortController().signal;
}

describe('ORD-21 o invoiceReader conta as faturas de erp_sim.invoices pela referência', () => {
  it('ORD-21 uma referência sem fatura conta 0', async () => {
    const { sim, reference } = await newScenario();

    expect(
      await sim.invoiceReader.countInvoices(reference, neverAborted()),
    ).toBe(0);
  });

  it('ORD-21 com a H1b, a criação repetida deixa uma fatura, e a leitura conta 1', async () => {
    const { client, sim, order, reference } = await newScenario();
    await client.createOrder(order);
    await client.createOrder(order);

    expect(
      await sim.invoiceReader.countInvoices(reference, neverAborted()),
    ).toBe(1);
    expect(await countInvoices(database().pool, reference)).toBe(1);
  });

  it('ORD-21 sem a H1b, cada criação vira uma fatura nova, e a leitura conta 2 depois de duas criações', async () => {
    const { client, sim, order, reference } = await newScenario({
      withoutH1b: true,
    });
    await client.createOrder(order);
    await client.createOrder(order);

    expect(
      await sim.invoiceReader.countInvoices(reference, neverAborted()),
    ).toBe(2);
    expect(await countInvoices(database().pool, reference)).toBe(2);
  });

  it('ORD-21 a leitura conta só a referência pedida, não as de outros pedidos', async () => {
    const { client, sim, order, reference, sku } = await newScenario({
      withoutH1b: true,
    });
    const other = orderFor(uniqueName('pedido-outro'), sku);
    await client.createOrder(order);
    await client.createOrder(other);
    await client.createOrder(other);

    expect(
      await sim.invoiceReader.countInvoices(reference, neverAborted()),
    ).toBe(1);
    expect(
      await sim.invoiceReader.countInvoices(other.reference, neverAborted()),
    ).toBe(2);
  });

  it('ORD-21 a camada anticorrupção devolve ok com a contagem do simulado', async () => {
    const { client, order, reference } = await newScenario({
      withoutH1b: true,
    });
    await client.createOrder(order);
    await client.createOrder(order);

    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 2,
    });
  });

  it('ORD-21 a contagem lê o banco, não a API: não passa pelo transporte nem consome o roteiro de findOrder', async () => {
    const { client, sim, order, reference } = await newScenario();
    await client.createOrder(order);
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'findOrder', reference });

    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 1,
    });

    // O comportamento do findOrder continua na fila, para a consulta que vier.
    expect((await client.findOrderByReference(reference)).kind).toBe(
      'transient',
    );
  });
});

describe('ORD-21 o roteiro vale para a leitura, com a operação countInvoices', () => {
  it('ORD-21 unavailable rejeita a leitura, sem contar; a camada anticorrupção devolve transient', async () => {
    const { client, sim, order, reference } = await newScenario();
    await client.createOrder(order);
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'countInvoices' });

    await expect(
      sim.invoiceReader.countInvoices(reference, neverAborted()),
    ).rejects.toBeInstanceOf(Error);

    sim.script.enqueue({ mode: 'unavailable' }, { op: 'countInvoices' });
    expect((await client.countInvoicesByReference(reference)).kind).toBe(
      'transient',
    );
  });

  it('ORD-21 cada comportamento vale para uma leitura só: a seguinte volta ao normal', async () => {
    const { client, sim, order, reference } = await newScenario();
    await client.createOrder(order);
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'countInvoices' });

    expect((await client.countInvoicesByReference(reference)).kind).toBe(
      'transient',
    );
    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 1,
    });
  });

  it('ORD-21 o roteiro da leitura casa pela referência: outra referência não consome o comportamento', async () => {
    const { client, sim, order, reference, sku } = await newScenario();
    const other = orderFor(uniqueName('pedido-outra-ref'), sku);
    await client.createOrder(order);
    await client.createOrder(other);
    sim.script.enqueue(
      { mode: 'unavailable' },
      { op: 'countInvoices', reference },
    );

    expect(await client.countInvoicesByReference(other.reference)).toEqual({
      kind: 'ok',
      count: 1,
    });
    expect((await client.countInvoicesByReference(reference)).kind).toBe(
      'transient',
    );
  });

  it('ORD-21 um comportamento de outra operação não é consumido pela leitura', async () => {
    const { client, sim, order, reference } = await newScenario();
    await client.createOrder(order);
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'createOrder' });

    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 1,
    });
    expect((await client.createOrder(order)).kind).toBe('transient');
  });

  it('ORD-21 o padrão do roteiro (setDefault unavailable) vale também para a leitura', async () => {
    const { client, sim, reference } = await newScenario();
    sim.script.setDefault({ mode: 'unavailable' });

    expect((await client.countInvoicesByReference(reference)).kind).toBe(
      'transient',
    );
  });

  it('ORD-21 hang não responde enquanto o sinal não aborta, e então rejeita com o motivo do sinal', async () => {
    const { sim, reference } = await newScenario();
    sim.script.enqueue({ mode: 'hang' }, { op: 'countInvoices' });
    const controller = new AbortController();

    const read = await begin(
      sim.invoiceReader.countInvoices(reference, controller.signal),
    );
    await settle();
    expect(read.settled).toBe(false);

    const reason = new Error('timeout da leitura');
    controller.abort(reason);
    await settle();

    expect(read.settled).toBe(true);
    await expect(read.result).rejects.toBe(reason);
  });

  it('ORD-21 hang pela camada anticorrupção: a leitura é transient quando o relógio avança o timeout', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue({ mode: 'hang' }, { op: 'countInvoices' });

    const call = await begin(
      harness.client.countInvoicesByReference(harness.reference),
    );
    harness.clock.advance(ERP_TIMEOUT_MS - 1);
    await settle();
    expect(call.settled).toBe(false);

    await advanceAndDrain(harness, 1);

    expect(call.settled).toBe(true);
    expect((await call.result).kind).toBe('transient');
  });

  it('ORD-21 slow espera o atraso no relógio injetável e depois conta como no normal', async () => {
    const harness = await newScenario();
    await harness.client.createOrder(harness.order);
    harness.sim.script.enqueue(
      { mode: 'slow', delayMs: 5_000 },
      { op: 'countInvoices' },
    );

    const call = await begin(
      harness.client.countInvoicesByReference(harness.reference),
    );
    harness.clock.advance(4_999);
    await settle();
    expect(call.settled).toBe(false);

    await advanceAndDrain(harness, 1);

    expect(await call.result).toEqual({ kind: 'ok', count: 1 });
  });

  it('ORD-21 slow acima do timeout: a camada anticorrupção desiste e a leitura é transient', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue(
      { mode: 'slow', delayMs: ERP_TIMEOUT_MS + 5_000 },
      { op: 'countInvoices' },
    );

    const call = await begin(
      harness.client.countInvoicesByReference(harness.reference),
    );
    await advanceAndDrain(harness, ERP_TIMEOUT_MS);

    expect(call.settled).toBe(true);
    expect((await call.result).kind).toBe('transient');
  });

  it('ORD-21 o atraso do slow da leitura corre fora de transação: nenhuma conexão do ERP fica ocupada enquanto espera', async () => {
    const erpPool = createTestPool(database().uri);
    onTestFinished(() => erpPool.end());
    const harness = createErpHarness(erpPool);
    harness.sim.script.enqueue(
      { mode: 'slow', delayMs: 5_000 },
      { op: 'countInvoices' },
    );

    const read = await begin(
      harness.client.countInvoicesByReference(uniqueName('referencia-lenta')),
    );

    expect(read.settled).toBe(false);
    expect(erpPool.totalCount - erpPool.idleCount).toBe(0);
    await advanceAndDrain(harness, 5_000);
    expect((await read.result).kind).toBe('ok');
  });

  it.each([
    { label: 'reject', behavior: { mode: 'reject' } },
    { label: 'status 500', behavior: { mode: 'status', status: 500 } },
    { label: 'invoice_no_response', behavior: { mode: 'invoice_no_response' } },
    {
      label: 'fast_502_then_invoice',
      behavior: { mode: 'fast_502_then_invoice', delayMs: 1_000 },
    },
  ] as const)(
    'ORD-21 o comportamento $label vale como normal para a leitura: conta e não grava fatura',
    async ({ behavior }) => {
      const harness = await newScenario();
      await harness.client.createOrder(harness.order);
      harness.sim.script.enqueue(behavior, { op: 'countInvoices' });

      const result = await harness.client.countInvoicesByReference(
        harness.reference,
      );
      await advanceAndDrain(harness, 5_000);

      expect(result).toEqual({ kind: 'ok', count: 1 });
      expect(await countInvoices(database().pool, harness.reference)).toBe(1);
    },
  );
});
