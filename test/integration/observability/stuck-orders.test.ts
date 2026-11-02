import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type pg from 'pg';
import { pino } from 'pino';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createStuckOrderMonitor,
  DEFAULT_STUCK_ORDER_MONITOR_CONFIG,
  type StuckOrderMonitor,
  type StuckOrderMonitorConfig,
} from '../../../src/billing/stuck-orders.ts';
import type { Clock } from '../../../src/shared/clock.ts';
import { fromPino, type AppLogger } from '../../../src/shared/logging.ts';
import {
  createTelemetry,
  type Telemetry,
} from '../../../src/shared/telemetry.ts';
import {
  settle,
  track,
  WAIT_GUARD_MS,
  waitAdvancing,
} from '../../helpers/async.ts';
import {
  createManualClock,
  watchSleeps,
  type ManualClock,
} from '../../helpers/clock.ts';
import {
  startMigratedDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import { captureLogs } from '../../helpers/logs.ts';
import { metricValue, scrapeMetrics } from '../../helpers/metrics.ts';
import {
  countBreached,
  resetStore,
  seedOrder,
  seedOrders,
  type OrderSeed,
} from '../../helpers/store-seed.ts';
import { interceptPool, within } from '../../helpers/worker.ts';

// OBS-04 (design.md, "Observabilidade"): um pedido sem desfecho em 60 s é contado uma vez, mesmo com várias
// réplicas da API. A verificação marca `orders.sli_breached_at` por `UPDATE … RETURNING` e o counter soma só as
// linhas que a própria chamada marcou. Os instantes são semeados no banco, sem esperar o tempo passar.

const REPLICAS = 3;
const ROUNDS = 10;
const ORDERS_PER_ROUND = 20;
const INTERVAL_MS = 10_000;

let database: TestDatabase;
const telemetries: Telemetry[] = [];
const extraPools: pg.Pool[] = [];

beforeAll(async () => {
  database = await startMigratedDatabase();
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

beforeEach(async () => {
  await resetStore(database.pool);
});

afterEach(async () => {
  for (const telemetry of telemetries.splice(0)) await telemetry.shutdown();
  for (const pool of extraPools.splice(0)) await pool.end();
});

function newTelemetry(): Telemetry {
  const telemetry = createTelemetry({
    spanExporter: new InMemorySpanExporter(),
  });
  telemetries.push(telemetry);
  return telemetry;
}

interface MonitorOptions {
  pool?: pg.Pool;
  telemetry?: Telemetry;
  clock?: Clock;
  logger?: AppLogger;
  config?: Partial<StuckOrderMonitorConfig>;
}

function buildMonitor(options: MonitorOptions = {}): {
  monitor: StuckOrderMonitor;
  telemetry: Telemetry;
} {
  const telemetry = options.telemetry ?? newTelemetry();
  const monitor = createStuckOrderMonitor({
    pool: options.pool ?? database.pool,
    logger: options.logger ?? fromPino(pino({ level: 'silent' })),
    telemetry,
    clock: options.clock ?? createManualClock(),
    ...(options.config ? { config: options.config } : {}),
  });
  return { monitor, telemetry };
}

// O que o counter `casecellshop.order.stuck` soma no /metrics daquela telemetria (sem série, nada foi contado).
async function stuckCount(telemetry: Telemetry): Promise<number> {
  return (
    metricValue(await scrapeMetrics(telemetry), 'casecellshop.order.stuck') ?? 0
  );
}

// A invariante do OBS-04: cada pedido atrasado entra no total uma vez, nem mais nem menos.
function countedOnce(total: number, delayed: number): boolean {
  return total === delayed;
}

async function breachedIds(pool: pg.Pool): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    'select id from orders where sli_breached_at is not null order by id',
  );
  return result.rows.map((row) => row.id);
}

async function stopAdvancing(
  monitor: StuckOrderMonitor,
  clock: ManualClock,
): Promise<void> {
  let stopped = false;
  const stopping = monitor.stop().then(() => {
    stopped = true;
  });
  await waitAdvancing(clock.advanceToNext, () => {
    expect(stopped, 'o stop() ainda espera o laço').toBe(true);
  });
  await stopping;
}

// Um pedido semeado e uma verificação sobre ele: o que ela marcou, o que ficou marcado e o que o counter somou.
async function checkSingle(seed: OrderSeed) {
  const orderId = await seedOrder(database.pool, seed);
  const { monitor, telemetry } = buildMonitor();
  const marked = await monitor.checkOnce();
  return {
    orderId,
    monitor,
    telemetry,
    marked,
    breached: await breachedIds(database.pool),
    counted: await stuckCount(telemetry),
  };
}

const COUNTS: [string, OrderSeed][] = [
  ['pendente aceito há 60 s, o limite', { acceptedAgoSeconds: 60 }],
  ['pendente aceito há 10 min', { acceptedAgoSeconds: 600 }],
  [
    'faturado 61 s depois do aceite',
    { acceptedAgoSeconds: 300, outcomeAfterSeconds: 61 },
  ],
  [
    'recusado 120 s depois do aceite',
    { acceptedAgoSeconds: 300, outcomeAfterSeconds: 120, status: 'failed' },
  ],
];

const DOES_NOT_COUNT: [string, OrderSeed][] = [
  ['pendente aceito há 30 s', { acceptedAgoSeconds: 30 }],
  [
    'faturado 30 s depois do aceite, há muito tempo',
    { acceptedAgoSeconds: 600, outcomeAfterSeconds: 30 },
  ],
  [
    'faturado exatamente 60 s depois do aceite',
    { acceptedAgoSeconds: 600, outcomeAfterSeconds: 60 },
  ],
  [
    'recusado 5 s depois do aceite',
    { acceptedAgoSeconds: 600, outcomeAfterSeconds: 5, status: 'failed' },
  ],
  [
    'faturado no mesmo instante do aceite',
    { acceptedAgoSeconds: 600, outcomeAfterSeconds: 0 },
  ],
];

describe('OBS-04 o pedido sem desfecho em 60 s é marcado no banco e contado uma vez', () => {
  it('OBS-04 um pedido pendente aceito há mais de 60 s é marcado e contado, e uma segunda verificação não o conta de novo', async () => {
    const first = await checkSingle({ acceptedAgoSeconds: 61 });

    expect(first.marked).toBe(1);
    expect(first.breached).toEqual([first.orderId]);
    expect(first.counted).toBe(1);
    const { monitor, telemetry } = first;
    expect(await monitor.checkOnce()).toBe(0);
    expect(await stuckCount(telemetry)).toBe(1);
    expect(await countBreached(database.pool)).toBe(1);
  });

  it('OBS-04 a marca sli_breached_at vem do relógio do banco, no instante da verificação', async () => {
    const orderId = await seedOrder(database.pool, { acceptedAgoSeconds: 90 });
    const { monitor } = buildMonitor();

    await monitor.checkOnce();

    const result = await database.pool.query<{ elapsed: number }>(
      `select extract(epoch from (now() - sli_breached_at))::float8 as elapsed
         from orders where id = $1`,
      [orderId],
    );
    const elapsed = result.rows[0]?.elapsed;
    expect(elapsed, 'o pedido ficou com a marca').toBeDefined();
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(30);
  });

  it.each(COUNTS)('OBS-04 %s: conta', async (_label, seed) => {
    const result = await checkSingle(seed);

    expect(result.marked).toBe(1);
    expect(result.breached).toEqual([result.orderId]);
    expect(result.counted).toBe(1);
  });

  it.each(DOES_NOT_COUNT)(
    'OBS-04 %s: não conta nem marca',
    async (_label, seed) => {
      const result = await checkSingle(seed);

      expect(result.marked).toBe(0);
      expect(result.breached).toEqual([]);
      expect(result.counted).toBe(0);
    },
  );

  it('OBS-04 o pedido que já tem a marca não é contado de novo e a marca antiga fica como estava', async () => {
    const orderId = await seedOrder(database.pool, {
      acceptedAgoSeconds: 600,
      alreadyBreached: true,
    });
    const before = await database.pool.query<{ marked: Date }>(
      'select sli_breached_at as marked from orders where id = $1',
      [orderId],
    );
    const { monitor, telemetry } = buildMonitor();

    expect(await monitor.checkOnce()).toBe(0);

    const after = await database.pool.query<{ marked: Date }>(
      'select sli_breached_at as marked from orders where id = $1',
      [orderId],
    );
    expect(after.rows[0]?.marked).toEqual(before.rows[0]?.marked);
    expect(await stuckCount(telemetry)).toBe(0);
  });

  it('OBS-04 numa mistura de pedidos só os atrasados são marcados e contados, e a chamada devolve quantos marcou', async () => {
    const delayed: string[] = [];
    for (const [, seed] of COUNTS)
      delayed.push(await seedOrder(database.pool, seed));
    for (const [, seed] of DOES_NOT_COUNT) await seedOrder(database.pool, seed);
    const { monitor, telemetry } = buildMonitor();

    expect(await monitor.checkOnce()).toBe(COUNTS.length);

    expect(await breachedIds(database.pool)).toEqual([...delayed].sort());
    expect(await stuckCount(telemetry)).toBe(COUNTS.length);
  });

  it('OBS-04 o lote é de até batchSize pedidos por verificação, e as seguintes terminam o trabalho sem contar nada duas vezes', async () => {
    for (let index = 0; index < 5; index += 1)
      await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    const { monitor, telemetry } = buildMonitor({ config: { batchSize: 2 } });

    const first = await monitor.checkOnce();
    const second = await monitor.checkOnce();
    const third = await monitor.checkOnce();
    const fourth = await monitor.checkOnce();

    expect([first, second, third, fourth]).toEqual([2, 2, 1, 0]);
    expect(await countBreached(database.pool)).toBe(5);
    expect(await stuckCount(telemetry)).toBe(5);
  });

  it('OBS-04 o counter não leva atributo: nenhuma série com orderId, e a série é uma só', async () => {
    await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    await seedOrder(database.pool, { acceptedAgoSeconds: 130 });
    const { monitor, telemetry } = buildMonitor();

    await monitor.checkOnce();

    const families = await scrapeMetrics(telemetry);
    const family = families.get('casecellshop_order_stuck_total');
    expect(family?.type).toBe('counter');
    expect(family?.samples).toHaveLength(1);
    expect(family?.samples[0]?.labels).toEqual({});
  });

  it('OBS-04 o pedido que uma conclusão trava não faz a verificação esperar e entra na verificação seguinte', async () => {
    const locked = await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    const free = await seedOrder(database.pool, { acceptedAgoSeconds: 130 });
    const { monitor, telemetry } = buildMonitor();

    const holder = await database.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from orders where id = $1 for update', [
        locked,
      ]);

      const during = await within(
        monitor.checkOnce(),
        'a verificação não esperar o pedido travado',
        10_000,
      );

      expect(during).toBe(1);
      expect(await breachedIds(database.pool)).toEqual([free]);
      expect(await stuckCount(telemetry)).toBe(1);
    } finally {
      await holder.query('rollback');
      holder.release();
    }

    expect(await monitor.checkOnce()).toBe(1);
    expect(await breachedIds(database.pool)).toEqual([locked, free].sort());
    expect(await stuckCount(telemetry)).toBe(2);
  });
});

describe('OBS-04 várias réplicas da API contam cada pedido uma vez', () => {
  function replicas(): { monitor: StuckOrderMonitor; telemetry: Telemetry }[] {
    const built: { monitor: StuckOrderMonitor; telemetry: Telemetry }[] = [];
    for (let index = 0; index < REPLICAS; index += 1) {
      // Cada réplica tem o pool e a telemetria dela, como processos separados.
      const pool = database.newPool();
      extraPools.push(pool);
      built.push(buildMonitor({ pool }));
    }
    return built;
  }

  async function totalCounted(
    built: { telemetry: Telemetry }[],
  ): Promise<number> {
    let total = 0;
    for (const { telemetry } of built) total += await stuckCount(telemetry);
    return total;
  }

  it(`OBS-04 ${REPLICAS} réplicas verificando ao mesmo tempo os mesmos pedidos atrasados contam cada um uma vez no total`, async () => {
    const built = replicas();

    for (let round = 0; round < ROUNDS; round += 1) {
      for (let index = 0; index < ORDERS_PER_ROUND; index += 1)
        await seedOrder(database.pool, { acceptedAgoSeconds: 90 });

      const marked = await Promise.all(
        built.map(({ monitor }) => monitor.checkOnce()),
      );

      expect(
        marked.reduce((sum, value) => sum + value, 0),
        `pedidos marcados na rodada ${round}`,
      ).toBe(ORDERS_PER_ROUND);
    }

    const delayed = ROUNDS * ORDERS_PER_ROUND;
    expect(countedOnce(await totalCounted(built), delayed)).toBe(true);
    expect(await countBreached(database.pool)).toBe(delayed);
    // Uma verificação a mais, em qualquer réplica, não acha nada para contar.
    for (const { monitor } of built) expect(await monitor.checkOnce()).toBe(0);
    expect(await totalCounted(built)).toBe(delayed);
  }, 120_000);

  it('OBS-04 controle negativo: a versão ingênua, com a janela forçada entre ler e marcar e sem o sli_breached_at IS NULL no UPDATE, conta cada pedido uma vez por réplica', async () => {
    const pools: pg.Pool[] = [];
    for (let index = 0; index < REPLICAS; index += 1) {
      const pool = database.newPool();
      extraPools.push(pool);
      pools.push(pool);
    }
    for (let index = 0; index < ORDERS_PER_ROUND; index += 1)
      await seedOrder(database.pool, { acceptedAgoSeconds: 90 });
    const barrier = createBarrier(REPLICAS);

    const counts = await Promise.all(
      pools.map((pool) => naiveCheck(pool, barrier)),
    );

    // Todas leram os mesmos pedidos antes de qualquer marca; o UPDATE sem a guarda marca e conta todos de novo.
    const total = counts.reduce((sum, value) => sum + value, 0);
    expect(total).toBe(REPLICAS * ORDERS_PER_ROUND);
    expect(
      countedOnce(total, ORDERS_PER_ROUND),
      'a invariante reprova a versão ingênua',
    ).toBe(false);
  });
});

// A janela forçada: cada chamada espera as outras terem lido, sem sleep.
function createBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived >= parties) open();
    return opened;
  };
}

// A versão ingênua do design: lê os candidatos, marca todos e conta o que o UPDATE devolveu, sem o
// `sli_breached_at IS NULL` repetido no UPDATE e sem o SKIP LOCKED.
async function naiveCheck(
  pool: pg.Pool,
  arrive: () => Promise<void>,
): Promise<number> {
  const candidates = await pool.query<{ id: string }>(
    `select id from orders
      where sli_breached_at is null
        and ((outcome_at is null and accepted_at <= now() - interval '60 seconds')
          or outcome_at > accepted_at + interval '60 seconds')`,
  );
  await arrive();
  const marked = await pool.query(
    `update orders set sli_breached_at = now()
      where id = any($1::uuid[])
      returning id`,
    [candidates.rows.map((row) => row.id)],
  );
  return marked.rowCount ?? 0;
}

describe('OBS-04 o laço da verificação roda pelo relógio injetável', () => {
  // O limiar de 60 s é constante na consulta (o índice parcial só é usado com o limiar constante), e por isso não é
  // um campo da configuração.
  it('OBS-04 a configuração padrão verifica a cada 10 s, em lotes de até 500, e o limiar de 60 s não é configurável', () => {
    expect(DEFAULT_STUCK_ORDER_MONITOR_CONFIG).toEqual({
      intervalMs: INTERVAL_MS,
      batchSize: 500,
    });
  });

  it('OBS-04 o start() verifica a cada intervalo do relógio manual e o stop() para o laço', async () => {
    const { clock, sleeps } = watchSleeps(createManualClock());
    const { monitor, telemetry } = buildMonitor({ clock });
    await seedOrder(database.pool, { acceptedAgoSeconds: 120 });

    await monitor.start();
    await waitAdvancing(clock.advanceToNext, async () => {
      expect(await stuckCount(telemetry)).toBe(1);
    });
    // O laço volta a dormir no relógio antes de uma segunda verificação.
    await vi.waitFor(
      () => {
        expect(clock.pendingWaits().length).toBeGreaterThan(0);
      },
      { timeout: WAIT_GUARD_MS, interval: 25 },
    );
    expect(new Set(sleeps)).toEqual(new Set([INTERVAL_MS]));

    const second = await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    await settle();
    expect(
      await countBreached(database.pool),
      'sem o relógio andar, o laço não verifica',
    ).toBe(1);
    clock.advance(INTERVAL_MS);
    await waitAdvancing(clock.advanceToNext, async () => {
      expect(await stuckCount(telemetry)).toBe(2);
    });
    expect(await breachedIds(database.pool)).toContain(second);

    await stopAdvancing(monitor, clock);
    const third = await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    clock.advance(INTERVAL_MS * 6);
    await settle();
    expect(clock.pendingWaits(), 'o laço parado não espera o relógio').toEqual(
      [],
    );
    expect(await stuckCount(telemetry)).toBe(2);
    expect(await breachedIds(database.pool)).not.toContain(third);
  });

  // Sem isso, cada SIGTERM deixaria a API parada até o fim do intervalo de 10 s antes de fechar o pool.
  it('OBS-04 o stop() acorda o laço que dorme entre as rodadas: resolve sem o relógio andar', async () => {
    const { clock } = watchSleeps(createManualClock());
    const { monitor } = buildMonitor({ clock });
    await monitor.start();
    await vi.waitFor(
      () => {
        expect(clock.pendingWaits(), 'o laço dormindo no relógio').toHaveLength(
          1,
        );
      },
      { timeout: WAIT_GUARD_MS, interval: 25 },
    );
    const before = clock.now();

    const stopping = track(monitor.stop());

    await vi.waitFor(
      () => {
        expect(stopping.settled, 'o stop() resolveu').toBe(true);
      },
      { timeout: WAIT_GUARD_MS, interval: 25 },
    );
    await stopping.result;
    expect(clock.now(), 'o relógio não andou').toBe(before);
  });

  it('OBS-04 uma falha da rodada no pool gera casecellshop.order.stuck_check.failed, não marca nada e a rodada seguinte funciona', async () => {
    const { clock } = watchSleeps(createManualClock());
    const logs = captureLogs('casecellshop-api');
    // A falha entra na fronteira: o UPDATE que marca os pedidos lança antes de chegar ao banco.
    const probe = interceptPool(database.pool, {
      match: /update\s+"?orders"?[\s\S]*sli_breached_at/i,
      fail: () => new Error('falha injetada no banco'),
      times: 1,
    });
    const { monitor, telemetry } = buildMonitor({
      pool: probe.pool,
      logger: logs.logger,
      clock,
    });
    await seedOrder(database.pool, { acceptedAgoSeconds: 120 });
    await seedOrder(database.pool, { acceptedAgoSeconds: 150 });

    await monitor.start();
    await waitAdvancing(clock.advanceToNext, () => {
      expect(
        logs.eventsOf('casecellshop.order.stuck_check.failed'),
      ).toHaveLength(1);
    });
    expect(probe.fired, 'a falha injetada disparou').toBe(1);
    const [failure] = logs.eventsOf('casecellshop.order.stuck_check.failed');
    expect(failure?.['level']).toBe('error');
    expect(JSON.stringify(failure?.['err'])).toContain('falha injetada');

    // A rodada seguinte marca os dois pedidos que a que falhou deixou: nem 0 (o laço parou), nem 4.
    await waitAdvancing(clock.advanceToNext, async () => {
      expect(await stuckCount(telemetry)).toBe(2);
    });
    expect(await countBreached(database.pool)).toBe(2);
    expect(logs.eventsOf('casecellshop.order.stuck_check.failed')).toHaveLength(
      1,
    );

    await stopAdvancing(monitor, clock);
  });
});

// Um nó do plano de `EXPLAIN (FORMAT JSON)`, só com os campos que o teste lê.
interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Rows Removed by Filter'?: number;
  'Actual Loops'?: number;
  Plans?: PlanNode[];
}

function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

// Linhas que os nós sobre `orders` leram e descartaram pelo filtro. O PostgreSQL informa a média por volta do nó.
function removedByFilter(nodes: PlanNode[]): number {
  return nodes
    .filter((node) => node['Relation Name'] === 'orders')
    .reduce(
      (sum, node) =>
        sum +
        (node['Rows Removed by Filter'] ?? 0) * (node['Actual Loops'] ?? 1),
      0,
    );
}

const ON_TIME_ORDERS = 5000;
const DELAYED_ORDERS = 4;

describe('OBS-04 a verificação não relê os pedidos entregues no prazo', () => {
  // Manual do PostgreSQL, "Partial Indexes": o índice parcial só entra no plano se a consulta implica o predicado
  // dele, e isso se decide no planejamento. O pedido faturado em até 60 s nunca recebe a marca; se ele ficar no
  // índice, cada rodada de 10 s, em cada réplica, o percorre e o descarta pelo filtro.
  it('OBS-04 o plano do UPDATE do monitor usa o índice parcial de orders e não descarta por filtro os pedidos entregues no prazo', async () => {
    await seedOrders(database.pool, ON_TIME_ORDERS, {
      acceptedAgoSeconds: 600,
      outcomeAfterSeconds: 30,
    });
    for (let index = 0; index < DELAYED_ORDERS / 2; index += 1) {
      await seedOrder(database.pool, { acceptedAgoSeconds: 120 + index });
      await seedOrder(database.pool, {
        acceptedAgoSeconds: 300 + index,
        outcomeAfterSeconds: 90,
      });
    }
    await database.pool.query('analyze orders');
    // O UPDATE de produção, com o texto e os parâmetros que ele manda ao banco.
    let captured: { text: string; values: readonly unknown[] } | undefined;
    const probe = interceptPool(database.pool, {
      match: /update\s+"?orders"?[\s\S]*sli_breached_at/i,
      times: 1,
      before: (text, values) => {
        captured = { text, values };
      },
    });
    const { monitor } = buildMonitor({ pool: probe.pool });
    expect(await monitor.checkOnce(), 'os atrasados foram marcados').toBe(
      DELAYED_ORDERS,
    );
    expect(probe.fired, 'o UPDATE do monitor foi capturado').toBe(1);
    // O plano é de uma tabela como a de antes da marca: os atrasados voltam a ficar sem ela.
    await database.pool.query('update orders set sli_breached_at = null');
    await database.pool.query('analyze orders');
    const partial = await database.pool.query<{ name: string }>(
      `select c.relname as name
         from pg_index i join pg_class c on c.oid = i.indexrelid
        where i.indrelid = 'orders'::regclass and i.indpred is not null`,
    );
    const partialIndexes = partial.rows.map((row) => row.name);

    // O ANALYZE do EXPLAIN executa o UPDATE: dentro de uma transação que termina em ROLLBACK, para a tabela ficar
    // como estava. Sem varredura sequencial, o plano mostra o caminho de índice que o planejador acha.
    const client = await database.pool.connect();
    let plan: PlanNode;
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const explained = await client.query<{
        'QUERY PLAN': { Plan: PlanNode }[];
      }>(`explain (analyze, format json) ${captured?.text ?? ''}`, [
        ...(captured?.values ?? []),
      ]);
      const root = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (!root) throw new Error('o EXPLAIN não devolveu um plano');
      plan = root;
    } finally {
      await client.query('rollback');
      client.release();
    }

    const nodes = planNodes(plan);
    const usedIndexes = nodes.flatMap((node) => node['Index Name'] ?? []);
    expect(
      usedIndexes.filter((name) => partialIndexes.includes(name)),
      `um índice parcial de orders no plano (índices usados: ${usedIndexes.join(', ')})`,
    ).toContain('orders_sli_pending_idx');
    expect(
      removedByFilter(nodes),
      'pedidos descartados pelo filtro nos nós sobre orders',
    ).toBeLessThan(ON_TIME_ORDERS);
  }, 120_000);
});
