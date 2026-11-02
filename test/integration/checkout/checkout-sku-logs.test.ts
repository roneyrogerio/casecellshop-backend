import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import { seedCatalog, type CatalogSeed } from '../../helpers/catalog.ts';
import {
  checkoutBody,
  line,
  newKey,
  postCheckout,
  useCheckoutHarness,
} from '../../helpers/checkout.ts';
import type { LogLine } from '../../helpers/logs.ts';
import {
  expectNoSkuInMetrics,
  expectOnlyKeys,
  stringList,
} from '../../helpers/sku-logs.ts';

// OBS-01 (o sku nos logs do checkout): a recusa por falta de estoque leva o `sku` em que a reserva parou; o preço
// alterado leva a lista `skus` dos itens cujo preço mudou; as outras recusas não levam sku. O sku vai só no log:
// nem a resposta HTTP nem o /metrics o ganham, e nenhum dado do cliente entra nessas linhas.

const REJECTED = 'casecellshop.checkout.rejected';
const PRICE_CHANGED = 'casecellshop.checkout.price_changed';

const suite = useCheckoutHarness();
const usedSkus: string[] = [];

// Três SKUs de ordem conhecida (a, b, c): a primeira letra decide a ordem em qualquer collation.
function skuSet(): { a: string; b: string; c: string } {
  const id = randomUUID().slice(0, 8);
  const skus = { a: `A-${id}`, b: `B-${id}`, c: `C-${id}` };
  usedSkus.push(skus.a, skus.b, skus.c);
  return skus;
}

function seed(rows: readonly CatalogSeed[]): Promise<void> {
  return seedCatalog(suite.database.pool, rows);
}

function newCorrelationId(): string {
  return `obs01-sku-${randomUUID()}`;
}

// As linhas de um evento da requisição; espera ao menos uma, e confere que saiu uma só.
async function linesOf(
  event: string,
  correlationId: string,
): Promise<LogLine[]> {
  const find = () =>
    suite.harness.logLines.filter(
      (entry) =>
        entry['event'] === event && entry['correlationId'] === correlationId,
    );
  await vi.waitFor(
    () => {
      expect(find().length, `${event} ausente`).toBeGreaterThan(0);
    },
    { timeout: WAIT_GUARD_MS },
  );
  expect(find(), `${event} saiu uma vez só`).toHaveLength(1);
  return find();
}

describe('OBS-01 checkout.rejected por falta de estoque leva o sku em que a reserva parou', () => {
  it('OBS-01 com dois itens e só o segundo na ordem de SKU sem estoque, o checkout.rejected (warn) leva o sku do segundo, e a resposta HTTP não ganha sku', async () => {
    const s = skuSet();
    await seed([
      { sku: s.a, priceCents: 1000, onHand: 5 },
      { sku: s.b, priceCents: 2000, onHand: 2 },
    ]);
    const correlationId = newCorrelationId();

    // O corpo manda o b antes do a: a reserva segue a ordem de SKU, não a do corpo.
    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(
        line({ sku: s.b, priceCents: 2000 }, 3),
        line({ sku: s.a, priceCents: 1000 }, 1),
      ),
      { requestId: correlationId },
    );

    expect(res.status).toBe(409);
    expect(res.body).not.toHaveProperty('sku');
    expect(res.body).not.toHaveProperty('skus');
    const [rejected] = await linesOf(REJECTED, correlationId);
    expect(rejected?.['level']).toBe('warn');
    expect(rejected?.['reason']).toBe('out_of_stock');
    expect(rejected?.['sku']).toBe(s.b);
    expect(rejected).not.toHaveProperty('skus');
  });

  it('OBS-01 com vários itens sem unidades livres (reservado igual ao disponível e estoque zero), o sku é o primeiro deles na ordem de SKU', async () => {
    const s = skuSet();
    await seed([
      { sku: s.a, priceCents: 1000, onHand: 3, reserved: 3 },
      { sku: s.b, priceCents: 1000, onHand: 0 },
      { sku: s.c, priceCents: 1000, onHand: 9 },
    ]);
    const correlationId = newCorrelationId();

    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(
        line({ sku: s.c, priceCents: 1000 }),
        line({ sku: s.b, priceCents: 1000 }),
        line({ sku: s.a, priceCents: 1000 }),
      ),
      { requestId: correlationId },
    );

    expect(res.status).toBe(409);
    const [rejected] = await linesOf(REJECTED, correlationId);
    expect(rejected?.['reason']).toBe('out_of_stock');
    expect(rejected?.['sku']).toBe(s.a);
  });

  it('OBS-01 a linha da recusa por falta de estoque leva só reason e sku além dos campos comuns, sem o corpo nem a Idempotency-Key', async () => {
    const s = skuSet();
    await seed([{ sku: s.a, priceCents: 1000, onHand: 0 }]);
    const correlationId = newCorrelationId();
    const key = newKey();

    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(line({ sku: s.a, priceCents: 1000 }, 4)),
      { requestId: correlationId, key },
    );

    expect(res.status).toBe(409);
    const [rejected] = await linesOf(REJECTED, correlationId);
    expect(rejected?.['sku']).toBe(s.a);
    expectOnlyKeys(rejected ?? {}, ['reason', 'sku']);
    const text = JSON.stringify(rejected);
    expect(text).not.toContain(key);
    expect(text).not.toContain('expectedUnitPrice');
  });

  it('OBS-01 depois da recusa com sku no log, o /metrics da API não ganha rótulo sku nem skus, nem o valor de SKU nenhum', async () => {
    const s = skuSet();
    await seed([
      { sku: s.a, priceCents: 1000, onHand: 0 },
      { sku: s.b, priceCents: 1000, onHand: 5 },
    ]);
    const correlationId = newCorrelationId();
    const stale = await postCheckout(
      suite.harness.server,
      checkoutBody(line({ sku: s.b, priceCents: 1000 }, 1, 900)),
      { requestId: `${correlationId}-price` },
    );
    expect(stale.status).toBe(409);
    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(line({ sku: s.a, priceCents: 1000 })),
      { requestId: correlationId },
    );
    expect(res.status).toBe(409);
    // O sku saiu no log (a prova de que o fluxo o conhece) e mesmo assim não chegou à métrica.
    const [rejected] = await linesOf(REJECTED, correlationId);
    expect(rejected?.['sku']).toBe(s.a);
    const [changed] = await linesOf(PRICE_CHANGED, `${correlationId}-price`);
    expect(stringList(changed?.['skus'])).toEqual([s.b]);

    await expectNoSkuInMetrics(suite.harness.telemetry, usedSkus);
  });
});

describe('OBS-01 as outras recusas do checkout não levam sku', () => {
  async function refuseAndRead(
    body: unknown,
    expectedStatus: number,
    reason: string,
  ): Promise<LogLine> {
    const correlationId = newCorrelationId();
    const res = await postCheckout(suite.harness.server, body, {
      requestId: correlationId,
    });
    expect(res.status).toBe(expectedStatus);
    const [rejected] = await linesOf(REJECTED, correlationId);
    expect(rejected?.['reason']).toBe(reason);
    return rejected ?? {};
  }

  it('OBS-01 unknown_sku: o checkout.rejected tem a causa e nenhum sku nem skus, com o SKU fantasma no corpo', async () => {
    const s = skuSet();
    await seed([{ sku: s.a, priceCents: 1000, onHand: 5 }]);
    const ghost = `GHOST-${randomUUID().slice(0, 8)}`;
    usedSkus.push(ghost);

    const rejected = await refuseAndRead(
      checkoutBody(
        line({ sku: s.a, priceCents: 1000 }),
        line({ sku: ghost, priceCents: 100 }),
      ),
      422,
      'unknown_sku',
    );

    expect(rejected).not.toHaveProperty('sku');
    expect(rejected).not.toHaveProperty('skus');
    expectOnlyKeys(rejected, ['reason']);
  });

  it('OBS-01 duplicate_sku: o checkout.rejected tem a causa e nenhum sku nem skus', async () => {
    const s = skuSet();
    await seed([{ sku: s.a, priceCents: 1000, onHand: 5 }]);
    const item = line({ sku: s.a, priceCents: 1000 });

    const rejected = await refuseAndRead(
      checkoutBody(item, item),
      400,
      'duplicate_sku',
    );

    expect(rejected).not.toHaveProperty('sku');
    expect(rejected).not.toHaveProperty('skus');
    expectOnlyKeys(rejected, ['reason']);
  });

  it('OBS-01 invalid_request: o checkout.rejected tem a causa e nenhum sku nem skus, mesmo com SKU válido no corpo', async () => {
    const s = skuSet();
    await seed([{ sku: s.a, priceCents: 1000, onHand: 5 }]);

    const rejected = await refuseAndRead(
      { items: [{ sku: s.a, quantity: 1 }] },
      400,
      'invalid_request',
    );

    expect(rejected).not.toHaveProperty('sku');
    expect(rejected).not.toHaveProperty('skus');
    expectOnlyKeys(rejected, ['reason']);
  });

  it('OBS-01 price_changed: o checkout.rejected com essa causa não leva sku nem skus (a lista vai no evento próprio do preço)', async () => {
    const s = skuSet();
    await seed([{ sku: s.a, priceCents: 1000, onHand: 5 }]);

    const rejected = await refuseAndRead(
      checkoutBody(line({ sku: s.a, priceCents: 1000 }, 1, 900)),
      409,
      'price_changed',
    );

    expect(rejected).not.toHaveProperty('sku');
    expect(rejected).not.toHaveProperty('skus');
  });
});

describe('OBS-01 checkout.price_changed leva a lista skus dos itens cujo preço mudou', () => {
  it('OBS-01 com três itens e dois de preço alterado, o skus traz esses dois e só eles, e o items continua a contagem', async () => {
    const s = skuSet();
    await seed([
      { sku: s.a, priceCents: 1000, onHand: 5 },
      { sku: s.b, priceCents: 2000, onHand: 5 },
      { sku: s.c, priceCents: 3000, onHand: 5 },
    ]);
    const correlationId = newCorrelationId();
    const key = newKey();

    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(
        line({ sku: s.a, priceCents: 1000 }, 1, 900),
        line({ sku: s.b, priceCents: 2000 }, 1, 2000),
        line({ sku: s.c, priceCents: 3000 }, 2, 3100),
      ),
      { requestId: correlationId, key },
    );

    expect(res.status).toBe(409);
    expect(res.body).not.toHaveProperty('skus');
    const [changed] = await linesOf(PRICE_CHANGED, correlationId);
    expect(changed?.['level']).toBe('warn');
    expect(changed?.['reason']).toBe('price_changed');
    expect(changed?.['items']).toBe(2);
    expect(stringList(changed?.['skus']).sort()).toEqual([s.a, s.c]);
    expect(changed).not.toHaveProperty('sku');
    expectOnlyKeys(changed ?? {}, ['reason', 'items', 'skus']);
    const text = JSON.stringify(changed);
    expect(text).not.toContain(key);
    expect(text).not.toContain('expectedUnitPrice');
  });

  it('OBS-01 com um item só de preço alterado entre dois, o skus tem uma entrada, o SKU que mudou', async () => {
    const s = skuSet();
    await seed([
      { sku: s.a, priceCents: 1000, onHand: 5 },
      { sku: s.b, priceCents: 2000, onHand: 5 },
    ]);
    const correlationId = newCorrelationId();

    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(
        line({ sku: s.a, priceCents: 1000 }),
        line({ sku: s.b, priceCents: 2000 }, 1, 1500),
      ),
      { requestId: correlationId },
    );

    expect(res.status).toBe(409);
    const [changed] = await linesOf(PRICE_CHANGED, correlationId);
    expect(changed?.['items']).toBe(1);
    expect(stringList(changed?.['skus'])).toEqual([s.b]);
  });

  it('OBS-01 a lista skus de um pedido de 20 itens com todos os preços alterados tem 20 entradas, no máximo do pedido', async () => {
    const id = randomUUID().slice(0, 8);
    const skus = Array.from(
      { length: 20 },
      (_, index) => `P${String(index).padStart(2, '0')}-${id}`,
    );
    usedSkus.push(...skus);
    await seed(skus.map((sku) => ({ sku, priceCents: 1000, onHand: 5 })));
    const correlationId = newCorrelationId();

    const res = await postCheckout(
      suite.harness.server,
      checkoutBody(
        ...skus.map((sku) => line({ sku, priceCents: 1000 }, 1, 999)),
      ),
      { requestId: correlationId },
    );

    expect(res.status).toBe(409);
    const [changed] = await linesOf(PRICE_CHANGED, correlationId);
    expect(changed?.['items']).toBe(20);
    expect(stringList(changed?.['skus']).sort()).toEqual(skus);
  });
});
