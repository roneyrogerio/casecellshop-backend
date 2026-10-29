import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  DockerComposeEnvironment,
  getContainerRuntimeClient,
  Wait,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthStatus } from '../../../src/contract/index.ts';
import { expectMatchesContract, findRoute, observeFetchResponse } from '../../helpers/contract.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));

let environment: StartedDockerComposeEnvironment;
let apiPort: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type ComposeContainer = ReturnType<StartedDockerComposeEnvironment['getContainer']>;

async function inspect(container: ComposeContainer) {
  const client = await getContainerRuntimeClient();
  return client.container.getById(container.getId()).inspect();
}

beforeAll(async () => {
  apiPort = await freePort();
  // Nome de projeto próprio e porta livre: não conflita com o compose de desenvolvimento.
  environment = await new DockerComposeEnvironment(root, 'compose.yaml')
    .withProjectName(`ccs-fnd01-${randomBytes(4).toString('hex')}`)
    .withEnvironment({ API_PORT: String(apiPort) })
    .withBuild()
    // O migrate é de execução única: esperar o fim dele com código 0, não uma porta.
    .withWaitStrategy('migrate-1', Wait.forOneShotStartup())
    .withStartupTimeout(240_000)
    .up();
}, 480_000);

afterAll(async () => {
  await environment?.down({ removeVolumes: true, timeout: 5 });
}, 120_000);

describe('FND-01 docker compose up sobe tudo', () => {
  it('FND-01 sobem os serviços postgres, migrate, api e worker', () => {
    for (const name of ['postgres-1', 'migrate-1', 'api-1', 'worker-1']) {
      expect(() => environment.getContainer(name), `serviço ausente: ${name}`).not.toThrow();
    }
  });

  it('FND-01 o migrate termina com código 0 e os serviços postgres, api e worker seguem rodando', async () => {
    const migrate = (await inspect(environment.getContainer('migrate-1'))).State;
    expect(migrate.Status).toBe('exited');
    expect(migrate.ExitCode).toBe(0);

    for (const name of ['postgres-1', 'api-1', 'worker-1']) {
      expect((await inspect(environment.getContainer(name))).State.Running, `${name} deveria estar rodando`).toBe(true);
    }
  });

  it('FND-01 as migrações terminam antes de a API e o worker subirem', async () => {
    const migrate = (await inspect(environment.getContainer('migrate-1'))).State;
    const api = (await inspect(environment.getContainer('api-1'))).State;
    const worker = (await inspect(environment.getContainer('worker-1'))).State;

    const finishedAt = Date.parse(migrate.FinishedAt);
    expect(finishedAt).toBeLessThanOrEqual(Date.parse(api.StartedAt));
    expect(finishedAt).toBeLessThanOrEqual(Date.parse(worker.StartedAt));
  });

  it('FND-01 o GET /health responde 200 pela porta publicada em API_PORT', async () => {
    const response = await fetch(`http://127.0.0.1:${apiPort}/health`);
    const observed = await observeFetchResponse(response);

    expect(observed.status).toBe(200);
    expect(HealthStatus.parse(observed.body)).toEqual({ status: 'ok' });
    expectMatchesContract(findRoute('get', '/health'), observed);
  });
});
