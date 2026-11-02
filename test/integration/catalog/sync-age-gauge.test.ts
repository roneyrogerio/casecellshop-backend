import type pg from 'pg';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { registerSyncAgeGauge } from '../../../src/catalog/sync-age.ts';
import type { AppLogger } from '../../../src/shared/logging.ts';
import { setSyncCompletedAt } from '../../helpers/catalog.ts';
import {
  startCheckoutHarness,
  type CheckoutHarness,
} from '../../helpers/checkout.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import { captureLogs } from '../../helpers/logs.ts';
import {
  familyOf,
  metricValue,
  parseExposition,
  type Exposition,
} from '../../helpers/metrics.ts';
import { interceptPool } from '../../helpers/worker.ts';

// CAT-15 (AD-008; design.md, "Sincronização", item "Idade da sincronização"): a idade da sincronização sai pela API,
// lida do banco a cada coleta, para seguir crescendo com o worker parado. Aqui não há worker nem sincronização: só o
// processo da API (o app do harness) e o banco, com o `last_completed_at` semeado no relógio do banco.

const READ_FAILED = 'casecellshop.catalog.gauge.read_failed';
const INJECTED_FAILURE = 'banco indisponível (injetado)';

let database: TestDatabase;
let harness: CheckoutHarness;
let removers: (() => void)[] = [];

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

// Um harness (e uma telemetria) por teste: o exportador do Prometheus é cumulativo, então o último ponto de um
// teste vazaria para o seguinte, e o teste "sem ponto" precisa de uma telemetria que nunca leu a idade.
beforeEach(async () => {
  harness = await startCheckoutHarness(database);
  await setSyncCompletedAt(database.pool, null);
});

afterEach(async () => {
  for (const remove of removers) remove();
  removers = [];
  await harness.close();
});

const SILENT: AppLogger = captureLogs('casecellshop-api', 'silent').logger;

function register(
  pool: pg.Pool = harness.pool,
  logger: AppLogger = SILENT,
): () => void {
  const remove = registerSyncAgeGauge({
    pool,
    telemetry: harness.telemetry,
    logger,
  });
  removers.push(remove);
  return remove;
}

// O /metrics da API, como o Prometheus o recebe.
async function scrapeApi(): Promise<Exposition> {
  const res = await request(harness.app).get('/metrics').expect(200);
  return parseExposition(res.text);
}

function ageOf(families: Exposition): number | undefined {
  return metricValue(families, 'casecellshop.catalog.sync.age');
}

function failuresOf(families: Exposition): number {
  return (
    metricValue(families, 'casecellshop.catalog.gauge.read_failures', {
      'casecellshop.gauge.name': 'catalog_sync_age',
    }) ?? 0
  );
}

// A última rodada completa terminou `seconds` atrás, pelo relógio do banco (o mesmo que grava a marca).
async function completedAgo(seconds: number): Promise<void> {
  await database.pool.query(
    'update sync_state set last_completed_at = now() - make_interval(secs => $1)',
    [seconds],
  );
}

describe('CAT-15 a idade da sincronização no /metrics da API, lida do banco', () => {
  it('CAT-15 a coleta mostra now() - last_completed_at em segundos, no relógio do banco', async () => {
    register();
    await completedAgo(90);

    const age = ageOf(await scrapeApi());

    expect(age).toBeGreaterThanOrEqual(90);
    expect(age).toBeLessThan(95);
  });

  it('CAT-15 o gauge é do tipo gauge, em segundos, e sai sem atributos', async () => {
    register();
    await completedAgo(10);

    const family = familyOf(await scrapeApi(), 'casecellshop.catalog.sync.age');

    expect(family?.type).toBe('gauge');
    expect(family?.samples).toHaveLength(1);
    expect(family?.samples[0]?.labels).toEqual({});
  });

  it('CAT-15 sem rodada completa (last_completed_at nulo) não há ponto', async () => {
    register();

    const families = await scrapeApi();

    expect(
      familyOf(families, 'casecellshop.catalog.sync.age')?.samples ?? [],
    ).toEqual([]);
    expect(ageOf(families)).toBeUndefined();
  });

  it('CAT-15 com o worker parado a idade segue crescendo entre duas coletas, sem nenhuma sincronização rodando', async () => {
    register();
    await completedAgo(30);

    const first = ageOf(await scrapeApi());
    const second = ageOf(await scrapeApi());

    expect(first).toBeGreaterThanOrEqual(30);
    expect(second).toBeGreaterThan(first ?? Number.POSITIVE_INFINITY);
  });

  it('CAT-15 a coleta lê o banco de novo: uma rodada completa gravada depois traz a idade de volta perto de 0', async () => {
    register();
    await completedAgo(300);
    expect(ageOf(await scrapeApi())).toBeGreaterThanOrEqual(300);

    await database.pool.query(
      'update sync_state set last_completed_at = now()',
    );

    const age = ageOf(await scrapeApi());
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(10);
  });

  it('CAT-15 a coleta faz uma consulta ao sync_state por scrape, e o remover devolvido tira o callback: o banco deixa de ser consultado', async () => {
    const probe = interceptPool(harness.pool, { match: /sync_state/i });
    const remove = register(probe.pool);
    await completedAgo(5);

    const readsAfterEachScrape: number[] = [];
    for (let scrape = 0; scrape < 3; scrape += 1) {
      await scrapeApi();
      readsAfterEachScrape.push(probe.matched);
    }
    remove();
    for (let scrape = 0; scrape < 2; scrape += 1) {
      await scrapeApi();
      readsAfterEachScrape.push(probe.matched);
    }

    // Uma leitura por scrape; depois de remove(), nenhuma.
    expect(readsAfterEachScrape).toEqual([1, 2, 3, 3, 3]);
  });
});

// Leitura que falha (design.md, "Leitura que falha"): com a temporalidade cumulativa o SDK segue exportando o último
// valor do gauge, então o /metrics não denuncia a falha. O sinal é o counter de falhas e o log de erro.
describe('CAT-15 a leitura da idade da sincronização que falha é contada e logada', () => {
  // Uma leitura boa, uma que falha na fronteira do banco (um único comando) e uma de recuperação.
  async function readThroughAFailure() {
    const logs = captureLogs('casecellshop-api');
    const probe = interceptPool(harness.pool, {
      match: /sync_state/i,
      fail: () => new Error(INJECTED_FAILURE),
      times: 1,
    });
    probe.armed = false;
    register(probe.pool, logs.logger);
    await completedAgo(60);
    const take = async () => {
      const families = await scrapeApi();
      return {
        age: ageOf(families),
        failures: failuresOf(families),
        events: logs.eventsOf(READ_FAILED),
      };
    };

    const good = await take();
    probe.armed = true;
    const failed = await take();
    probe.armed = false;
    const recovered = await take();
    return { probe, good, failed, recovered };
  }

  it('CAT-15 a leitura que falha depois de uma boa não quebra o /metrics, soma 1 em catalog.gauge.read_failures com o gauge catalog_sync_age e escreve gauge.read_failed em error com o gauge e o erro', async () => {
    const run = await readThroughAFailure();

    expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
    expect(run.good.age).toBeGreaterThanOrEqual(60);
    expect(run.failed.events).toHaveLength(1);
    const [event] = run.failed.events;
    expect(event?.['level']).toBe('error');
    expect(event?.['gauge']).toBe('catalog_sync_age');
    expect(JSON.stringify(event?.['err'])).toContain(INJECTED_FAILURE);
    expect(run.recovered.failures - run.good.failures).toBe(1);
    expect(run.recovered.events, 'a recuperação não loga de novo').toHaveLength(
      1,
    );
  });

  it('CAT-15 a leitura que dá certo não soma em catalog.gauge.read_failures nem escreve gauge.read_failed', async () => {
    const run = await readThroughAFailure();

    expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
    expect(run.good.events).toHaveLength(0);
    expect(run.good.failures).toBe(0);
  });

  it('CAT-15 depois da falha a leitura seguinte volta a mostrar a idade da sincronização', async () => {
    const run = await readThroughAFailure();

    expect(run.probe.fired, 'a falha injetada disparou').toBe(1);
    expect(run.recovered.age).toBeGreaterThanOrEqual(60);
    expect(run.recovered.age).toBeLessThan(90);
  });
});
