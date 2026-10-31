import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  DockerComposeEnvironment,
  getContainerRuntimeClient,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthStatus } from '../../../src/contract/index.ts';
import { expectMatchesContract, findRoute, observeFetchResponse } from '../../helpers/contract.ts';

const root = fileURLToPath(new URL('../../..', import.meta.url));

let environment: StartedDockerComposeEnvironment;
let projectName: string;
let apiPort: number;
let jaegerUiPort: number;

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

// O Testcontainers só lista contêineres em execução, e o migrate (execução única)
// já saiu: ele é buscado direto no Docker, com all: true, pelos labels do compose.
async function inspectOneShot(service: string) {
  const client = await getContainerRuntimeClient();
  const found = await client.container.dockerode.listContainers({
    all: true,
    filters: {
      label: [`com.docker.compose.project=${projectName}`, `com.docker.compose.service=${service}`],
    },
  });
  expect(found, `contêiner do serviço ${service} não encontrado`).toHaveLength(1);
  return client.container.getById(found[0]!.Id).inspect();
}

const execFileAsync = promisify(execFile);

// Mesmo projeto, arquivo e variáveis do up, para o CLI achar os contêineres do teste.
async function composeCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('docker', ['compose', '-p', projectName, '-f', 'compose.yaml', ...args], {
    cwd: root,
    env: { ...process.env, API_PORT: String(apiPort), JAEGER_UI_PORT: String(jaegerUiPort) },
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

// Quando o up falha (por exemplo "service migrate didn't complete successfully"), o erro do
// Testcontainers não traz a saída do serviço que caiu. Sem ela não há como achar a causa em CI.
async function collectServiceLogs(): Promise<string> {
  try {
    return await composeCli(['logs', '--no-color', '--timestamps', '--tail', '200', 'migrate', 'postgres', 'api', 'worker']);
  } catch (error) {
    return `não foi possível ler os logs dos serviços: ${error instanceof Error ? error.message : String(error)}`;
  }
}

beforeAll(async () => {
  apiPort = await freePort();
  jaegerUiPort = await freePort();
  projectName = `ccs-fnd01-${randomBytes(4).toString('hex')}`;
  try {
    // Nome de projeto próprio e portas livres (API e interface do Jaeger): não conflita com o compose de desenvolvimento.
    environment = await new DockerComposeEnvironment(root, 'compose.yaml')
      .withProjectName(projectName)
      .withEnvironment({ API_PORT: String(apiPort), JAEGER_UI_PORT: String(jaegerUiPort) })
      .withBuild()
      .withStartupTimeout(240_000)
      .up();
  } catch (error) {
    // O afterAll não derruba nada se o up lançou (environment fica indefinido): os logs são lidos
    // e o projeto é derrubado aqui, para não deixar contêineres e volume para trás.
    const logs = await collectServiceLogs();
    await composeCli(['down', '--volumes', '--timeout', '5']).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n\n--- logs dos serviços (migrate, postgres, api, worker; últimas 200 linhas) ---\n${logs}`, { cause: error });
  }
}, 480_000);

afterAll(async () => {
  await environment?.down({ removeVolumes: true, timeout: 5 });
}, 120_000);

describe('FND-01 docker compose up sobe tudo', () => {
  it('FND-01 sobem os serviços postgres, migrate, api e worker', async () => {
    for (const name of ['postgres-1', 'api-1', 'worker-1']) {
      expect(() => environment.getContainer(name), `serviço ausente: ${name}`).not.toThrow();
    }
    await inspectOneShot('migrate');
  });

  it('FND-01 o migrate termina com código 0 e os serviços postgres, api e worker seguem rodando', async () => {
    const migrate = (await inspectOneShot('migrate')).State;
    expect(migrate.Status).toBe('exited');
    expect(migrate.ExitCode).toBe(0);

    for (const name of ['postgres-1', 'api-1', 'worker-1']) {
      expect((await inspect(environment.getContainer(name))).State.Running, `${name} deveria estar rodando`).toBe(true);
    }
  });

  it('FND-01 as migrações terminam antes de a API e o worker subirem', async () => {
    const migrate = (await inspectOneShot('migrate')).State;
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
