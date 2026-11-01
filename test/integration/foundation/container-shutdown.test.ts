import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkDbTypes } from '../../../scripts/check-db-types.ts';
import { settle, WAIT_GUARD_MS } from '../../helpers/async.ts';
import { composeImage } from '../../helpers/compose-image.ts';
import {
  fixtureFolder,
  runPlainMigrator,
  startMigrationContainer,
} from '../../helpers/migration-database.ts';
import {
  createPoolWithoutErrorListener,
  createTestPool,
} from '../../helpers/pool.ts';
import { captureUncaught } from '../../helpers/uncaught.ts';

// FND-13, encerramento: parar o contêiner de um banco de teste não pode deixar escapar o 57P01 ("terminating
// connection due to administrator command"). Uma conexão ociosa de um pool sem ouvinte de `error` ainda aberta
// nessa hora vira uma uncaughtException, e o vitest reprova a execução inteira por um teste que já passou.

const TERMINATED = '57P01';

function codeOf(error: Error): unknown {
  return (error as { code?: unknown }).code;
}

// Pool com uma conexão ociosa aberta. Sem `onError` é o pool sem ouvinte do controle negativo; com ele, o pool de
// teste de sempre, mais o ouvinte que recebe os erros dela.
// `idleTimeoutMillis: 0` é necessário: o pg-pool fecha a conexão ociosa após 10.000 ms por padrão, e entre a criação
// do pool e o stop() rodam o migrador e o gerador de tipos, que com a máquina carregada passam disso. Sem conexão
// aberta, a testemunha não vê o servidor cair. O valor 0 faz o pg-pool nunca fechar a conexão ociosa.
async function idlePool(
  uri: string,
  onError?: (error: Error) => void,
): Promise<pg.Pool> {
  const config = { max: 1, idleTimeoutMillis: 0 };
  const pool = onError
    ? createTestPool(uri, config)
    : createPoolWithoutErrorListener(uri, config);
  if (onError) pool.on('error', onError);
  await pool.query('SELECT 1');
  return pool;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('FND-13 encerramento do contêiner de um banco de teste', () => {
  it('FND-13 controle negativo: um pool ocioso, aberto e sem ouvinte de erro quando o contêiner para, deixa escapar o 57P01 como uncaughtException', async () => {
    const container = await new PostgreSqlContainer(
      composeImage('postgres'),
    ).start();
    const leaked = await idlePool(container.getConnectionUri());
    const uncaught = captureUncaught();
    try {
      await container.stop();

      await vi.waitFor(
        () => expect(uncaught.errors.map(codeOf)).toContain(TERMINATED),
        { timeout: WAIT_GUARD_MS, interval: 50 },
      );
    } finally {
      uncaught.restore();
      await leaked.end().catch(() => undefined);
    }
  }, 120_000);

  it('FND-13 com o encerramento certo (pools do migrador, do gerador de tipos e dos bancos de teste terminados antes do stop()), nada escapa quando o contêiner para', async () => {
    const container = await startMigrationContainer();
    const witnessErrors: Error[] = [];
    // A testemunha é uma conexão ociosa no banco administrativo, com ouvinte: ela vê o servidor cair, e
    // qualquer outra conexão do contêiner teria visto o mesmo ao mesmo tempo.
    const witness = await idlePool(container.uri, (error) =>
      witnessErrors.push(error),
    );
    const database = await container.createDatabase();
    const outDir = mkdtempSync(path.join(tmpdir(), 'fnd13-'));
    tempDirs.push(outDir);
    // A tabela de controle da fixture fica num schema próprio: a do gerador de tipos reprovaria a migração "ausente".
    await runPlainMigrator(
      database.uri,
      fixtureFolder('basic', 'fnd13_controle'),
    );
    await checkDbTypes({ databaseUrl: database.uri, outDir, write: true });
    // Se a máquina estiver tão lenta que o pool fechou a testemunha, o teste deve falhar aqui, pela causa certa, e
    // não por "a testemunha não viu o servidor cair".
    expect({
      total: witness.totalCount,
      idle: witness.idleCount,
    }).toEqual({ total: 1, idle: 1 });
    const uncaught = captureUncaught();
    try {
      await container.stop();

      await vi.waitFor(() => expect(witnessErrors).not.toHaveLength(0), {
        timeout: WAIT_GUARD_MS,
        interval: 50,
      });
      await settle(20);
      expect(uncaught.errors).toEqual([]);
    } finally {
      uncaught.restore();
      await witness.end().catch(() => undefined);
    }
  }, 120_000);

  it('FND-13 um pool aberto e não encerrado antes do stop() reprova o stop() citando o banco, e o contêiner para mesmo assim', async () => {
    const container = await startMigrationContainer();
    const database = await container.createDatabase();
    const leaked = await idlePool(database.uri, () => undefined);
    try {
      await expect(container.stop({ graceMs: 1_000 })).rejects.toThrow(
        /fnd11_1/,
      );
    } finally {
      await leaked.end().catch(() => undefined);
    }
  }, 120_000);
});
