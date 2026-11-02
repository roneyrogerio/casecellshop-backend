import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CheckoutAccepted } from '../../../src/contract/index.ts';
import type { ErpSimBehavior } from '../../../src/erp/sim/index.ts';
import { seedCatalog } from '../../helpers/catalog.ts';
import { checkoutBody, line, postCheckout } from '../../helpers/checkout.ts';
import { seedErpProduct } from '../../helpers/erp.ts';
import { captureLogs, type LogLine } from '../../helpers/logs.ts';
import {
  expectNoSkuInMetrics,
  expectOnlyKeys,
  stringList,
} from '../../helpers/sku-logs.ts';
import {
  buildWorker,
  createWorld,
  enqueue,
  readOrder,
  useWorkerSuite,
  type AcceptedOrder,
  type QueueWorld,
} from '../../helpers/worker.ts';

// OBS-01 (o sku no pedido que o ERP recusou): o casecellshop.order.failed com erp_out_of_stock ou erp_rejected leva a
// lista `skus` dos itens do pedido, em ordem de SKU, e o `sku` que o corpo do 422 apontou, quando é um dos itens.
// Um SKU fora do pedido, ou nenhum, não sai (o corpo do ERP é entrada externa); o `skus` sai do mesmo jeito.

const FAILED = 'casecellshop.order.failed';
const PRICE_CENTS = 4990;

const suiteOf = useWorkerSuite();

interface ItemSpec {
  sku: string;
  // `null`: o produto existe na loja e não existe no ERP (unknown_product no simulador).
  erpOnHand: number | null;
}

// Um pedido de verdade pelo checkout, com um item por SKU (a loja tem estoque de sobra), o ERP com o estoque que o
// teste manda e a mensagem na fila deste mundo.
async function submitItems(
  world: QueueWorld,
  items: readonly ItemSpec[],
): Promise<AcceptedOrder> {
  const suite = suiteOf();
  await seedCatalog(
    suite.database.pool,
    items.map((item) => ({
      sku: item.sku,
      priceCents: PRICE_CENTS,
      onHand: 10,
    })),
  );
  for (const item of items) {
    if (item.erpOnHand !== null)
      await seedErpProduct(suite.database.pool, {
        sku: item.sku,
        priceCents: PRICE_CENTS,
        onHand: item.erpOnHand,
      });
  }
  const res = await postCheckout(
    suite.checkout.server,
    checkoutBody(
      ...items.map((item) => line({ sku: item.sku, priceCents: PRICE_CENTS })),
    ),
  );
  expect(res.status).toBe(202);
  const { orderId } = CheckoutAccepted.parse(res.body);
  const order: AcceptedOrder = {
    orderId,
    requestId: String(res.headers['x-request-id']),
    sku: items[0]?.sku ?? '',
    quantity: 1,
    priceCents: PRICE_CENTS,
    onHand: 10,
  };
  await enqueue(world, order);
  return order;
}

// Três SKUs de ordem conhecida, únicos neste banco.
function skuSet(): { a: string; b: string; c: string } {
  const id = randomUUID().slice(0, 8);
  return { a: `A-${id}`, b: `B-${id}`, c: `C-${id}` };
}

// O pedido recusado de ponta a ponta: o worker roda uma vez, o pedido termina failed pelo motivo esperado e sai uma
// só linha de pedido recusado, que o teste lê. `answer` troca a resposta do ERP à criação (o roteiro do simulador).
async function failOrder(
  items: readonly ItemSpec[],
  reason: 'erp_out_of_stock' | 'erp_rejected',
  answer?: ErpSimBehavior,
): Promise<LogLine> {
  const world = await createWorld(suiteOf());
  const logs = captureLogs();
  const order = await submitItems(world, items);
  if (answer)
    world.sim.script.enqueue(answer, {
      op: 'createOrder',
      reference: order.orderId,
    });

  expect(await buildWorker(world, { logger: logs.logger }).pollOnce()).toBe(1);

  const row = await readOrder(suiteOf().pool, order.orderId);
  expect([row.status, row.failureReason]).toEqual(['failed', reason]);
  const failed = logs.eventsOf(FAILED);
  expect(failed, 'uma linha de pedido recusado').toHaveLength(1);
  const [entry] = failed;
  expect(entry?.['level']).toBe('warn');
  expect(entry?.['reason']).toBe(reason);
  expect(entry?.['orderId']).toBe(order.orderId);
  // O sku foi ao log e a nenhuma métrica do worker.
  await expectNoSkuInMetrics(
    world.telemetry,
    items.map((item) => item.sku),
  );
  return entry ?? {};
}

describe('OBS-01 order.failed com a recusa do ERP leva skus do pedido e o sku que o ERP apontou', () => {
  it('OBS-01 erp_out_of_stock com três itens e o segundo sem estoque no ERP: skus traz os três em ordem de SKU e sku é o do segundo', async () => {
    const s = skuSet();

    const entry = await failOrder(
      [
        { sku: s.c, erpOnHand: 100 },
        { sku: s.b, erpOnHand: 0 },
        { sku: s.a, erpOnHand: 100 },
      ],
      'erp_out_of_stock',
    );

    expect(stringList(entry['skus'])).toEqual([s.a, s.b, s.c]);
    expect(entry['sku']).toBe(s.b);
    expectOnlyKeys(entry, ['reason', 'skus', 'sku', 'orderId', 'attempt']);
  });

  it('OBS-01 erp_rejected por unknown_product do ERP simulado: skus traz os itens do pedido e sku é o que o ERP não conhece', async () => {
    const s = skuSet();

    const entry = await failOrder(
      [
        { sku: s.a, erpOnHand: 100 },
        { sku: s.b, erpOnHand: null },
      ],
      'erp_rejected',
    );

    expect(stringList(entry['skus'])).toEqual([s.a, s.b]);
    expect(entry['sku']).toBe(s.b);
  });

  it('OBS-01 um pedido de 20 itens com a falta de estoque no décimo: skus traz os 20 em ordem de SKU, o máximo de um pedido, e sku é o décimo', async () => {
    const id = randomUUID().slice(0, 8);
    const skus = Array.from(
      { length: 20 },
      (_, index) => `K${String(index).padStart(2, '0')}-${id}`,
    );

    // Fora de ordem no pedido: a lista sai em ordem de SKU de qualquer jeito.
    const entry = await failOrder(
      [...skus].reverse().map((sku) => ({
        sku,
        erpOnHand: sku === skus[9] ? 0 : 100,
      })),
      'erp_out_of_stock',
    );

    expect(stringList(entry['skus'])).toEqual(skus);
    expect(entry['sku']).toBe(skus[9]);
  });
});

describe('OBS-01 order.failed sem o sku quando o ERP não aponta um dos itens', () => {
  // Dois itens com estoque no ERP; quem recusa é a resposta do roteiro.
  async function failWithAnswer(
    answer: ErpSimBehavior,
    reason: 'erp_out_of_stock' | 'erp_rejected',
  ): Promise<LogLine> {
    const s = skuSet();
    const entry = await failOrder(
      [
        { sku: s.a, erpOnHand: 100 },
        { sku: s.b, erpOnHand: 100 },
      ],
      reason,
      answer,
    );
    // O skus sai em todos os casos, em ordem de SKU.
    expect(stringList(entry['skus'])).toEqual([s.a, s.b]);
    return entry;
  }

  it('OBS-01 o 422 aponta um SKU que não está no pedido: o sku é descartado e o skus sai', async () => {
    const entry = await failWithAnswer(
      {
        mode: 'status',
        status: 422,
        body: { code: 'out_of_stock', sku: 'FORA-DO-PEDIDO-001' },
      },
      'erp_out_of_stock',
    );

    expect(entry).not.toHaveProperty('sku');
  });

  it('OBS-01 o 422 de falta de estoque sem sku no corpo: o sku não sai e o skus sai', async () => {
    const entry = await failWithAnswer(
      { mode: 'status', status: 422, body: { code: 'out_of_stock' } },
      'erp_out_of_stock',
    );

    expect(entry).not.toHaveProperty('sku');
  });

  it('OBS-01 a rejeição do roteiro (422 rejected, sem sku): erp_rejected leva o skus e não leva sku', async () => {
    const entry = await failWithAnswer({ mode: 'reject' }, 'erp_rejected');

    expect(entry).not.toHaveProperty('sku');
  });

  it('OBS-01 o 422 aponta um texto fora do formato do SKU: o sku não sai e o skus sai', async () => {
    const entry = await failWithAnswer(
      {
        mode: 'status',
        status: 422,
        body: { code: 'rejected', sku: 'isto não é um sku' },
      },
      'erp_rejected',
    );

    expect(entry).not.toHaveProperty('sku');
  });
});
