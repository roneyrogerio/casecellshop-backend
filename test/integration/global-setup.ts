import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/db/migrate.ts';
import { composeImage } from '../helpers/compose-image.ts';
import { startElasticMqContainer } from '../helpers/elasticmq-container.ts';
import { createTestPool } from '../helpers/pool.ts';

// O que o setup passa aos arquivos de teste (FND-14): lido com `inject` em test/helpers/.
declare module 'vitest' {
  export interface ProvidedContext {
    // Conexão de administração do PostgreSQL da rodada (superusuário, banco padrão).
    pgAdminUri: string;
    // Banco modelo, já migrado: cada arquivo o clona com CREATE DATABASE … TEMPLATE.
    pgTemplateDatabase: string;
    // Endpoint do ElasticMQ da rodada.
    elasticMqEndpoint: string;
  }
}

const TEMPLATE_DATABASE = 'casecellshop_template';
const TEMPLATE_IDLE_TIMEOUT_MS = 10_000;

// O CREATE DATABASE … TEMPLATE reprova (55006) com qualquer sessão no modelo. Fechar o pool não basta:
// o servidor leva um instante para encerrar o backend de um cliente que já saiu.
async function waitForEmptyTemplate(admin: pg.Client): Promise<void> {
  const deadline = Date.now() + TEMPLATE_IDLE_TIMEOUT_MS;
  for (;;) {
    const result = await admin.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE datname = $1',
      [TEMPLATE_DATABASE],
    );
    if (result.rows[0]?.total === 0) return;
    if (Date.now() > deadline)
      throw new Error(
        `ainda há conexão no banco modelo ${TEMPLATE_DATABASE}; o clone reprovaria`,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  // Os dois contêineres sobem juntos; o modelo só depende do PostgreSQL.
  const [postgres, elasticMq] = await Promise.all([
    new PostgreSqlContainer(composeImage('postgres')).start(),
    startElasticMqContainer(),
  ]);
  try {
    const adminUri = postgres.getConnectionUri();
    const admin = new pg.Client({ connectionString: adminUri });
    admin.on('error', () => undefined);
    await admin.connect();
    try {
      // Nome fixo e sem entrada externa: o identificador vai entre aspas.
      await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
      const templateUri = new URL(adminUri);
      templateUri.pathname = `/${TEMPLATE_DATABASE}`;
      const pool = createTestPool(templateUri.href, { max: 2 });
      try {
        await migrate(pool);
      } finally {
        await pool.end();
      }
      await waitForEmptyTemplate(admin);
    } finally {
      await admin.end();
    }
    project.provide('pgAdminUri', adminUri);
    project.provide('pgTemplateDatabase', TEMPLATE_DATABASE);
    project.provide('elasticMqEndpoint', elasticMq.endpoint);
  } catch (error) {
    // Sem isto, um setup que falha deixaria os contêineres vivos depois da rodada.
    await Promise.allSettled([postgres.stop(), elasticMq.stop()]);
    throw error;
  }
  return async () => {
    await Promise.all([postgres.stop(), elasticMq.stop()]);
  };
}
