import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { Problem } from '../../../src/contract/index.ts';
import { settle, track } from '../../helpers/async.ts';
import {
  counterValue,
  markSynced,
  seedCatalog,
  skuRange,
  useCatalogDatabase,
} from '../../helpers/catalog.ts';
import {
  histogramCount,
  metricValue,
  type Exposition,
} from '../../helpers/metrics.ts';

// O cache da vitrine contra o PostgreSQL real, pelo createApp: o relógio é o manual (nada de sleep), a falha da
// origem é injetada só na fronteira do pool (e cada teste confere que ela disparou), e as consultas à origem são
// contadas pelo /metrics e pelos spans, que são o que o operador vê (AD-005).

const TTL_MS = 5_000;
const PAUSE_MS = 5_000;
const CEILING_MS = 60_000;

const database = useCatalogDatabase();
const start = () => database.start();

const LOOKUPS = 'casecellshop.catalog.cache.lookups';
const LOADS = 'casecellshop.catalog.origin.loads';
const ACTIVE = 'casecellshop.catalog.origin.active_loads';
const AGE = 'casecellshop.catalog.served_entry.age';
const RESULT = 'casecellshop.catalog.cache.result';
const OUTCOME = 'casecellshop.catalog.origin.outcome';

function lookups(
  families: Exposition,
  result: 'hit' | 'miss' | 'stale',
): number {
  return counterValue(families, LOOKUPS, { [RESULT]: result });
}

function loads(families: Exposition, outcome: 'ok' | 'error'): number {
  return counterValue(families, LOADS, { [OUTCOME]: outcome });
}

async function seedAndSync(count = 3): Promise<string[]> {
  const all = skuRange('P', count);
  await seedCatalog(
    database.pool,
    all.map((sku) => ({ sku })),
  );
  await markSynced(database.pool);
  return all;
}

describe('CAT-01 N leituras concorrentes com a entrada expirada geram 1 consulta à origem', () => {
  it('CAT-01 30 requisições simultâneas, com a origem presa para juntá-las, somam 1 carga e 1 span de repositório por rodada', async () => {
    await seedAndSync();
    const app = await start();
    const simultaneous = 30;
    const rounds = 3;

    for (let round = 1; round <= rounds; round += 1) {
      // A primeira rodada parte da entrada vazia e as seguintes da entrada expirada.
      if (round > 1) app.clock.advance(TTL_MS + 1);
      app.boundary.hold();
      const reads = Array.from({ length: simultaneous }, () =>
        track(app.get()),
      );
      // Espera as 30 chegarem e a carga bater no pool preso; nenhuma pode terminar antes de a origem ser solta.
      while (app.received < simultaneous * round || app.boundary.calls === 0) {
        expect(
          reads.some((read) => read.settled),
          'uma leitura terminou com a origem presa',
        ).toBe(false);
        await settle(1);
      }

      // O single-flight mantém uma carga ativa, e não 30.
      expect(metricValue(await app.scrape(), ACTIVE)).toBe(1);
      app.boundary.release();
      const responses = await Promise.all(reads.map((read) => read.result));

      expect(new Set(responses.map((res) => res.status))).toEqual(
        new Set([200]),
      );
      expect(
        new Set(responses.map((res) => JSON.stringify(res.body))).size,
      ).toBe(1);
      const families = await app.scrape();
      expect(loads(families, 'ok'), `rodada ${round}`).toBe(round);
      expect(loads(families, 'error')).toBe(0);
      expect(metricValue(families, ACTIVE)).toBe(0);
      expect(lookups(families, 'miss')).toBeGreaterThanOrEqual(round);
      expect(lookups(families, 'hit') + lookups(families, 'miss')).toBe(
        simultaneous * round,
      );
      const repositorySpans = (await app.spans()).filter(
        (span) => span.name === 'catalog.repository.list',
      );
      expect(repositorySpans, `rodada ${round}`).toHaveLength(round);
    }
  });
});

describe('CAT-02 a entrada expira no TTL', () => {
  it('CAT-02 com o relógio dentro do TTL a vitrine não consulta a origem, e passado o TTL consulta de novo', async () => {
    await seedAndSync();
    const app = await start();

    expect((await app.get()).status).toBe(200);
    expect(loads(await app.scrape(), 'ok')).toBe(1);
    const callsAfterLoad = app.boundary.calls;

    app.clock.advance(TTL_MS - 1);
    expect((await app.get()).status).toBe(200);
    expect(app.boundary.calls).toBe(callsAfterLoad);
    expect(loads(await app.scrape(), 'ok')).toBe(1);

    app.clock.advance(2);
    expect((await app.get()).status).toBe(200);
    expect(loads(await app.scrape(), 'ok')).toBe(2);
    expect(app.boundary.calls).toBeGreaterThan(callsAfterLoad);
  });

  it('CAT-02 o jitter do random injetado muda o TTL da entrada: com random 0 a entrada vale 4500 ms', async () => {
    await seedAndSync();
    const app = await database.start({ random: () => 0 });

    await app.get();
    app.clock.advance(4_499);
    await app.get();
    expect(loads(await app.scrape(), 'ok')).toBe(1);

    app.clock.advance(2);
    await app.get();
    expect(loads(await app.scrape(), 'ok')).toBe(2);
  });
});

describe('CAT-03 as páginas servidas durante um TTL vêm do mesmo instantâneo', () => {
  it('CAT-03 uma mudança no banco depois da página 1 não aparece na página 2 dentro do TTL, e aparece depois dele', async () => {
    const all = await seedAndSync(60);
    const app = await start();
    const pageOne = await app.get();
    expect((pageOne.body as { items: unknown[] }).items).toHaveLength(50);

    // Um SKU novo que ordena antes de todos empurraria o P-050 para a página 2 num instantâneo novo; um
    // preço novo e uma reposição mudariam o conteúdo das duas.
    await seedCatalog(database.pool, [{ sku: 'P-000', onHand: 1 }]);
    await database.pool.query(
      "update products set price_cents = 1, name = 'Renomeado' where sku in ('P-001', 'P-055')",
    );
    await database.pool.query(
      "update inventory set on_hand = 0 where sku in ('P-002', 'P-056')",
    );
    app.clock.advance(1_000);
    const pageTwo = await app.get('?page=2');
    const pageOneAgain = await app.get();

    expect(
      (pageTwo.body as { items: { sku: string }[] }).items.map(
        (item) => item.sku,
      ),
    ).toEqual(all.slice(50));
    expect(pageOneAgain.body).toEqual(pageOne.body);
    expect(loads(await app.scrape(), 'ok')).toBe(1);

    app.clock.advance(TTL_MS);
    const fresh = await app.get();
    const items = (
      fresh.body as {
        items: { sku: string; unitPrice: number; availability: string }[];
      }
    ).items;

    expect(items[0]?.sku).toBe('P-000');
    expect(items.find((item) => item.sku === 'P-001')).toMatchObject({
      name: 'Renomeado',
      unitPrice: 1,
    });
    expect(items.find((item) => item.sku === 'P-002')?.availability).toBe(
      'out_of_stock',
    );
    expect(loads(await app.scrape(), 'ok')).toBe(2);
  });
});

describe('CAT-04 com a origem em erro, a última entrada é servida até o teto', () => {
  it('CAT-04 depois de uma carga boa, o banco fora serve a entrada antiga sem consultar a origem durante a pausa, e a vitrine volta quando o banco volta', async () => {
    await seedAndSync();
    const app = await start();
    const good = await app.get();
    expect(good.status).toBe(200);

    app.boundary.fail();
    app.clock.advance(TTL_MS + 1);
    const stale = await app.get();

    expect(app.boundary.injected).toBeGreaterThan(0);
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual(good.body);
    const afterFailure = app.boundary.calls;
    let families = await app.scrape();
    expect(loads(families, 'error')).toBe(1);
    expect(lookups(families, 'stale')).toBe(1);

    // Dentro da pausa: nenhuma chamada ao pool, nem com leituras simultâneas.
    app.clock.advance(PAUSE_MS - 2_000);
    const during = await Promise.all(
      Array.from({ length: 10 }, () => app.get()),
    );
    expect(new Set(during.map((res) => res.status))).toEqual(new Set([200]));
    for (const res of during) expect(res.body).toEqual(good.body);
    expect(app.boundary.calls).toBe(afterFailure);
    families = await app.scrape();
    expect(loads(families, 'error')).toBe(1);
    expect(lookups(families, 'stale')).toBe(11);

    // Passada a pausa, a origem é tentada de novo, falha de novo e a entrada antiga segue servida.
    app.clock.advance(2_001);
    expect((await app.get()).body).toEqual(good.body);
    expect(app.boundary.calls).toBeGreaterThan(afterFailure);
    expect(loads(await app.scrape(), 'error')).toBe(2);

    // O banco volta: depois da pausa seguinte a entrada nova é servida.
    app.boundary.restore();
    await database.pool.query(
      "update products set name = 'Voltou' where sku = 'P-001'",
    );
    app.clock.advance(PAUSE_MS + 1);
    const recovered = await app.get();

    expect(
      (recovered.body as { items: { name: string }[] }).items[0]?.name,
    ).toBe('Voltou');
    expect(loads(await app.scrape(), 'ok')).toBe(2);
  });

  it('CAT-04 o 503 sem entrada traz Retry-After 5 e problem+json sem detalhe interno, e a pausa também poupa a origem', async () => {
    await seedAndSync();
    const app = await start();
    app.boundary.fail();

    const first = await app.get();

    expect(app.boundary.injected).toBeGreaterThan(0);
    expect(first.status).toBe(503);
    expect(first.headers['retry-after']).toBe('5');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['content-type']).toMatch(
      /^application\/problem\+json/,
    );
    expect(Problem.parse(first.body).type).toBe(
      '/problems/service-unavailable',
    );
    expect(JSON.stringify(first.body)).not.toMatch(
      /injetada|conexão recusada|select |stack/i,
    );
    const afterFailure = app.boundary.calls;

    app.clock.advance(PAUSE_MS - 1);
    expect((await app.get()).status).toBe(503);
    expect(app.boundary.calls).toBe(afterFailure);

    app.clock.advance(2);
    expect((await app.get()).status).toBe(503);
    expect(app.boundary.calls).toBeGreaterThan(afterFailure);

    app.boundary.restore();
    app.clock.advance(PAUSE_MS + 1);
    expect((await app.get()).status).toBe(200);
  });

  it('CAT-04 acima do teto de 60 s a entrada antiga não é servida: 503, e o teto vale também dentro da pausa', async () => {
    await seedAndSync();
    const app = await start();
    await app.get();
    app.boundary.fail();

    app.clock.advance(CEILING_MS + 1);
    const aboveCeiling = await app.get();

    expect(app.boundary.injected).toBeGreaterThan(0);
    expect(aboveCeiling.status).toBe(503);
    expect(aboveCeiling.headers['retry-after']).toBe('5');
    expect(lookups(await app.scrape(), 'stale')).toBe(0);

    // Outra entrada: servida stale aos 58 s, ela passa do teto durante a pausa e então a origem nem é chamada.
    app.boundary.restore();
    app.clock.advance(PAUSE_MS + 1);
    expect((await app.get()).status).toBe(200);
    app.boundary.fail();
    app.clock.advance(CEILING_MS - 2_000);
    expect((await app.get()).status).toBe(200);
    const afterFailure = app.boundary.calls;

    app.clock.advance(4_000);
    expect((await app.get()).status).toBe(503);
    expect(app.boundary.calls).toBe(afterFailure);
  });
});

describe('CAT-12 o trace de GET /products liga requisição, cache e repositório', () => {
  it('CAT-12 a leitura com a entrada vazia gera GET /products, catalog.cache.get e catalog.repository.list (CLIENT) na mesma árvore', async () => {
    await seedAndSync();
    const app = await start();

    expect((await app.get()).status).toBe(200);
    const spans = await app.spans();

    const server = spans.find(
      (span) => span.name === 'GET /products' && span.kind === SpanKind.SERVER,
    );
    const cacheGet = spans.find((span) => span.name === 'catalog.cache.get');
    const list = spans.find((span) => span.name === 'catalog.repository.list');
    expect(server).toBeDefined();
    expect(cacheGet).toBeDefined();
    expect(list).toBeDefined();
    expect(cacheGet?.parentSpanContext?.spanId).toBe(
      server?.spanContext().spanId,
    );
    expect(list?.parentSpanContext?.spanId).toBe(
      cacheGet?.spanContext().spanId,
    );
    expect(list?.kind).toBe(SpanKind.CLIENT);
    const traceIds = new Set(
      [server, cacheGet, list].map((span) => span?.spanContext().traceId),
    );
    expect(traceIds.size).toBe(1);
  });

  it('CAT-12 numa leitura com hit há o catalog.cache.get sob a requisição e nenhum catalog.repository.list', async () => {
    await seedAndSync();
    const app = await start();
    await app.get();
    await app.spans();
    app.exporter.reset();

    app.clock.advance(1_000);
    expect((await app.get()).status).toBe(200);
    const spans = await app.spans();

    const server = spans.find((span) => span.name === 'GET /products');
    const cacheGet = spans.find((span) => span.name === 'catalog.cache.get');
    expect(cacheGet?.parentSpanContext?.spanId).toBe(
      server?.spanContext().spanId,
    );
    expect(
      spans.filter((span) => span.name === 'catalog.repository.list'),
    ).toEqual([]);
  });
});

describe('OBS-02 as métricas do cache da vitrine no /metrics', () => {
  it('OBS-02 os resultados hit, miss e stale somam nos lookups, as cargas por desfecho e a idade servida no histograma', async () => {
    await seedAndSync();
    const app = await start();

    await app.get();
    app.clock.advance(3_000);
    await app.get();
    app.boundary.fail();
    app.clock.advance(4_001);
    await app.get();

    expect(app.boundary.injected).toBeGreaterThan(0);
    const families = await app.scrape();
    expect(lookups(families, 'miss')).toBe(1);
    expect(lookups(families, 'hit')).toBe(1);
    expect(lookups(families, 'stale')).toBe(1);
    expect(loads(families, 'ok')).toBe(1);
    expect(loads(families, 'error')).toBe(1);
    expect(metricValue(families, ACTIVE)).toBe(0);
    // Idades servidas: 0 s (miss), 3 s (hit) e 7,001 s (stale).
    expect(histogramCount(families, AGE)).toBe(3);
    expect(metricValue(families, AGE, {}, '_sum')).toBeCloseTo(10.001, 3);
  });

  it('OBS-02 um 503 sem entrada não conta lookup nem idade servida, mas conta a carga com erro', async () => {
    await seedAndSync();
    const app = await start();
    app.boundary.fail();

    expect((await app.get()).status).toBe(503);

    expect(app.boundary.injected).toBeGreaterThan(0);
    const families = await app.scrape();
    expect(loads(families, 'error')).toBe(1);
    expect(loads(families, 'ok')).toBe(0);
    expect(lookups(families, 'hit') + lookups(families, 'miss')).toBe(0);
    expect(lookups(families, 'stale')).toBe(0);
    expect(histogramCount(families, AGE) ?? 0).toBe(0);
    expect(metricValue(families, ACTIVE)).toBe(0);
  });

  it('OBS-07 a falha da origem sai como o evento casecellshop.catalog.origin.load_failed em warn, uma vez por carga', async () => {
    await seedAndSync();
    const app = await start();
    await app.get();
    expect(
      app.logs.eventsOf('casecellshop.catalog.origin.load_failed'),
    ).toEqual([]);
    app.boundary.fail();
    app.clock.advance(TTL_MS + 1);

    await Promise.all(Array.from({ length: 5 }, () => app.get()));

    expect(app.boundary.injected).toBeGreaterThan(0);
    const events = app.logs.eventsOf('casecellshop.catalog.origin.load_failed');
    expect(events).toHaveLength(1);
    expect(events[0]?.['level']).toBe('warn');
  });
});
