import { randomUUID } from 'node:crypto';
import { SpanKind } from '@opentelemetry/api';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CheckoutAccepted,
  checkoutRoute,
  MAX_BODY_BYTES,
  PROBLEM_MEDIA_TYPE,
  Problem,
} from '../../../src/contract/index.ts';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import {
  checkoutBody,
  countKeyRows,
  countOrdersWithSku,
  footprint,
  header,
  line,
  mediaTypeOf,
  newKey,
  postCheckout,
  readInventory,
  seedProduct,
  startCheckoutHarness,
  type CheckoutHarness,
  type SeededProduct,
} from '../../helpers/checkout.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let database: TestDatabase;
let harness: CheckoutHarness;

beforeAll(async () => {
  database = await startMigratedDatabase();
  harness = await startCheckoutHarness(database);
}, 120_000);

afterAll(async () => {
  await harness?.close();
  await database?.stop();
});

beforeEach(async () => {
  await harness.telemetry.forceFlush();
  harness.exporter.reset();
});

function product(priceCents = 1990, onHand = 10): Promise<SeededProduct> {
  return seedProduct(database.pool, { priceCents, onHand });
}

function problemOf(res: request.Response): Problem {
  return Problem.parse(res.body);
}

describe('CHK-09 resposta 202', () => {
  it('CHK-09 o 202 traz orderId, status pending e o total em centavos igual à soma de quantity x price_cents, mais Location, Retry-After 4 e X-Request-Id', async () => {
    const first = await product(1990, 10);
    const second = await product(4500, 10);
    const requestId = `chk09-${randomUUID()}`;

    const res = await postCheckout(
      harness.server,
      checkoutBody(line(first, 2), line(second, 3)),
      { requestId },
    );

    expect(res.status).toBe(202);
    expect(mediaTypeOf(res)).toBe('application/json');
    const body = CheckoutAccepted.parse(res.body);
    expect(body.orderId).toMatch(UUID);
    expect(body.status).toBe('pending');
    const sum = await database.pool.query<{ total: number }>(
      `select sum(i.quantity * p.price_cents)::int as total
         from order_items i join products p on p.sku = i.sku where i.order_id = $1`,
      [body.orderId],
    );
    expect(sum.rows[0]?.total).toBe(2 * 1990 + 3 * 4500);
    expect(body.total).toBe(sum.rows[0]?.total);
    expect(header(res, 'location')).toBe(`/orders/${body.orderId}/status`);
    expect(header(res, 'retry-after')).toBe('4');
    expect(header(res, 'x-request-id')).toBe(requestId);
  });

  it('CHK-09 o preço de cada item é o do banco, gravado no pedido', async () => {
    const item = await product(1990, 10);

    const res = await postCheckout(harness.server, checkoutBody(line(item, 2)));

    expect(res.status).toBe(202);
    const { orderId } = CheckoutAccepted.parse(res.body);
    const rows = await database.pool.query<{
      sku: string;
      quantity: number;
      unit_price_cents: number;
    }>(
      'select sku, quantity, unit_price_cents from order_items where order_id = $1',
      [orderId],
    );
    expect(rows.rows).toEqual([
      { sku: item.sku, quantity: 2, unit_price_cents: 1990 },
    ]);
  });

  it('CHK-09 sem X-Request-Id a API gera um UUID e o devolve no 202', async () => {
    const item = await product();

    const res = await postCheckout(harness.server, checkoutBody(line(item)));

    expect(res.status).toBe(202);
    expect(header(res, 'x-request-id')).toMatch(UUID);
  });

  it('CHK-09 a repetição com a mesma chave traz os mesmos cabeçalhos e o status atual (invoiced depois de o pedido ser faturado)', async () => {
    const item = await product(1000, 10);
    const key = newKey();
    const body = checkoutBody(line(item, 2));

    const first = await postCheckout(harness.server, body, { key });
    expect(first.status).toBe(202);
    const created = CheckoutAccepted.parse(first.body);
    expect(created.status).toBe('pending');

    await database.pool.query(
      "update orders set status = 'invoiced', outcome_at = now() where id = $1",
      [created.orderId],
    );
    const replayRequestId = `chk09-replay-${randomUUID()}`;
    const replay = await postCheckout(harness.server, body, {
      key,
      requestId: replayRequestId,
    });

    expect(replay.status).toBe(202);
    const replayed = CheckoutAccepted.parse(replay.body);
    expect(replayed).toEqual({
      orderId: created.orderId,
      status: 'invoiced',
      total: 2000,
    });
    expect(header(replay, 'location')).toBe(
      `/orders/${created.orderId}/status`,
    );
    expect(header(replay, 'location')).toBe(header(first, 'location'));
    expect(header(replay, 'retry-after')).toBe('4');
    expect(header(replay, 'x-request-id')).toBe(replayRequestId);
    expect((await readInventory(database.pool, item.sku)).reserved).toBe(2);
  });
});

describe('CHK-04 repetição depois de o estoque acabar', () => {
  it('CHK-04 a mesma chave repetida depois de outro pedido levar a última unidade devolve o pedido original com 202, e não 409', async () => {
    const item = await product(1000, 2);
    const keyA = newKey();
    const body = checkoutBody(line(item));

    const original = await postCheckout(harness.server, body, { key: keyA });
    const other = await postCheckout(harness.server, body, { key: newKey() });
    const soldOut = await postCheckout(harness.server, body, { key: newKey() });
    expect(original.status).toBe(202);
    expect(other.status).toBe(202);
    expect(soldOut.status).toBe(409);
    expect(problemOf(soldOut).type).toBe('/problems/out-of-stock');

    const replay = await postCheckout(harness.server, body, { key: keyA });

    expect(replay.status).toBe(202);
    expect(CheckoutAccepted.parse(replay.body).orderId).toBe(
      CheckoutAccepted.parse(original.body).orderId,
    );
    expect(header(replay, 'location')).toBe(header(original, 'location'));
    const inventory = await readInventory(database.pool, item.sku);
    expect(inventory.reserved).toBe(2);
    expect(await countOrdersWithSku(database.pool, item.sku)).toBe(2);
  });
});

describe('CHK-05 o mesmo pedido escrito de outro jeito', () => {
  it('CHK-05 itens em outra ordem ou chaves do objeto em outra ordem, com a mesma chave, devolvem o mesmo pedido, e não 422', async () => {
    const a = await product(1000, 10);
    const b = await product(2000, 10);
    const key = newKey();
    const itemA = { sku: a.sku, quantity: 2, expectedUnitPrice: a.priceCents };
    const itemB = { sku: b.sku, quantity: 1, expectedUnitPrice: b.priceCents };
    // As chaves do objeto em ordem diferente: o JSON preserva a ordem de inserção.
    const reorderedA = {
      expectedUnitPrice: a.priceCents,
      quantity: 2,
      sku: a.sku,
    };
    const reorderedB = {
      quantity: 1,
      sku: b.sku,
      expectedUnitPrice: b.priceCents,
    };

    const original = await postCheckout(
      harness.server,
      { items: [itemA, itemB] },
      { key },
    );
    expect(original.status).toBe(202);
    const orderId = CheckoutAccepted.parse(original.body).orderId;

    const variants: [string, unknown][] = [
      ['itens em outra ordem', { items: [itemB, itemA] }],
      ['chaves do objeto em outra ordem', { items: [reorderedA, reorderedB] }],
      ['itens e chaves em outra ordem', { items: [reorderedB, reorderedA] }],
    ];
    for (const [label, body] of variants) {
      const res = await postCheckout(harness.server, body, { key });
      expect(res.status, label).toBe(202);
      expect(CheckoutAccepted.parse(res.body).orderId, label).toBe(orderId);
    }

    expect((await readInventory(database.pool, a.sku)).reserved).toBe(2);
    expect((await readInventory(database.pool, b.sku)).reserved).toBe(1);
    expect(await countOrdersWithSku(database.pool, a.sku)).toBe(1);
  });
});

describe('CHK-06 preço alterado', () => {
  it('CHK-06 expectedUnitPrice diferente do banco recebe 409 price-changed com o preço atual só do item que mudou, e nada é reservado', async () => {
    const changed = await product(1000, 10);
    const same = await product(500, 10);
    const key = newKey();
    const before = await footprint(database.pool);

    const res = await postCheckout(
      harness.server,
      checkoutBody(line(changed, 1, 900), line(same, 1)),
      { key },
    );

    expect(res.status).toBe(409);
    expect(mediaTypeOf(res)).toBe(PROBLEM_MEDIA_TYPE);
    const problem = problemOf(res);
    expect(problem.type).toBe('/problems/price-changed');
    expect(problem.currentPrices).toEqual([
      { sku: changed.sku, unitPrice: 1000 },
    ]);
    expect(await footprint(database.pool)).toEqual(before);
    expect(await countKeyRows(database.pool, key)).toBe(0);
    expect((await readInventory(database.pool, changed.sku)).reserved).toBe(0);
    expect((await readInventory(database.pool, same.sku)).reserved).toBe(0);

    // A chave foi desfeita junto: o cliente confirma o preço novo com a mesma chave e é aceito.
    const confirmed = await postCheckout(
      harness.server,
      checkoutBody(line(changed, 1, 1000), line(same, 1)),
      { key },
    );
    expect(confirmed.status).toBe(202);
  });

  it('CHK-06 com mais de um item alterado, currentPrices traz o preço atual de cada um', async () => {
    const first = await product(1000, 10);
    const second = await product(2500, 10);

    const res = await postCheckout(
      harness.server,
      checkoutBody(line(first, 1, 1100), line(second, 2, 2400)),
    );

    expect(res.status).toBe(409);
    const problem = problemOf(res);
    expect(problem.type).toBe('/problems/price-changed');
    expect(problem.currentPrices).toHaveLength(2);
    expect(problem.currentPrices).toEqual(
      expect.arrayContaining([
        { sku: first.sku, unitPrice: 1000 },
        { sku: second.sku, unitPrice: 2500 },
      ]),
    );
  });
});

describe('CHK-10 entradas recusadas, cada causa com o seu type', () => {
  // Em nenhum caso de erro o banco fica com pedido, reserva ou chave.
  async function expectRefused(
    send: () => Promise<request.Response>,
    expected: { status: number; type: string; key?: string },
  ) {
    const before = await footprint(database.pool);
    const res = await send();
    expect(res.status).toBe(expected.status);
    expect(mediaTypeOf(res)).toBe(PROBLEM_MEDIA_TYPE);
    const problem = problemOf(res);
    expect(problem.type).toBe(expected.type);
    expect(problem.status).toBe(expected.status);
    expect(problem.correlationId).toBe(header(res, 'x-request-id'));
    expect(await footprint(database.pool)).toEqual(before);
    expect(
      expected.key === undefined
        ? 0
        : await countKeyRows(database.pool, expected.key),
    ).toBe(0);
    return problem;
  }

  it('CHK-10 sem Idempotency-Key: 400 idempotency-key-required', async () => {
    const item = await product();
    await expectRefused(
      () =>
        postCheckout(harness.server, checkoutBody(line(item)), { key: null }),
      {
        status: 400,
        type: '/problems/idempotency-key-required',
      },
    );
  });

  it('CHK-10 o mesmo SKU duas vezes: 400 duplicate-sku', async () => {
    const item = await product();
    const key = newKey();
    await expectRefused(
      () =>
        postCheckout(
          harness.server,
          checkoutBody(line(item, 1), line(item, 2)),
          { key },
        ),
      {
        status: 400,
        type: '/problems/duplicate-sku',
        key,
      },
    );
  });

  it('CHK-10 item sem expectedUnitPrice: 400 invalid-request com o caminho em errors', async () => {
    const item = await product();
    const key = newKey();
    const problem = await expectRefused(
      () =>
        postCheckout(
          harness.server,
          { items: [{ sku: item.sku, quantity: 1 }] },
          { key },
        ),
      { status: 400, type: '/problems/invalid-request', key },
    );
    expect(problem.errors?.map((error) => error.path)).toContain(
      'body.items.0.expectedUnitPrice',
    );
  });

  const sku = (n: number) => `INVALID-${n}`;
  const valid = { sku: 'INVALID-0', quantity: 1, expectedUnitPrice: 1000 };
  const invalidCases: [string, unknown, string][] = [
    [
      'quantidade 0',
      { items: [{ ...valid, quantity: 0 }] },
      'body.items.0.quantity',
    ],
    [
      'quantidade 11',
      { items: [{ ...valid, quantity: 11 }] },
      'body.items.0.quantity',
    ],
    [
      '21 itens',
      {
        items: Array.from({ length: 21 }, (_, n) => ({
          ...valid,
          sku: sku(n),
        })),
      },
      'body.items',
    ],
    ['lista vazia', { items: [] }, 'body.items'],
    ['campo a mais no corpo', { items: [valid], extra: true }, 'body.extra'],
    [
      'campo a mais no item',
      { items: [{ ...valid, extra: true }] },
      'body.items.0.extra',
    ],
    [
      'SKU fora do formato',
      { items: [{ ...valid, sku: 'sku com espaço!' }] },
      'body.items.0.sku',
    ],
    [
      'SKU com mais de 64 caracteres',
      { items: [{ ...valid, sku: 'S'.repeat(65) }] },
      'body.items.0.sku',
    ],
    [
      'expectedUnitPrice fracionário',
      { items: [{ ...valid, expectedUnitPrice: 19.9 }] },
      'body.items.0.expectedUnitPrice',
    ],
    ['corpo sem items', {}, 'body.items'],
  ];
  it.each(invalidCases)(
    'CHK-10 entrada inválida (%s): 400 invalid-request',
    async (_label, body, path) => {
      const key = newKey();
      const problem = await expectRefused(
        () => postCheckout(harness.server, body, { key }),
        {
          status: 400,
          type: '/problems/invalid-request',
          key,
        },
      );
      expect(problem.errors?.length ?? 0).toBeGreaterThan(0);
      expect(problem.errors?.map((error) => error.path)).toContain(path);
    },
  );

  it('CHK-10 Idempotency-Key com mais de 128 caracteres: 400 invalid-request', async () => {
    const item = await product();
    const key = 'k'.repeat(129);
    const problem = await expectRefused(
      () => postCheckout(harness.server, checkoutBody(line(item)), { key }),
      {
        status: 400,
        type: '/problems/invalid-request',
        key,
      },
    );
    expect(problem.errors?.length ?? 0).toBeGreaterThan(0);
  });

  it('CHK-10 corpo acima de 16 KiB: 413 payload-too-large', async () => {
    const item = await product();
    const key = newKey();
    const oversized = {
      ...checkoutBody(line(item)),
      padding: 'x'.repeat(MAX_BODY_BYTES),
    };
    expect(JSON.stringify(oversized).length).toBeGreaterThan(MAX_BODY_BYTES);
    await expectRefused(
      () => postCheckout(harness.server, oversized, { key }),
      { status: 413, type: '/problems/payload-too-large', key },
    );
  });

  it('CHK-10 Content-Type text/plain: 415 unsupported-media-type', async () => {
    const item = await product();
    const key = newKey();
    await expectRefused(
      () =>
        postCheckout(harness.server, JSON.stringify(checkoutBody(line(item))), {
          key,
          contentType: 'text/plain',
        }),
      { status: 415, type: '/problems/unsupported-media-type', key },
    );
  });

  it('CHK-10 sem Content-Type, com corpo JSON válido: 415 unsupported-media-type', async () => {
    const item = await product();
    const key = newKey();
    // Um Buffer não ganha tipo do supertest (uma string ganharia application/x-www-form-urlencoded).
    const payload = Buffer.from(JSON.stringify(checkoutBody(line(item))));
    await expectRefused(
      async () => {
        const res = await postCheckout(harness.server, payload, { key });
        // A premissa do teste: a requisição saiu mesmo sem o cabeçalho.
        const sent = res as unknown as {
          req: { getHeader(name: string): unknown };
        };
        expect(sent.req.getHeader('content-type')).toBeUndefined();
        return res;
      },
      { status: 415, type: '/problems/unsupported-media-type', key },
    );
  });

  it('CHK-10 a mesma chave com outro corpo: 422 idempotency-key-reused, e o primeiro pedido segue intacto', async () => {
    const item = await product(1000, 10);
    const key = newKey();
    const first = await postCheckout(
      harness.server,
      checkoutBody(line(item, 1)),
      { key },
    );
    expect(first.status).toBe(202);

    await expectRefused(
      () => postCheckout(harness.server, checkoutBody(line(item, 2)), { key }),
      {
        status: 422,
        type: '/problems/idempotency-key-reused',
      },
    );

    expect(await countKeyRows(database.pool, key)).toBe(1);
    expect((await readInventory(database.pool, item.sku)).reserved).toBe(1);
    expect(await countOrdersWithSku(database.pool, item.sku)).toBe(1);
  });

  it('CHK-10 SKU que não existe em products: 422 unknown-sku, sem reservar o outro item do pedido', async () => {
    const known = await product(1000, 10);
    const key = newKey();
    const ghost = { sku: `GHOST-${randomUUID().slice(0, 8)}`, priceCents: 100 };

    await expectRefused(
      () =>
        postCheckout(harness.server, checkoutBody(line(known), line(ghost)), {
          key,
        }),
      {
        status: 422,
        type: '/problems/unknown-sku',
        key,
      },
    );

    expect((await readInventory(database.pool, known.sku)).reserved).toBe(0);
  });

  it('CHK-10 sem estoque: 409 out-of-stock, sem pedido, reserva nem chave', async () => {
    const empty = await product(1000, 0);
    const key = newKey();
    await expectRefused(
      () => postCheckout(harness.server, checkoutBody(line(empty)), { key }),
      {
        status: 409,
        type: '/problems/out-of-stock',
        key,
      },
    );
  });
});

describe('FND-07 o contrato do POST /checkout cobre cada resposta', () => {
  it('FND-07 o 202 e cada causa de erro saem com um status declarado na rota e em application/problem+json', async () => {
    const item = await product(1000, 1);
    const ghost = { sku: `GHOST-${randomUUID().slice(0, 8)}`, priceCents: 100 };
    const key = newKey();
    const responses: [number, request.Response][] = [
      [
        202,
        await postCheckout(harness.server, checkoutBody(line(item)), { key }),
      ],
      [
        400,
        await postCheckout(harness.server, checkoutBody(line(item)), {
          key: null,
        }),
      ],
      [409, await postCheckout(harness.server, checkoutBody(line(item)))],
      [
        413,
        await postCheckout(harness.server, {
          ...checkoutBody(line(item)),
          padding: 'x'.repeat(MAX_BODY_BYTES),
        }),
      ],
      [
        415,
        await postCheckout(
          harness.server,
          JSON.stringify(checkoutBody(line(item))),
          { contentType: 'text/plain' },
        ),
      ],
      [422, await postCheckout(harness.server, checkoutBody(line(ghost)))],
    ];

    expect(responses.map(([, res]) => res.status)).toEqual(
      responses.map(([status]) => status),
    );
    // O status vem declarado de forma explícita na rota, e não pelo default.
    expect(
      responses
        .map(([status]) => String(status))
        .filter((status) => !(status in checkoutRoute.responses)),
    ).toEqual([]);
    expect(
      responses
        .filter(([status]) => status !== 202)
        .map(([, res]) => mediaTypeOf(res)),
    ).toEqual(Array.from({ length: 5 }, () => PROBLEM_MEDIA_TYPE));
  });
});

describe('CHK-12 o trace chega à linha da outbox', () => {
  async function outboxRow(orderId: string) {
    const result = await database.pool.query<{
      traceparent: string | null;
      correlation_id: string;
      published_at: Date | null;
    }>(
      'select traceparent, correlation_id, published_at from outbox where order_id = $1',
      [orderId],
    );
    return result.rows[0];
  }

  async function serverSpan() {
    await harness.telemetry.forceFlush();
    return harness.exporter
      .getFinishedSpans()
      .find(
        (span) =>
          span.kind === SpanKind.SERVER &&
          span.attributes['http.route'] === '/checkout',
      );
  }

  it('CHK-12 o traceparent da outbox tem o trace id do span SERVER da requisição, e o correlation_id é o X-Request-Id', async () => {
    const item = await product();
    const requestId = `chk12-${randomUUID()}`;

    const res = await postCheckout(harness.server, checkoutBody(line(item)), {
      requestId,
    });

    expect(res.status).toBe(202);
    const row = await outboxRow(CheckoutAccepted.parse(res.body).orderId);
    // A linha nasce não publicada: o relay a publica no SQS depois do commit do checkout.
    expect(row?.published_at).toBeNull();
    expect(row?.correlation_id).toBe(requestId);
    expect(row?.correlation_id).toBe(header(res, 'x-request-id'));
    expect(row?.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
    const span = await serverSpan();
    expect(span, 'span SERVER do checkout ausente').toBeDefined();
    expect(row?.traceparent?.split('-')[1]).toBe(span?.spanContext().traceId);
  });

  it('CHK-12 com um traceparent de entrada, a outbox continua o mesmo trace', async () => {
    const item = await product();
    const traceId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const traceparent = `00-${traceId}-1122334455667788-01`;

    const res = await postCheckout(harness.server, checkoutBody(line(item)), {
      traceparent,
    });

    expect(res.status).toBe(202);
    const row = await outboxRow(CheckoutAccepted.parse(res.body).orderId);
    expect(row?.traceparent?.split('-')[1]).toBe(traceId);
    const span = await serverSpan();
    expect(span?.spanContext().traceId).toBe(traceId);
  });
});

describe('OBS-01 orderId e causa nos logs do checkout', () => {
  it('OBS-01 o checkout.accepted (info) e o http_request do 202 trazem o orderId, na aceitação e na repetição', async () => {
    const item = await product();
    const key = newKey();
    const firstId = `obs01-a-${randomUUID()}`;
    const replayId = `obs01-r-${randomUUID()}`;

    const first = await postCheckout(harness.server, checkoutBody(line(item)), {
      key,
      requestId: firstId,
    });
    const replay = await postCheckout(
      harness.server,
      checkoutBody(line(item)),
      { key, requestId: replayId },
    );
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    const { orderId } = CheckoutAccepted.parse(first.body);

    await vi.waitFor(
      () => {
        const accepted = harness.logLines.find(
          (entry) =>
            entry['event'] === 'checkout.accepted' &&
            entry['correlationId'] === firstId,
        );
        expect(accepted, 'checkout.accepted ausente').toBeDefined();
        expect(accepted?.['level']).toBe('info');
        expect(accepted?.['orderId']).toBe(orderId);
        for (const correlationId of [firstId, replayId]) {
          const http = harness.logLines.find(
            (entry) =>
              entry['event'] === 'http_request' &&
              entry['correlationId'] === correlationId,
          );
          expect(
            http,
            `http_request de ${correlationId} ausente`,
          ).toBeDefined();
          expect(http?.['status']).toBe(202);
          expect(http?.['route']).toBe('/checkout');
          expect(http?.['orderId']).toBe(orderId);
        }
      },
      { timeout: WAIT_GUARD_MS },
    );
  });

  it('OBS-01 o checkout.rejected (warn) traz a causa da recusa por falta de estoque', async () => {
    const empty = await product(1000, 0);
    const correlationId = `obs01-oos-${randomUUID()}`;

    const res = await postCheckout(harness.server, checkoutBody(line(empty)), {
      requestId: correlationId,
    });
    expect(res.status).toBe(409);

    await vi.waitFor(
      () => {
        const rejected = harness.logLines.find(
          (entry) =>
            entry['event'] === 'checkout.rejected' &&
            entry['correlationId'] === correlationId,
        );
        expect(rejected, 'checkout.rejected ausente').toBeDefined();
        expect(rejected?.['level']).toBe('warn');
        // O nome do campo da causa é do implementer; o valor é a causa do type do problema.
        const { msg: _msg, time: _time, ...fields } = rejected ?? {};
        expect(JSON.stringify(fields)).toMatch(/out[-_]of[-_]stock/);
      },
      { timeout: WAIT_GUARD_MS },
    );
  });

  it('OBS-01 o preço alterado deixa um log de nível warn (checkout.price_changed ou checkout.rejected) com a causa', async () => {
    const item = await product(1000, 5);
    const correlationId = `obs01-price-${randomUUID()}`;

    const res = await postCheckout(
      harness.server,
      checkoutBody(line(item, 1, 900)),
      { requestId: correlationId },
    );
    expect(res.status).toBe(409);

    await vi.waitFor(
      () => {
        const entry = harness.logLines.find(
          (candidate) =>
            candidate['correlationId'] === correlationId &&
            (candidate['event'] === 'checkout.price_changed' ||
              candidate['event'] === 'checkout.rejected'),
        );
        expect(entry, 'log de preço alterado ausente').toBeDefined();
        expect(entry?.['level']).toBe('warn');
      },
      { timeout: WAIT_GUARD_MS },
    );
  });
});

describe('OBS-02 counter de desfecho do checkout', () => {
  // Lê o /metrics e junta, por valor do label outcome, as amostras de métricas com prefixo checkout.
  async function checkoutOutcomes(app: CheckoutHarness['app']) {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    const text = res.text;
    const outcomes = new Map<string, number>();
    const labelNames = new Set<string>();
    for (const sample of text.split('\n')) {
      const match = /^(checkout\w*)\{([^}]*)\}\s+(\S+)$/.exec(sample);
      if (!match) continue;
      const labels = new Map<string, string>();
      for (const pair of (match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g))
        labels.set(pair[1] ?? '', pair[2] ?? '');
      for (const name of labels.keys()) labelNames.add(name);
      const outcome = labels.get('outcome');
      if (outcome !== undefined)
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + Number(match[3]));
    }
    return { outcomes, labelNames, text };
  }

  it('OBS-02 aceite, repetição, falta de estoque, preço alterado e entrada inválida aparecem no label outcome, sem orderId nem sku', async () => {
    // App próprio, com telemetria nova: os contadores começam em zero e o teste conta exato.
    const own = await startCheckoutHarness(database);
    try {
      const item = await product(1000, 5);
      const empty = await product(1000, 0);
      const key = newKey();

      const accepted = await postCheckout(
        own.server,
        checkoutBody(line(item)),
        { key },
      );
      const replay = await postCheckout(own.server, checkoutBody(line(item)), {
        key,
      });
      const outOfStock = await postCheckout(
        own.server,
        checkoutBody(line(empty)),
      );
      const priceChanged = await postCheckout(
        own.server,
        checkoutBody(line(item, 1, 900)),
      );
      const invalid = await postCheckout(
        own.server,
        checkoutBody(line(item, 0)),
      );
      expect([
        accepted.status,
        replay.status,
        outOfStock.status,
        priceChanged.status,
        invalid.status,
      ]).toEqual([202, 202, 409, 409, 400]);

      await vi.waitFor(
        async () => {
          const { outcomes } = await checkoutOutcomes(own.app);
          for (const outcome of [
            'accepted',
            'replay',
            'out_of_stock',
            'price_changed',
            'invalid',
          ]) {
            expect(
              outcomes.get(outcome) ?? 0,
              `outcome ${outcome}`,
            ).toBeGreaterThanOrEqual(1);
          }
          // Os desfechos de uma só ocorrência contam exatamente uma vez.
          expect(outcomes.get('out_of_stock')).toBe(1);
          expect(outcomes.get('price_changed')).toBe(1);
          expect(outcomes.get('invalid')).toBe(1);
        },
        { timeout: WAIT_GUARD_MS },
      );

      const { labelNames, text } = await checkoutOutcomes(own.app);
      expect(labelNames.has('outcome')).toBe(true);
      for (const name of labelNames) expect(name).not.toMatch(/order|sku/i);
      const { orderId } = CheckoutAccepted.parse(accepted.body);
      expect(text).not.toContain(orderId);
      expect(text).not.toContain(item.sku);
      expect(text).not.toContain(empty.sku);
    } finally {
      await own.close();
    }
  });

  it('OBS-02 o banco indisponível no checkout (503 service-unavailable) soma 1 em outcome="unavailable" e em nenhum outro desfecho', async () => {
    // App próprio, com telemetria nova: os contadores começam em zero e o teste conta exato.
    const own = await startCheckoutHarness(database);
    try {
      const item = await product(1000, 5);
      // Só o erro entra, no limite do pool: a conexão recusada que o banco parado produziria.
      let injected = 0;
      (own.pool as unknown as { connect: () => Promise<never> }).connect =
        () => {
          injected += 1;
          return Promise.reject(
            Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
              code: 'ECONNREFUSED',
            }),
          );
        };

      const res = await postCheckout(own.server, checkoutBody(line(item)));

      expect(injected).toBeGreaterThanOrEqual(1);
      expect(res.status).toBe(503);
      expect(problemOf(res).type).toBe('/problems/service-unavailable');
      expect(header(res, 'retry-after')).toBe('5');

      await vi.waitFor(
        async () => {
          const { outcomes } = await checkoutOutcomes(own.app);
          expect(outcomes.get('unavailable')).toBe(1);
          // Nenhum outro desfecho foi contado: só há a série unavailable.
          expect([...outcomes.keys()]).toEqual(['unavailable']);
        },
        { timeout: WAIT_GUARD_MS },
      );
    } finally {
      await own.close();
    }
  });
});
