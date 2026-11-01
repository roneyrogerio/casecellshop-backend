import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';

export interface TestDatabase {
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

// Mesmo servidor da rodada (FND-14), outro banco.
export function uriOfDatabase(adminUri: string, name: string): string {
  const uri = new URL(adminUri);
  uri.pathname = `/${name}`;
  return uri.href;
}

// Roda uma instrução na conexão de administração e a fecha. Só recebe nomes gerados aqui ([a-z0-9_]) ou
// o nome do modelo que o globalSetup passou; nunca entrada externa, porque o identificador vai entre aspas.
async function runAsAdmin(statement: string): Promise<void> {
  const admin = new pg.Client({ connectionString: inject('pgAdminUri') });
  admin.on('error', () => undefined);
  await admin.connect();
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

// PostgreSQL real com as migrações dos dois schemas aplicadas. O contêiner é da rodada (globalSetup);
// cada arquivo clona o banco modelo, já migrado, num banco só dele e cria os dados que usa; nada de seed.
export async function startMigratedDatabase(): Promise<TestDatabase> {
  const name = `file_${randomUUID().replaceAll('-', '')}`;
  await runAsAdmin(
    `CREATE DATABASE "${name}" TEMPLATE "${inject('pgTemplateDatabase')}"`,
  );
  const uri = uriOfDatabase(inject('pgAdminUri'), name);
  const pool = createPool(uri);
  const erpPool = createPool(uri);
  return {
    uri,
    pool,
    erpPool,
    async stop() {
      // Os pools fecham antes do DROP: o FORCE derruba o que sobrar, mas um cliente derrubado emite 57P01.
      await pool.end();
      await erpPool.end();
      await runAsAdmin(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
