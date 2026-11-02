import { describe, expect, it } from 'vitest';
import { productsRoute, Problem } from '../../../src/contract/index.ts';
import {
  markSynced,
  seedCatalog,
  skuRange,
  useCatalogDatabase,
} from '../../helpers/catalog.ts';

// A rota GET /products contra o PostgreSQL real, pelo createApp (AD-005). Cada teste zera o catálogo, semeia o
// que usa e monta a própria vitrine, de cache vazio e de relógio manual.

const database = useCatalogDatabase();
const start = () => database.start();

function items(body: unknown): unknown[] {
  return (body as { items: unknown[] }).items;
}

function skus(body: unknown): string[] {
  return (body as { items: { sku: string }[] }).items.map((item) => item.sku);
}

describe('CAT-13 GET /products devolve os produtos sincronizados', () => {
  it('CAT-13 cada produto traz SKU, nome, preço em centavos e a faixa de disponibilidade, em { items, hasNext } e em ordem de SKU', async () => {
    await seedCatalog(database.pool, [
      { sku: 'CAPA-B', name: 'Capa B', priceCents: 5990, onHand: 20 },
      { sku: 'CAPA-A', name: 'Capa A', priceCents: 4990, onHand: 3 },
      { sku: 'CAPA-C', name: 'Capa C', priceCents: 0, onHand: 4, reserved: 4 },
    ]);
    await markSynced(database.pool);
    const app = await start();

    const res = await app.get();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      items: [
        {
          sku: 'CAPA-A',
          name: 'Capa A',
          unitPrice: 4990,
          availability: 'low_stock',
        },
        {
          sku: 'CAPA-B',
          name: 'Capa B',
          unitPrice: 5990,
          availability: 'available',
        },
        {
          sku: 'CAPA-C',
          name: 'Capa C',
          unitPrice: 0,
          availability: 'out_of_stock',
        },
      ],
      hasNext: false,
    });
  });

  it('CAT-13 a faixa sai das unidades livres, on_hand menos reserved, sem expor o número', async () => {
    await seedCatalog(database.pool, [
      { sku: 'F-00-FREE-0', onHand: 0, reserved: 0 },
      { sku: 'F-01-RESERVED-ALL', onHand: 7, reserved: 7 },
      { sku: 'F-02-OVERBOOKED', onHand: 2, reserved: 4 },
      { sku: 'F-03-FREE-1', onHand: 6, reserved: 5 },
      { sku: 'F-04-FREE-5', onHand: 8, reserved: 3 },
      { sku: 'F-05-FREE-6', onHand: 8, reserved: 2 },
      { sku: 'F-06-FREE-900', onHand: 900, reserved: 0 },
    ]);
    await markSynced(database.pool);
    const app = await start();

    const res = await app.get();

    const bands = Object.fromEntries(
      (
        res.body as { items: { sku: string; availability: string }[] }
      ).items.map((item) => [item.sku, item.availability]),
    );
    expect(bands).toEqual({
      'F-00-FREE-0': 'out_of_stock',
      'F-01-RESERVED-ALL': 'out_of_stock',
      'F-02-OVERBOOKED': 'out_of_stock',
      'F-03-FREE-1': 'low_stock',
      'F-04-FREE-5': 'low_stock',
      'F-05-FREE-6': 'available',
      'F-06-FREE-900': 'available',
    });
    for (const item of (res.body as { items: object[] }).items) {
      expect(Object.keys(item).sort()).toEqual([
        'availability',
        'name',
        'sku',
        'unitPrice',
      ]);
    }
  });

  it('CAT-13 120 produtos saem em páginas de 50, em ordem de SKU, com hasNext até a última', async () => {
    const all = skuRange('P', 120);
    await seedCatalog(
      database.pool,
      all.map((sku) => ({ sku })),
    );
    await markSynced(database.pool);
    const app = await start();

    const first = await app.get();
    const second = await app.get('?page=2');
    const third = await app.get('?page=3');

    expect(skus(first.body)).toEqual(all.slice(0, 50));
    expect((first.body as { hasNext: boolean }).hasNext).toBe(true);
    expect(skus(second.body)).toEqual(all.slice(50, 100));
    expect((second.body as { hasNext: boolean }).hasNext).toBe(true);
    expect(skus(third.body)).toEqual(all.slice(100));
    expect((third.body as { hasNext: boolean }).hasNext).toBe(false);
  });

  it('CAT-13 sem ?page a resposta é a página 1, e com exatamente 100 produtos a página 2 é cheia e sem próxima', async () => {
    const all = skuRange('P', 100);
    await seedCatalog(
      database.pool,
      all.map((sku) => ({ sku })),
    );
    await markSynced(database.pool);
    const app = await start();

    const withoutPage = await app.get();
    const pageOne = await app.get('?page=1');
    const pageTwo = await app.get('?page=2');

    expect(withoutPage.body).toEqual(pageOne.body);
    expect(items(pageTwo.body)).toHaveLength(50);
    expect(skus(pageTwo.body)).toEqual(all.slice(50));
    expect((pageTwo.body as { hasNext: boolean }).hasNext).toBe(false);
  });

  it('CAT-13 uma página além do fim volta vazia, com hasNext false e status 200', async () => {
    await seedCatalog(
      database.pool,
      skuRange('P', 3).map((sku) => ({ sku })),
    );
    await markSynced(database.pool);
    const app = await start();

    for (const query of ['?page=2', '?page=3', '?page=999999']) {
      const res = await app.get(query);
      expect(res.status, query).toBe(200);
      expect(res.body, query).toEqual({ items: [], hasNext: false });
    }
  });

  it('CAT-13 um catálogo sincronizado e sem produtos devolve a página vazia, e não 503', async () => {
    await markSynced(database.pool);
    const app = await start();

    const res = await app.get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], hasNext: false });
  });

  it.each([
    ['0'],
    ['-1'],
    ['01'],
    ['1.0'],
    ['1e3'],
    ['abc'],
    [''],
    ['1000000'],
    ['%201'],
    ['1%20'],
  ])(
    'CAT-13 ?page=%j recebe 400 invalid-request em problem+json',
    async (page) => {
      const app = await start();

      const res = await app.get(`?page=${page}`);

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
      const problem = Problem.parse(res.body);
      expect(problem.type).toBe('/problems/invalid-request');
      expect(problem.errors?.map((error) => error.path)).toContain(
        'query.page',
      );
    },
  );

  it('CAT-13 um parâmetro desconhecido, ou ?page repetido, recebe 400 invalid-request', async () => {
    const app = await start();

    for (const query of ['?size=10', '?page=1&sort=name', '?page=1&page=2']) {
      const res = await app.get(query);
      expect(res.status, query).toBe(400);
      expect(Problem.parse(res.body).type, query).toBe(
        '/problems/invalid-request',
      );
    }
  });
});

// Um 503 (não sincronizado), depois o catálogo sincronizado e a entrada expirada (200), e um 400.
async function unsyncedThenServed() {
  const app = await start();
  const unsynced = await app.get();
  await seedCatalog(database.pool, [{ sku: 'CAPA-A' }]);
  await markSynced(database.pool);
  app.clock.advance(6_000);
  const ok = await app.get();
  const invalid = await app.get('?page=x');
  return { app, unsynced, ok, invalid };
}

describe('CAT-10 Cache-Control: no-store em toda resposta da rota', () => {
  it('CAT-10 o 200, o 400 e o 503 saem com Cache-Control: no-store', async () => {
    const { app, unsynced, ok, invalid } = await unsyncedThenServed();
    const cached = await app.get();

    expect([unsynced.status, ok.status, cached.status, invalid.status]).toEqual(
      [503, 200, 200, 400],
    );
    for (const res of [unsynced, ok, cached, invalid])
      expect(res.headers['cache-control'], String(res.status)).toBe('no-store');
  });
});

describe('CAT-05 um catálogo ainda não sincronizado responde 503', () => {
  it('CAT-05 com produtos já gravados e sem rodada completa, a resposta é 503 problem+json com Retry-After 5', async () => {
    await seedCatalog(database.pool, [{ sku: 'CAPA-A' }, { sku: 'CAPA-B' }]);
    const app = await start();

    const res = await app.get();

    expect(res.status).toBe(503);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.headers['cache-control']).toBe('no-store');
    const problem = Problem.parse(res.body);
    expect(problem.type).toBe('/problems/service-unavailable');
    expect(problem.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(
      /sync_state|select |CatalogNotSynced/i,
    );
  });

  it('CAT-05 o "não sincronizado" fica na entrada até o TTL, e a vitrine aparece no máximo um TTL depois da primeira rodada', async () => {
    await seedCatalog(database.pool, [{ sku: 'CAPA-A', priceCents: 1990 }]);
    const app = await start();

    expect((await app.get()).status).toBe(503);
    const callsAfterFirst = app.boundary.calls;

    await markSynced(database.pool);
    app.clock.advance(4_999);
    const withinTtl = await app.get();

    expect(withinTtl.status).toBe(503);
    expect(app.boundary.calls).toBe(callsAfterFirst);

    app.clock.advance(2);
    const afterTtl = await app.get();

    expect(afterTtl.status).toBe(200);
    expect(afterTtl.body).toEqual({
      items: [
        {
          sku: 'CAPA-A',
          name: 'Capinha CAPA-A',
          unitPrice: 1990,
          availability: 'available',
        },
      ],
      hasNext: false,
    });
  });
});

describe('FND-07 o contrato do GET /products cobre cada resposta', () => {
  it('FND-07 o 200, o 400 e o 503 saem com status declarado na rota e os erros em application/problem+json', async () => {
    const { unsynced, ok, invalid } = await unsyncedThenServed();

    // O harness já confere cada resposta pelo schema da rota; aqui se confere que as três saíram e o que a
    // rota declara: sucesso, as duas causas de erro do design e o default em problem+json.
    expect([ok.status, invalid.status, unsynced.status]).toEqual([
      200, 400, 503,
    ]);
    expect(Object.keys(productsRoute.responses).sort()).toEqual(
      ['200', '400', '503', 'default'].sort(),
    );
    for (const res of [invalid, unsynced])
      expect(res.headers['content-type']).toMatch(
        /^application\/problem\+json/,
      );
    expect(ok.headers['content-type']).toMatch(/^application\/json/);
  });
});
