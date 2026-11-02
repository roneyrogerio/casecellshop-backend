import { describe, expect, it } from 'vitest';
import { settle } from '../../test/helpers/async.ts';
import {
  createManualClock,
  type ManualClock,
} from '../../test/helpers/clock.ts';
import {
  CacheUnavailableError,
  createInMemoryCache,
  type Cache,
  type InMemoryCacheOptions,
} from './cache.ts';

// AD-005: o cache é genérico, e o critério de CAT-01 a CAT-04 é o número de chamadas à origem. Por isso a origem
// aqui é falsa e conta chamadas (a regra de testes permite essa exceção); o banco real entra nos testes de
// integração de test/integration/catalog/.

const TTL_MS = 5_000;
const CEILING_MS = 60_000;
const PAUSE_MS = 5_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Factory<V> = (options: InMemoryCacheOptions<V>) => Cache<V>;

function optionsOf<V>(
  load: () => Promise<V>,
  clock: ManualClock,
  overrides: Partial<InMemoryCacheOptions<V>> = {},
): InMemoryCacheOptions<V> {
  return {
    load,
    clock,
    ttlMs: TTL_MS,
    ttlJitter: 0.1,
    staleCeilingMs: CEILING_MS,
    failurePauseMs: PAUSE_MS,
    // 0,5 deixa o TTL exato: 5000 * (1 + 0,1 * (2 * 0,5 - 1)).
    random: () => 0.5,
    ...overrides,
  };
}

// Origem que devolve 1, 2, 3... a cada carga boa e conta toda chamada, boa ou ruim.
function switchableOrigin() {
  let failing = false;
  let calls = 0;
  let version = 0;
  return {
    load: (): Promise<number> => {
      calls += 1;
      if (failing) return Promise.reject(new Error('origem fora'));
      version += 1;
      return Promise.resolve(version);
    },
    setFailing(value: boolean): void {
      failing = value;
    },
    get calls() {
      return calls;
    },
  };
}

function build(
  overrides: Partial<InMemoryCacheOptions<number>> = {},
  startMs?: number,
) {
  const clock = createManualClock(startMs);
  const origin = switchableOrigin();
  const cache = createInMemoryCache<number>(
    optionsOf(origin.load, clock, overrides),
  );
  return { cache, clock, origin };
}

// ---------------------------------------------------------------- CAT-01

// Um cache sem single-flight e sem pausa: o controle negativo de CAT-01. Cada leitura com a entrada expirada
// chama a origem por conta própria.
function createNaiveCache<V>(options: InMemoryCacheOptions<V>): Cache<V> {
  let entry: { value: V; loadedAt: number } | undefined;
  return {
    async get() {
      const now = options.clock.now();
      if (entry && now - entry.loadedAt < options.ttlMs)
        return {
          value: entry.value,
          result: 'hit',
          ageMs: now - entry.loadedAt,
        };
      const value = await options.load();
      entry = { value, loadedAt: options.clock.now() };
      return { value, result: 'miss', ageMs: 0 };
    },
  };
}

const READERS = 20;
const LATE_READERS = 10;
const ROUNDS = 3;

// Em cada rodada a entrada está expirada (ou vazia), e a origem fica presa: as leituras se juntam na janela
// da carga, umas na largada e outras no meio dela. Devolve quantas cargas cada rodada pediu.
async function loadsPerRoundWithConcurrentReaders(
  create: Factory<number>,
): Promise<{ loads: number[]; results: string[]; values: number[] }> {
  const clock = createManualClock();
  const pending: Deferred<number>[] = [];
  const load = (): Promise<number> => {
    const gate = deferred<number>();
    pending.push(gate);
    return gate.promise;
  };
  const cache = create(optionsOf(load, clock));
  const loads: number[] = [];
  const results: string[] = [];
  const values: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const reads = Array.from({ length: READERS }, () => cache.get());
    await settle();
    reads.push(...Array.from({ length: LATE_READERS }, () => cache.get()));
    await settle();
    loads.push(pending.length);
    for (const gate of pending.splice(0)) gate.resolve(round + 1);
    for (const lookup of await Promise.all(reads)) {
      results.push(lookup.result);
      values.push(lookup.value);
    }
    clock.advance(TTL_MS + 1);
  }
  return { loads, results, values };
}

describe('CAT-01 single-flight da origem', () => {
  it('CAT-01 30 leituras concorrentes com a entrada expirada geram 1 consulta à origem por rodada, e todas esperam a mesma carga', async () => {
    const { loads, results, values } =
      await loadsPerRoundWithConcurrentReaders(createInMemoryCache);

    expect(loads).toEqual([1, 1, 1]);
    expect(results).toHaveLength(ROUNDS * (READERS + LATE_READERS));
    expect(new Set(results)).toEqual(new Set(['miss']));
    // Cada rodada serve o valor da própria carga, a todos os leitores.
    expect(values).toEqual(
      [1, 2, 3].flatMap((value) =>
        Array.from<number>({ length: READERS + LATE_READERS }).fill(value),
      ),
    );
  });

  it('CAT-01 controle negativo: um cache sem single-flight, na mesma janela forçada, chama a origem uma vez por leitura', async () => {
    const { loads } =
      await loadsPerRoundWithConcurrentReaders(createNaiveCache);

    expect(loads.every((count) => count > 1)).toBe(true);
  });

  it('CAT-01 a promessa rejeitada é descartada: todas as leituras da carga que falhou são recusadas por 1 consulta, e a leitura seguinte depois da pausa consulta de novo', async () => {
    const { cache, clock, origin } = build();
    origin.setFailing(true);

    const reads = Array.from({ length: 15 }, () => cache.get());
    const outcomes = await Promise.allSettled(reads);

    expect(origin.calls).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        CacheUnavailableError,
      );
    }

    origin.setFailing(false);
    clock.advance(PAUSE_MS + 1);
    const lookup = await cache.get();

    expect(origin.calls).toBe(2);
    expect(lookup).toMatchObject({ value: 1, result: 'miss', ageMs: 0 });
  });
});

// ---------------------------------------------------------------- CAT-02

describe('CAT-02 a entrada expira no TTL', () => {
  it('CAT-02 dentro do TTL a leitura é hit sem consultar a origem, e passado o TTL a próxima carrega de novo', async () => {
    const { cache, clock, origin } = build();

    expect(await cache.get()).toMatchObject({ value: 1, result: 'miss' });

    clock.advance(TTL_MS - 1);
    expect(await cache.get()).toEqual({
      value: 1,
      result: 'hit',
      ageMs: TTL_MS - 1,
    });
    expect(origin.calls).toBe(1);

    clock.advance(2);
    expect(await cache.get()).toEqual({ value: 2, result: 'miss', ageMs: 0 });
    expect(origin.calls).toBe(2);
  });

  it('CAT-02 o TTL de cada entrada é sorteado entre -10% e +10% pelo random injetável', async () => {
    let draw = 0;
    const { cache, clock, origin } = build({ random: () => draw });

    // random 0: TTL = 5000 * 0,9 = 4500.
    draw = 0;
    await cache.get();
    clock.advance(4_499);
    expect((await cache.get()).result).toBe('hit');
    clock.advance(2);
    // random 0,99: TTL = 5000 * (1 + 0,1 * 0,98) = 5490.
    draw = 0.99;
    expect((await cache.get()).result).toBe('miss');
    expect(origin.calls).toBe(2);

    clock.advance(5_489);
    expect((await cache.get()).result).toBe('hit');
    clock.advance(2);
    expect((await cache.get()).result).toBe('miss');
    expect(origin.calls).toBe(3);
  });

  it('CAT-02 a idade, e com ela o TTL, conta do fim da carga e não do começo', async () => {
    const clock = createManualClock();
    let calls = 0;
    const slowLoad = (): Promise<number> => {
      calls += 1;
      clock.advance(3_000);
      return Promise.resolve(calls);
    };
    const cache = createInMemoryCache<number>(optionsOf(slowLoad, clock));

    expect(await cache.get()).toEqual({ value: 1, result: 'miss', ageMs: 0 });

    clock.advance(TTL_MS - 1);
    expect(await cache.get()).toEqual({
      value: 1,
      result: 'hit',
      ageMs: TTL_MS - 1,
    });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------- CAT-03

describe('CAT-03 o instantâneo de um TTL', () => {
  it('CAT-03 as leituras dentro do TTL devolvem a mesma entrada, mesmo que a origem já tenha mudado, e a seguinte ao TTL devolve outra', async () => {
    const clock = createManualClock();
    let calls = 0;
    const load = (): Promise<{ version: number }> => {
      calls += 1;
      return Promise.resolve({ version: calls });
    };
    const cache = createInMemoryCache(optionsOf(load, clock));

    const first = await cache.get();
    clock.advance(2_000);
    const second = await cache.get();
    clock.advance(2_000);
    const third = await cache.get();

    expect(second.value).toBe(first.value);
    expect(third.value).toBe(first.value);
    expect([second.result, third.result]).toEqual(['hit', 'hit']);
    expect(calls).toBe(1);

    clock.advance(2_000);
    const fourth = await cache.get();

    expect(fourth.value).toEqual({ version: 2 });
    expect(fourth.value).not.toBe(first.value);
  });
});

// ---------------------------------------------------------------- CAT-04

// A entrada boa vem da carga em t0; depois a origem cai.
async function warmThenFail() {
  const built = build();
  await built.cache.get();
  built.origin.setFailing(true);
  return built;
}

describe('CAT-04 stale-if-error, pausa e 503', () => {
  it('CAT-04 com a origem em erro, a entrada expirada é servida como stale com a idade dela', async () => {
    const { cache, clock, origin } = await warmThenFail();

    clock.advance(TTL_MS + 1);
    const lookup = await cache.get();

    expect(origin.calls).toBe(2);
    expect(lookup).toEqual({
      value: 1,
      result: 'stale',
      ageMs: TTL_MS + 1,
    });
  });

  it('CAT-04 durante a pausa a entrada é servida sem chamar a origem, nem com leituras concorrentes', async () => {
    const { cache, clock, origin } = await warmThenFail();
    clock.advance(TTL_MS + 1);
    await cache.get();
    const callsAfterFailure = origin.calls;

    clock.advance(PAUSE_MS - 1);
    const lookups = await Promise.all(
      Array.from({ length: 10 }, () => cache.get()),
    );

    expect(origin.calls).toBe(callsAfterFailure);
    for (const lookup of lookups) {
      expect(lookup).toMatchObject({ value: 1, result: 'stale' });
      expect(lookup.ageMs).toBe(TTL_MS + PAUSE_MS);
    }
  });

  it('CAT-04 passada a pausa a origem é tentada de novo: falha de novo e abre outra pausa, e quando volta a entrada nova é servida', async () => {
    const { cache, clock, origin } = await warmThenFail();
    clock.advance(TTL_MS + 1);
    await cache.get();
    expect(origin.calls).toBe(2);

    clock.advance(PAUSE_MS + 1);
    expect((await cache.get()).result).toBe('stale');
    expect(origin.calls).toBe(3);

    clock.advance(PAUSE_MS - 1);
    expect((await cache.get()).result).toBe('stale');
    expect(origin.calls).toBe(3);

    origin.setFailing(false);
    clock.advance(2);
    expect(await cache.get()).toEqual({ value: 2, result: 'miss', ageMs: 0 });
    expect(origin.calls).toBe(4);

    // A carga boa encerra a pausa: a expiração seguinte consulta a origem sem esperar.
    origin.setFailing(true);
    clock.advance(TTL_MS + 1);
    expect((await cache.get()).result).toBe('stale');
    expect(origin.calls).toBe(5);
  });

  it('CAT-04 várias leituras concorrentes com a origem em erro geram 1 consulta e todas recebem a entrada stale', async () => {
    const { cache, clock, origin } = await warmThenFail();
    clock.advance(TTL_MS + 1);

    const lookups = await Promise.all(
      Array.from({ length: 20 }, () => cache.get()),
    );

    expect(origin.calls).toBe(2);
    expect(new Set(lookups.map((lookup) => lookup.result))).toEqual(
      new Set(['stale']),
    );
  });

  it('CAT-04 sem entrada e com a origem em erro a leitura é recusada com CacheUnavailableError, e durante a pausa sem chamar a origem', async () => {
    const { cache, clock, origin } = build();
    origin.setFailing(true);

    await expect(cache.get()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(origin.calls).toBe(1);

    clock.advance(PAUSE_MS - 1);
    await expect(cache.get()).rejects.toBeInstanceOf(CacheUnavailableError);
    await expect(cache.get()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(origin.calls).toBe(1);

    clock.advance(2);
    await expect(cache.get()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(origin.calls).toBe(2);
  });

  it('CAT-04 com a entrada exatamente no teto ainda é servida como stale; acima do teto a leitura é recusada', async () => {
    const atCeiling = await warmThenFail();
    atCeiling.clock.advance(CEILING_MS);
    expect(await atCeiling.cache.get()).toEqual({
      value: 1,
      result: 'stale',
      ageMs: CEILING_MS,
    });

    const aboveCeiling = await warmThenFail();
    aboveCeiling.clock.advance(CEILING_MS + 1);
    await expect(aboveCeiling.cache.get()).rejects.toBeInstanceOf(
      CacheUnavailableError,
    );
    expect(aboveCeiling.origin.calls).toBe(2);
  });

  it('CAT-04 a entrada que passa do teto durante a pausa é recusada, ainda sem chamar a origem', async () => {
    const { cache, clock, origin } = await warmThenFail();
    clock.advance(CEILING_MS - 2_000);
    expect((await cache.get()).result).toBe('stale');
    const callsAfterFailure = origin.calls;

    clock.advance(4_000);

    await expect(cache.get()).rejects.toBeInstanceOf(CacheUnavailableError);
    expect(origin.calls).toBe(callsAfterFailure);
  });
});

// ---------------------------------------------------------------- CAT-05

describe('CAT-05 o valor "não sincronizado" fica na entrada como qualquer outro', () => {
  it('CAT-05 uma origem que devolve null tem o null guardado: a leitura seguinte é hit sem nova consulta', async () => {
    const clock = createManualClock();
    let calls = 0;
    const load = (): Promise<null> => {
      calls += 1;
      return Promise.resolve(null);
    };
    const cache = createInMemoryCache<null>(optionsOf(load, clock));

    expect(await cache.get()).toEqual({
      value: null,
      result: 'miss',
      ageMs: 0,
    });
    clock.advance(1_000);
    expect(await cache.get()).toEqual({
      value: null,
      result: 'hit',
      ageMs: 1_000,
    });
    expect(calls).toBe(1);

    clock.advance(TTL_MS);
    await cache.get();
    expect(calls).toBe(2);
  });
});
