import { describe, expect, it, vi } from 'vitest';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import {
  markSynced,
  seedCatalog,
  skuRange,
  useCatalogDatabase,
  type CatalogHarness,
} from '../../helpers/catalog.ts';
import type { LogLine } from '../../helpers/logs.ts';

// OBS-01 do GET /products (design.md, "Vitrine e cache (AD-005)", item "Log"): o fim da requisição leva o campo
// `cache` com o resultado da leitura do cache; o 503 sem entrada servível e o 400 não o levam. A latência por
// resultado do cache sai desse log, que é o que o operador lê.

const TTL_MS = 5_000;
const CEILING_MS = 60_000;
const COMPLETED = 'casecellshop.http.request.completed';

const database = useCatalogDatabase();

async function seedAndSync(): Promise<void> {
  await seedCatalog(
    database.pool,
    skuRange('L', 3).map((sku) => ({ sku })),
  );
  await markSynced(database.pool);
}

// As linhas de fim de requisição do `/products`, na ordem das requisições. O log sai no fim da resposta, que pode
// correr um instante depois de o cliente ler o corpo: espera a linha da requisição `count`.
async function completedLines(
  app: CatalogHarness,
  count: number,
): Promise<LogLine[]> {
  let lines: LogLine[] = [];
  await vi.waitFor(
    () => {
      lines = app.logs
        .eventsOf(COMPLETED)
        .filter((line) => line['route'] === '/products');
      expect(
        lines.length,
        'linhas de fim de requisição',
      ).toBeGreaterThanOrEqual(count);
    },
    { timeout: WAIT_GUARD_MS },
  );
  return lines;
}

describe('OBS-01 o campo cache no log do fim da requisição do GET /products', () => {
  it('OBS-01 a leitura que esperou a carga loga cache miss, a seguinte dentro do TTL loga hit, e a que serviu a entrada antiga com a origem em erro loga stale', async () => {
    await seedAndSync();
    const app = await database.start();

    expect((await app.get()).status).toBe(200);
    expect((await app.get()).status).toBe(200);
    app.boundary.fail();
    app.clock.advance(TTL_MS + 1);
    expect((await app.get()).status).toBe(200);

    expect(app.boundary.injected).toBeGreaterThan(0);
    const lines = await completedLines(app, 3);
    expect(lines.map((line) => line['cache'])).toEqual([
      'miss',
      'hit',
      'stale',
    ]);
    for (const line of lines) {
      expect(line['status']).toBe(200);
      expect(line['level']).toBe('info');
    }
  });

  it('OBS-01 o campo cache acompanha o TTL: passado o TTL, a leitura que recarrega volta a logar miss', async () => {
    await seedAndSync();
    const app = await database.start();

    for (let read = 0; read < 4; read += 1) {
      expect((await app.get()).status).toBe(200);
      if (read === 1) app.clock.advance(TTL_MS + 1);
    }

    // miss (carga), hit, miss (TTL vencido, nova carga), hit.
    const lines = await completedLines(app, 4);
    expect(lines.map((line) => line['cache'])).toEqual([
      'miss',
      'hit',
      'miss',
      'hit',
    ]);
  });

  it('OBS-01 o 503 sem entrada servível (origem em erro e entrada acima do teto de 60 s) não leva o campo cache, mas a leitura 200 anterior leva', async () => {
    await seedAndSync();
    const app = await database.start();
    expect((await app.get()).status).toBe(200);
    app.boundary.fail();
    app.clock.advance(CEILING_MS + 1);

    const res = await app.get();

    expect(app.boundary.injected).toBeGreaterThan(0);
    expect(res.status).toBe(503);
    const [served, refused] = await completedLines(app, 2);
    expect(served?.['cache']).toBe('miss');
    expect(refused?.['status']).toBe(503);
    expect(refused?.['level']).toBe('error');
    expect(refused).not.toHaveProperty('cache');
  });

  it('OBS-01 o 400 de parâmetro inválido não leva o campo cache, e o log dele sai com o status 400', async () => {
    await seedAndSync();
    const app = await database.start();
    expect((await app.get()).status).toBe(200);

    const res = await app.get('?page=x');

    expect(res.status).toBe(400);
    const [served, rejected] = await completedLines(app, 2);
    expect(served?.['cache']).toBe('miss');
    expect(rejected?.['status']).toBe(400);
    expect(rejected).not.toHaveProperty('cache');
  });
});
