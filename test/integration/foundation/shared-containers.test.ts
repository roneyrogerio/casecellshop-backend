import { randomUUID } from 'node:crypto';
import { CreateQueueCommand } from '@aws-sdk/client-sqs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import {
  startMigratedDatabase,
  uriOfDatabase,
  type TestDatabase,
} from '../../helpers/database.ts';
import {
  createBillingQueues,
  drain,
  newQueuePrefix,
  sendRaw,
  startElasticMq,
  type TestElasticMq,
} from '../../helpers/sqs.ts';

// Código do PostgreSQL para "o banco de origem está em uso por outras sessões".
const OBJECT_IN_USE = '55006';

let first: TestDatabase;
let second: TestDatabase;
// Dois "arquivos" no mesmo processo: cada um com o próprio cliente do ElasticMQ da rodada.
let fileA: TestElasticMq;
let fileB: TestElasticMq;
const scratchDatabases: string[] = [];
const adminPool = new pg.Pool({
  connectionString: inject('pgAdminUri'),
  max: 2,
});
adminPool.on('error', () => undefined);

beforeAll(async () => {
  [first, second] = await Promise.all([
    startMigratedDatabase(),
    startMigratedDatabase(),
  ]);
  fileA = await startElasticMq();
  fileB = await startElasticMq();
}, 120_000);

afterAll(async () => {
  for (const name of scratchDatabases) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await adminPool.end();
  await first?.stop();
  await second?.stop();
  await fileA?.stop();
  await fileB?.stop();
});

async function databaseExists(name: string): Promise<boolean> {
  const result = await adminPool.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM pg_database WHERE datname = $1',
    [name],
  );
  return result.rows[0]?.total === 1;
}

async function currentDatabase(pool: pg.Pool): Promise<string> {
  const result = await pool.query<{ name: string }>(
    'SELECT current_database() AS name',
  );
  return result.rows[0]?.name ?? '';
}

function scratchName(): string {
  const name = `fnd14_${randomUUID().replaceAll('-', '')}`;
  scratchDatabases.push(name);
  return name;
}

describe('FND-14 um PostgreSQL por rodada, um banco clonado por arquivo', () => {
  it('FND-14 o globalSetup passa ao arquivo as conexões da rodada e o modelo sem nenhuma sessão aberta', async () => {
    expect(inject('pgAdminUri')).toMatch(/^postgres(ql)?:\/\//);
    expect(inject('elasticMqEndpoint')).toMatch(/^http:\/\//);
    const template = inject('pgTemplateDatabase');
    expect(template).toMatch(/^[a-z0-9_]+$/);

    // Sem sessão no modelo, nenhum CREATE DATABASE … TEMPLATE reprova com 55006.
    const sessions = await adminPool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = $1',
      [template],
    );
    expect(sessions.rows[0]?.total).toBe(0);
  });

  it('FND-14 o banco clonado já vem com as migrações dos dois schemas, sem rodar o migrate', async () => {
    for (const database of [first, second]) {
      const tables = await database.pool.query<{ qualified: string }>(
        `SELECT table_schema || '.' || table_name AS qualified
           FROM information_schema.tables
          WHERE (table_schema, table_name) IN
                (('public', 'products'), ('public', 'kysely_migration'),
                 ('erp_sim', 'products'), ('erp_sim', 'kysely_migration'))`,
      );
      expect(tables.rows.map((row) => row.qualified).sort()).toEqual([
        'erp_sim.kysely_migration',
        'erp_sim.products',
        'public.kysely_migration',
        'public.products',
      ]);
      // Migrações aplicadas de verdade (não só a tabela de controle vazia) nos dois schemas.
      const applied = await database.pool.query<{ total: number }>(
        `SELECT (SELECT count(*) FROM public.kysely_migration)::int
              + (SELECT count(*) FROM erp_sim.kysely_migration)::int AS total`,
      );
      expect(applied.rows[0]?.total).toBeGreaterThanOrEqual(2);
    }
  });

  it('FND-14 dois arquivos que gravam o mesmo SKU, cada um no seu banco clonado, não se veem', async () => {
    expect(first.uri).not.toBe(second.uri);
    expect(await currentDatabase(first.pool)).not.toBe(
      await currentDatabase(second.pool),
    );

    const sku = `FND14-${randomUUID().slice(0, 8)}`;
    // A mesma chave primária nos dois bancos: se fosse o mesmo banco, o segundo INSERT violaria a PK.
    await first.pool.query(
      'INSERT INTO products (sku, name, price_cents) VALUES ($1, $2, $3)',
      [sku, 'do primeiro arquivo', 1000],
    );
    await second.pool.query(
      'INSERT INTO products (sku, name, price_cents) VALUES ($1, $2, $3)',
      [sku, 'do segundo arquivo', 2000],
    );
    await first.pool.query(
      'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, $3, $4)',
      [sku, 'ERP do primeiro', 1000, 1],
    );

    const seenByFirst = await first.pool.query<{ name: string }>(
      'SELECT name FROM products WHERE sku = $1',
      [sku],
    );
    const seenBySecond = await second.pool.query<{ name: string }>(
      'SELECT name FROM products WHERE sku = $1',
      [sku],
    );
    expect(seenByFirst.rows.map((row) => row.name)).toEqual([
      'do primeiro arquivo',
    ]);
    expect(seenBySecond.rows.map((row) => row.name)).toEqual([
      'do segundo arquivo',
    ]);
    // O que um grava no schema do ERP simulado também não aparece no outro.
    const erpSeenBySecond = await second.pool.query(
      'SELECT 1 FROM erp_sim.products WHERE sku = $1',
      [sku],
    );
    expect(erpSeenBySecond.rowCount).toBe(0);

    // E nada do que os arquivos gravam volta ao modelo: o próximo clone nasce sem o SKU.
    const third = await startMigratedDatabase();
    try {
      const seenByThird = await third.pool.query(
        'SELECT 1 FROM products WHERE sku = $1',
        [sku],
      );
      expect(seenByThird.rowCount).toBe(0);
    } finally {
      await third.stop();
    }
  });

  it('FND-14 o stop() apaga o banco do arquivo e não para o PostgreSQL da rodada', async () => {
    const database = await startMigratedDatabase();
    const name = await currentDatabase(database.pool);
    expect(await databaseExists(name)).toBe(true);

    await database.stop();

    expect(await databaseExists(name)).toBe(false);
    // O servidor segue de pé para os outros arquivos.
    expect((await adminPool.query('SELECT 1 AS ok')).rowCount).toBe(1);
  });

  it('FND-14 controle negativo: CREATE DATABASE … TEMPLATE reprova com uma conexão aberta no modelo, e passa depois de fechada', async () => {
    // Um modelo descartável, clonado do real: abrir conexão no modelo da rodada reprovaria o clone dos outros arquivos.
    const template = scratchName();
    await adminPool.query(
      `CREATE DATABASE "${template}" TEMPLATE "${inject('pgTemplateDatabase')}"`,
    );
    const session = new pg.Client({
      connectionString: uriOfDatabase(inject('pgAdminUri'), template),
    });
    session.on('error', () => undefined);
    await session.connect();
    try {
      const clone = scratchName();
      await expect(
        adminPool.query(`CREATE DATABASE "${clone}" TEMPLATE "${template}"`),
      ).rejects.toMatchObject({ code: OBJECT_IN_USE });
      expect(await databaseExists(clone)).toBe(false);
    } finally {
      await session.end();
    }

    // O servidor leva um instante para encerrar o backend do cliente que saiu.
    const clone = scratchName();
    await vi.waitFor(
      async () => {
        await adminPool.query(
          `CREATE DATABASE "${clone}" TEMPLATE "${template}"`,
        );
      },
      { timeout: 10_000 },
    );
    expect(await databaseExists(clone)).toBe(true);
  });
});

describe('FND-14 um ElasticMQ por rodada, filas com prefixo único por arquivo', () => {
  it('FND-14 o cliente do arquivo fala com o ElasticMQ da rodada', () => {
    expect(fileA.endpoint).toBe(inject('elasticMqEndpoint'));
    expect(fileB.endpoint).toBe(inject('elasticMqEndpoint'));
  });

  it('FND-14 controle negativo: o mesmo nome de fila nos dois arquivos, sem prefixo, faz um receber a mensagem do outro', async () => {
    const queueName = `fnd14-sem-prefixo-${randomUUID().slice(0, 8)}`;
    const urlOf = async (emq: TestElasticMq): Promise<string> => {
      const created = await emq.client.send(
        new CreateQueueCommand({ QueueName: queueName }),
      );
      return `${emq.endpoint}${new URL(created.QueueUrl ?? '').pathname}`;
    };
    const urlA = await urlOf(fileA);
    const urlB = await urlOf(fileB);
    expect(urlB).toBe(urlA);

    await sendRaw(fileA, urlA, 'mensagem do arquivo A');

    const receivedByB = await drain(fileB, urlB);
    expect(receivedByB.map((message) => message.body)).toEqual([
      'mensagem do arquivo A',
    ]);
  });

  it('FND-14 com o prefixo único por arquivo, a mesma fila lógica de dois arquivos são filas distintas', async () => {
    const prefixA = newQueuePrefix();
    const prefixB = newQueuePrefix();
    expect(prefixA).not.toBe(prefixB);

    const queuesA = await createBillingQueues(fileA, { queuePrefix: prefixA });
    const queuesB = await createBillingQueues(fileB, { queuePrefix: prefixB });
    expect(queuesA.queueUrl).not.toBe(queuesB.queueUrl);
    expect(queuesA.dlqUrl).not.toBe(queuesB.dlqUrl);
    expect(new URL(queuesA.queueUrl).pathname).toContain(`/${prefixA}billing-`);
    expect(new URL(queuesB.queueUrl).pathname).toContain(`/${prefixB}billing-`);

    await sendRaw(fileA, queuesA.queueUrl, 'mensagem do arquivo A');

    expect(await drain(fileB, queuesB.queueUrl)).toEqual([]);
    const receivedByA = await drain(fileA, queuesA.queueUrl);
    expect(receivedByA.map((message) => message.body)).toEqual([
      'mensagem do arquivo A',
    ]);
  });

  it('FND-14 sem opção, as filas do arquivo levam o prefixo do arquivo, o mesmo em todas as chamadas, e nomes novos a cada uma', async () => {
    const one = await createBillingQueues(fileA);
    const other = await createBillingQueues(fileA);
    const prefixOf = (queueUrl: string): string | undefined =>
      /\/(f[0-9a-f]{12}-)billing-/.exec(new URL(queueUrl).pathname)?.[1];

    expect(prefixOf(one.queueUrl)).toBeDefined();
    expect(prefixOf(one.queueUrl)).toBe(prefixOf(other.queueUrl));
    expect(prefixOf(one.dlqUrl)).toBe(prefixOf(one.queueUrl));
    // Cada chamada ainda cria filas novas (nome único por teste).
    expect(one.queueUrl).not.toBe(other.queueUrl);
  });
});
