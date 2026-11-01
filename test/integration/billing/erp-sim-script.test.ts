import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import {
  advanceAndDrain,
  begin,
  countInvoices,
  createErpHarness,
  ERP_TIMEOUT_MS,
  H4_LIMIT_MS,
  MIN_RETRY_DELAY_MS,
  orderFor,
  seedErpProduct,
  uniqueName,
} from '../../helpers/erp.ts';

// Roteiro de falhas do ERP simulado, com a camada anticorrupção por cima e o
// relógio manual: o timeout, os atrasos e as faturas adiadas correm nele, e
// script.drain() espera as faturas adiadas gravarem, no lugar de um sleep.

let database: TestDatabase;

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 120_000);

afterAll(async () => {
  await database?.stop();
});

async function newScenario(options: { withoutH1b?: boolean } = {}) {
  const harness = createErpHarness(database.erpPool, options);
  const sku = uniqueName('ROTEIRO-SKU');
  const reference = uniqueName('pedido-roteiro');
  await seedErpProduct(database.pool, { sku, onHand: 1000 });
  return { ...harness, sku, reference, order: orderFor(reference, sku) };
}

describe('normal, lento e indisponível', () => {
  it('ORD-21 sem comportamento na fila a criação responde como no normal, na hora', async () => {
    const { client, order, reference } = await newScenario();

    // O relógio manual nunca avança aqui: se o normal dependesse dele, a promessa não resolveria.
    expect(await client.createOrder(order)).toMatchObject({ kind: 'ok' });
    expect(await countInvoices(database.pool, reference)).toBe(1);
  });

  it('ORD-21 slow abaixo do timeout: espera o atraso e responde como no normal', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue({ mode: 'slow', delayMs: 5_000 });

    const call = await begin(harness.client.createOrder(harness.order));
    harness.clock.advance(4_999);
    await harness.sim.script.drain();
    expect(call.settled).toBe(false);

    await advanceAndDrain(harness, 1);

    expect(call.settled).toBe(true);
    expect(await call.result).toMatchObject({ kind: 'ok' });
    expect(await countInvoices(database.pool, harness.reference)).toBe(1);
  });

  it('ORD-21 slow acima do timeout: a camada anticorrupção desiste no timeout e a criação é ambígua', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue({
      mode: 'slow',
      delayMs: ERP_TIMEOUT_MS + 5_000,
    });

    const call = await begin(harness.client.createOrder(harness.order));
    await advanceAndDrain(harness, ERP_TIMEOUT_MS);

    expect(call.settled).toBe(true);
    expect(await call.result).toMatchObject({ kind: 'ambiguous' });

    // Abortado durante a espera, o slow não processa: passado o atraso, continua sem fatura.
    await advanceAndDrain(harness, 5_000);
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);
  });

  it('ORD-21 status 404 com o corpo order_not_found na criação é config_error, sem fatura', async () => {
    const { client, sim, order, reference } = await newScenario();
    sim.script.enqueue(
      { mode: 'status', status: 404, body: { code: 'order_not_found' } },
      { op: 'createOrder' },
    );

    expect(await client.createOrder(order)).toEqual({
      kind: 'config_error',
      status: 404,
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  it('ORD-21 o atraso do slow corre fora de transação: nenhuma conexão do ERP fica ocupada enquanto ele espera', async () => {
    const pool = createPool(database.uri);
    try {
      const harness = createErpHarness(pool);
      const sku = uniqueName('ROTEIRO-LENTO-SKU');
      await seedErpProduct(database.pool, { sku });
      harness.sim.script.enqueue({ mode: 'slow', delayMs: 5_000 });

      const call = await begin(
        harness.client.createOrder(orderFor(uniqueName('pedido-lento'), sku)),
      );

      expect(call.settled).toBe(false);
      expect(pool.totalCount - pool.idleCount).toBe(0);

      await advanceAndDrain(harness, 5_000);
      await call.result;
    } finally {
      await pool.end();
    }
  });

  it('ORD-21 unavailable rejeita com ECONNREFUSED: a criação é transitória e não processa', async () => {
    const { client, sim, order, reference } = await newScenario();
    sim.script.enqueue({ mode: 'unavailable' });

    expect(await client.createOrder(order)).toMatchObject({
      kind: 'transient',
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  it('ORD-21 unavailable na consulta é transitório, nunca not_found', async () => {
    const { client, sim, reference } = await newScenario();
    sim.script.enqueue({ mode: 'unavailable' });

    const result = await client.findOrderByReference(reference);

    expect(result.kind).toBe('transient');
  });
});

describe('reject e status', () => {
  it('ORD-21 reject responde 422 rejected: permanent rejected, sem fatura', async () => {
    const { client, sim, order, reference } = await newScenario();
    sim.script.enqueue({ mode: 'reject' });

    expect(await client.createOrder(order)).toEqual({
      kind: 'permanent',
      reason: 'rejected',
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  async function expectCreationClassified(
    status: number,
    expected: Record<string, unknown>,
  ) {
    const { client, sim, order, reference } = await newScenario();
    sim.script.enqueue({ mode: 'status', status });

    expect(await client.createOrder(order)).toMatchObject(expected);
    expect(await countInvoices(database.pool, reference)).toBe(0);
  }

  it.each([
    { status: 400, expected: { kind: 'config_error', status: 400 } },
    { status: 401, expected: { kind: 'config_error', status: 401 } },
    { status: 403, expected: { kind: 'config_error', status: 403 } },
  ])(
    'ORD-10 status $status na criação é classificado e não processa: nenhuma fatura',
    async ({ status, expected }) => {
      await expectCreationClassified(status, expected);
    },
  );

  it.each([
    { status: 404, expected: { kind: 'config_error', status: 404 } },
    { status: 429, expected: { kind: 'transient' } },
    { status: 503, expected: { kind: 'transient' } },
    { status: 500, expected: { kind: 'ambiguous' } },
    { status: 504, expected: { kind: 'ambiguous' } },
  ])(
    'ORD-21 status $status na criação é classificado e não processa: nenhuma fatura',
    async ({ status, expected }) => {
      await expectCreationClassified(status, expected);
    },
  );

  it.each([400, 401, 403])(
    'ORD-10 status %i na consulta é config_error e nunca not_found',
    async (status) => {
      const { client, sim, reference } = await newScenario();
      sim.script.enqueue({ mode: 'status', status });

      expect(await client.findOrderByReference(reference)).toEqual({
        kind: 'config_error',
        status,
      });
    },
  );

  it('ORD-09 status 404 sem corpo na consulta é config_error, e quem decide não cria fatura', async () => {
    const { client, sim, reference } = await newScenario();
    sim.script.enqueue({ mode: 'status', status: 404 });

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'config_error',
      status: 404,
    });
    expect(await countInvoices(database.pool, reference)).toBe(0);
  });

  it('ORD-09 status 404 com o corpo order_not_found na consulta é not_found', async () => {
    const { client, sim, reference } = await newScenario();
    sim.script.enqueue({
      mode: 'status',
      status: 404,
      body: { code: 'order_not_found' },
    });

    expect(await client.findOrderByReference(reference)).toEqual({
      kind: 'not_found',
    });
  });

  it.each([429, 500, 503, 504])(
    'ORD-09 status %i na consulta é transitório, nunca not_found',
    async (status) => {
      const { client, sim, reference } = await newScenario();
      sim.script.enqueue({ mode: 'status', status });

      expect((await client.findOrderByReference(reference)).kind).toBe(
        'transient',
      );
    },
  );

  it('ORD-21 status 401 no catálogo é config_error, e 503 é transitório', async () => {
    const { client, sim } = await newScenario();
    sim.script.enqueue({ mode: 'status', status: 401 });
    sim.script.enqueue({ mode: 'status', status: 503 });

    expect(await client.listCatalog(1)).toEqual({
      kind: 'config_error',
      status: 401,
    });
    expect((await client.listCatalog(1)).kind).toBe('transient');
  });
});

describe('invoice_no_response: o ERP fatura e não responde', () => {
  it.each([
    { withoutH1b: false, label: 'com a H1b' },
    { withoutH1b: true, label: 'sem a H1b' },
  ])(
    'ORD-03 $label: fatura, a chamada estoura o timeout ambígua e a consulta acha a única fatura',
    async ({ withoutH1b }) => {
      const harness = await newScenario({ withoutH1b });
      harness.sim.script.enqueue({ mode: 'invoice_no_response' });

      const call = await begin(harness.client.createOrder(harness.order));
      await harness.sim.script.drain();
      expect(call.settled).toBe(false);
      expect(await countInvoices(database.pool, harness.reference)).toBe(1);

      await advanceAndDrain(harness, ERP_TIMEOUT_MS);

      expect(await call.result).toMatchObject({ kind: 'ambiguous' });
      const found = await harness.client.findOrderByReference(
        harness.reference,
      );
      expect(found.kind).toBe('found');
      expect(await countInvoices(database.pool, harness.reference)).toBe(1);
    },
  );
});

describe('invoice_after: a fatura sai depois da chamada, mesmo abortada', () => {
  it('ORD-04 dentro da H4 (30 s): a chamada estoura o timeout ambígua, e a fatura aparece no atraso, nem antes nem depois', async () => {
    const harness = await newScenario({ withoutH1b: true });
    harness.sim.script.enqueue({ mode: 'invoice_after', delayMs: 30_000 });

    const call = await begin(harness.client.createOrder(harness.order));
    await advanceAndDrain(harness, ERP_TIMEOUT_MS);

    expect(await call.result).toMatchObject({ kind: 'ambiguous' });
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);

    await advanceAndDrain(harness, 19_999);
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);

    await advanceAndDrain(harness, 1);
    expect(await countInvoices(database.pool, harness.reference)).toBe(1);
  });

  it('ORD-04 dentro da H4: no atraso mínimo de 45 s a consulta já acha a única fatura, e nada mais é criado', async () => {
    const harness = await newScenario({ withoutH1b: true });
    harness.sim.script.enqueue({
      mode: 'invoice_after',
      delayMs: H4_LIMIT_MS - 10_000,
    });

    const call = await begin(harness.client.createOrder(harness.order));
    await advanceAndDrain(harness, ERP_TIMEOUT_MS);
    await call.result;
    expect(
      (await harness.client.findOrderByReference(harness.reference)).kind,
    ).toBe('not_found');

    await advanceAndDrain(harness, MIN_RETRY_DELAY_MS - ERP_TIMEOUT_MS);

    expect(
      (await harness.client.findOrderByReference(harness.reference)).kind,
    ).toBe('found');
    expect(await countInvoices(database.pool, harness.reference)).toBe(1);
  });

  it.each([
    {
      withoutH1b: false,
      invoices: 1,
      label: 'com a H1b a criação do worker não duplica',
    },
    {
      withoutH1b: true,
      invoices: 2,
      label: 'sem a H1b a fatura duplicada que o README declara',
    },
  ])(
    'ORD-06 acima da H4 (60 s): a consulta aos 45 s não acha, o worker cria, e a fatura atrasada chega aos 60 s: $label ($invoices fatura(s))',
    async ({ withoutH1b, invoices }) => {
      const harness = await newScenario({ withoutH1b });
      harness.sim.script.enqueue({ mode: 'invoice_after', delayMs: 60_000 });

      const call = await begin(harness.client.createOrder(harness.order));
      await advanceAndDrain(harness, ERP_TIMEOUT_MS);
      expect(await call.result).toMatchObject({ kind: 'ambiguous' });

      await advanceAndDrain(harness, MIN_RETRY_DELAY_MS - ERP_TIMEOUT_MS);
      expect(
        await harness.client.findOrderByReference(harness.reference),
      ).toEqual({ kind: 'not_found' });
      expect(await countInvoices(database.pool, harness.reference)).toBe(0);

      // O worker, com a consulta dizendo "não existe", cria; o roteiro já foi consumido (vale a normal).
      expect((await harness.client.createOrder(harness.order)).kind).toBe('ok');
      expect(await countInvoices(database.pool, harness.reference)).toBe(1);

      await advanceAndDrain(harness, 60_000 - MIN_RETRY_DELAY_MS);

      expect(await countInvoices(database.pool, harness.reference)).toBe(
        invoices,
      );
    },
  );
});

describe('fast_502_then_invoice: erro rápido e fatura depois', () => {
  it('ORD-05 responde 502 na hora (ambígua, sem avançar o relógio) e grava a fatura no atraso', async () => {
    const harness = await newScenario({ withoutH1b: true });
    harness.sim.script.enqueue({
      mode: 'fast_502_then_invoice',
      delayMs: 20_000,
    });

    const call = await begin(harness.client.createOrder(harness.order));

    expect(call.settled).toBe(true);
    expect(await call.result).toMatchObject({ kind: 'ambiguous' });
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);

    await advanceAndDrain(harness, 19_999);
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);

    await advanceAndDrain(harness, 1);
    expect(await countInvoices(database.pool, harness.reference)).toBe(1);
  });

  it('ORD-05 depois do atraso mínimo de 45 s a consulta acha a única fatura e o worker não cria outra', async () => {
    const harness = await newScenario({ withoutH1b: true });
    harness.sim.script.enqueue({
      mode: 'fast_502_then_invoice',
      delayMs: 20_000,
    });
    await harness.client.createOrder(harness.order);

    await advanceAndDrain(harness, MIN_RETRY_DELAY_MS);

    expect(
      (await harness.client.findOrderByReference(harness.reference)).kind,
    ).toBe('found');
    expect(await countInvoices(database.pool, harness.reference)).toBe(1);
  });
});

describe('hang: nunca responde nem fatura', () => {
  it('ORD-21 hang: a chamada só termina no timeout, ambígua, e nenhuma fatura aparece, por mais que o tempo passe', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue({ mode: 'hang' });

    const call = await begin(harness.client.createOrder(harness.order));
    await advanceAndDrain(harness, ERP_TIMEOUT_MS - 1);
    expect(call.settled).toBe(false);

    await advanceAndDrain(harness, 1);
    expect(await call.result).toMatchObject({ kind: 'ambiguous' });

    await advanceAndDrain(harness, H4_LIMIT_MS * 10);
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);
    expect(
      await harness.client.findOrderByReference(harness.reference),
    ).toEqual({ kind: 'not_found' });
  });
});

describe('fila do roteiro', () => {
  it('ORD-21 cada comportamento vale para uma chamada só', async () => {
    const { client, sim, order } = await newScenario();
    sim.script.enqueue({ mode: 'unavailable' });

    expect((await client.createOrder(order)).kind).toBe('transient');
    expect((await client.createOrder(order)).kind).toBe('ok');
  });

  it('ORD-21 comportamentos enfileirados valem em ordem, um por chamada', async () => {
    const { client, sim, order } = await newScenario();
    sim.script.enqueue({ mode: 'unavailable' });
    sim.script.enqueue({ mode: 'status', status: 503 });
    sim.script.enqueue({ mode: 'reject' });

    expect((await client.createOrder(order)).kind).toBe('transient');
    expect((await client.createOrder(order)).kind).toBe('transient');
    expect((await client.createOrder(order)).kind).toBe('permanent');
    expect((await client.createOrder(order)).kind).toBe('ok');
  });

  it('ORD-21 o comportamento com op só casa com a operação indicada e espera a sua vez', async () => {
    const { client, sim, order, reference } = await newScenario();
    sim.script.enqueue({ mode: 'unavailable' }, { op: 'findOrder' });

    // A criação não casa: não consome o comportamento e responde como no normal.
    expect((await client.createOrder(order)).kind).toBe('ok');
    expect((await client.listCatalog(1)).kind).toBe('ok');
    expect((await client.findOrderByReference(reference)).kind).toBe(
      'transient',
    );
    expect((await client.findOrderByReference(reference)).kind).toBe('found');
  });

  it('ORD-21 o comportamento com reference só casa com essa referência', async () => {
    const harness = await newScenario();
    const otherReference = uniqueName('pedido-roteiro-outro');
    harness.sim.script.enqueue(
      { mode: 'reject' },
      { op: 'createOrder', reference: harness.reference },
    );

    const other = await harness.client.createOrder(
      orderFor(otherReference, harness.sku),
    );
    const target = await harness.client.createOrder(harness.order);

    expect(other.kind).toBe('ok');
    expect(target).toEqual({ kind: 'permanent', reason: 'rejected' });
    expect(await countInvoices(database.pool, otherReference)).toBe(1);
    expect(await countInvoices(database.pool, harness.reference)).toBe(0);
  });

  it('ORD-21 o comportamento com reference também casa na consulta', async () => {
    const harness = await newScenario();
    harness.sim.script.enqueue(
      { mode: 'status', status: 401 },
      { reference: harness.reference },
    );

    expect(
      await harness.client.findOrderByReference(uniqueName('pedido-outra-ref')),
    ).toEqual({ kind: 'not_found' });
    expect(
      await harness.client.findOrderByReference(harness.reference),
    ).toEqual({ kind: 'config_error', status: 401 });
    expect(
      await harness.client.findOrderByReference(harness.reference),
    ).toEqual({ kind: 'not_found' });
  });

  it('ORD-21 o padrão do setDefault vale quando a fila não casa, sem ser consumido', async () => {
    const { client, sim, order, reference } = await newScenario();
    sim.script.setDefault({ mode: 'unavailable' });

    expect((await client.createOrder(order)).kind).toBe('transient');
    expect((await client.createOrder(order)).kind).toBe('transient');

    sim.script.enqueue({ mode: 'status', status: 400 });
    expect(await client.createOrder(order)).toEqual({
      kind: 'config_error',
      status: 400,
    });
    expect((await client.createOrder(order)).kind).toBe('transient');

    sim.script.setDefault({ mode: 'normal' });
    expect((await client.createOrder(order)).kind).toBe('ok');
    expect(await countInvoices(database.pool, reference)).toBe(1);
  });

  it('ORD-21 o padrão também vale para a operação que a fila não casa', async () => {
    const { client, sim, order } = await newScenario();
    sim.script.setDefault({ mode: 'unavailable' });
    sim.script.enqueue({ mode: 'normal' }, { op: 'createOrder' });

    expect((await client.createOrder(order)).kind).toBe('ok');
    expect((await client.listCatalog(1)).kind).toBe('transient');
  });
});
