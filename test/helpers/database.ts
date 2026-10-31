import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  uri: string;
  // Pool da loja e pool do ERP simulado, no mesmo banco, como no compose.
  pool: pg.Pool;
  erpPool: pg.Pool;
  stop(): Promise<void>;
}

export function createPool(uri: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: uri, max: 5 });
  // Um erro de conexão ociosa não pode derrubar o processo do teste.
  pool.on('error', () => undefined);
  return pool;
}

// PostgreSQL real com as migrações dos dois schemas aplicadas. Cada arquivo de
// teste sobe o próprio contêiner e cria os dados que usa; nada de seed.
export async function startMigratedDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18.6').start();
  const uri = container.getConnectionUri();
  const pool = createPool(uri);
  const erpPool = createPool(uri);
  try {
    await migrate(pool);
  } catch (error) {
    // Sem isto, um migrate que falha deixaria o contêiner e os pools vivos até o fim da suíte.
    await pool.end();
    await erpPool.end();
    await container.stop();
    throw error;
  }
  return {
    container,
    uri,
    pool,
    erpPool,
    async stop() {
      await pool.end();
      await erpPool.end();
      await container.stop();
    },
  };
}
