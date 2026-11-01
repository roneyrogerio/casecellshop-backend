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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HealthStatus } from '../../../src/contract/index.ts';
import {
  expectMatchesContract,
  findRoute,
  observeFetchResponse,
} from '../../helpers/contract.ts';

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

type ComposeContainer = ReturnType<
  StartedDockerComposeEnvironment['getContainer']
>;

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
      label: [
        `com.docker.compose.project=${projectName}`,
        `com.docker.compose.service=${service}`,
      ],
    },
  });
  expect(found, `contêiner do serviço ${service} não encontrado`).toHaveLength(
    1,
  );
  return client.container.getById(found[0]!.Id).inspect();
}

const execFileAsync = promisify(execFile);

// Mesmo projeto, arquivo e variáveis do up, para o CLI achar os contêineres do teste.
async function composeCli(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['compose', '-p', projectName, '-f', 'compose.yaml', ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        JAEGER_UI_PORT: String(jaegerUiPort),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return `${stdout}${stderr}`;
}

// Os logs dos serviços do projeto, menos o do Jaeger, que só enche a saída. Os nomes vêm do próprio
// compose.yaml (e não de uma lista fixa): um serviço que o arquivo ainda não tem faria o `logs` inteiro
// falhar. Lança se o CLI falhar.
async function readServiceLogs(): Promise<string> {
  const services = (await composeCli(['config', '--services']))
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => /^[\w-]+$/.test(name) && name !== 'jaeger');
  return composeCli([
    'logs',
    '--no-color',
    '--timestamps',
    '--tail',
    '200',
    ...services,
  ]);
}

async function collectServiceLogs(): Promise<string> {
  try {
    return await readServiceLogs();
  } catch (error) {
    return `não foi possível ler os logs dos serviços: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// Guarda o último instantâneo dos logs enquanto o up roda. Cobre o caminho em que o `docker compose up`
// passa e a espera do Testcontainers (healthcheck) falha: ele já derrubou o projeto, com
// `removeVolumes`, antes de o erro chegar aqui, e um `logs` feito depois não encontra mais nada.
function watchServiceLogs(): { latest(): string; stop(): Promise<void> } {
  let latest = '';
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const snapshot = await readServiceLogs();
        if (snapshot.trim() !== '') latest = snapshot;
      } catch {
        // O projeto ainda não existe, ou já foi derrubado: fica o último instantâneo.
      }
      if (running)
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
  })();
  return {
    latest: () => latest,
    async stop() {
      running = false;
      await loop;
    },
  };
}

beforeAll(async () => {
  apiPort = await freePort();
  jaegerUiPort = await freePort();
  projectName = `ccs-fnd01-${randomBytes(4).toString('hex')}`;
  const watcher = watchServiceLogs();
  try {
    // Nome de projeto próprio e portas livres (API e interface do Jaeger): não conflita com o compose de desenvolvimento.
    environment = await new DockerComposeEnvironment(root, 'compose.yaml')
      .withProjectName(projectName)
      .withEnvironment({
        API_PORT: String(apiPort),
        JAEGER_UI_PORT: String(jaegerUiPort),
      })
      .withBuild()
      .withStartupTimeout(240_000)
      .up();
    await watcher.stop();
  } catch (error) {
    await watcher.stop();
    // O afterAll não derruba nada se o up lançou (environment fica indefinido): os logs são lidos
    // e o projeto é derrubado aqui, para não deixar contêineres e volume para trás. Dois caminhos:
    // o `up` do compose falhou (migrate com código diferente de 0): os contêineres seguem de pé e o
    // `logs` os lê; ou a espera falhou depois do `up`: o Testcontainers já fez o `down`, e vale o
    // último instantâneo do observador.
    const fresh = await readServiceLogs().catch(() => '');
    const logs =
      fresh.trim() !== ''
        ? fresh
        : `(instantâneo anterior ao down do Testcontainers)\n${watcher.latest()}`;
    await composeCli(['down', '--volumes', '--timeout', '5']).catch(
      () => undefined,
    );
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}\n\n--- logs dos serviços (últimas 200 linhas de cada) ---\n${logs}`,
      { cause: error },
    );
  }
}, 480_000);

// Terceiro caminho: o up e a espera passam e uma asserção falha. Os contêineres ainda estão de pé
// (o afterAll os derruba), então os logs são lidos na hora da falha.
beforeEach(({ onTestFailed }) => {
  onTestFailed(async () => {
    console.error(
      `--- logs dos serviços no momento da falha (últimas 200 linhas de cada) ---\n${await collectServiceLogs()}`,
    );
  });
});

afterAll(async () => {
  await environment?.down({ removeVolumes: true, timeout: 5 });
}, 120_000);

describe('FND-01 docker compose up sobe tudo', () => {
  it('FND-01 sobem os serviços postgres, migrate, api e worker', async () => {
    for (const name of ['postgres-1', 'api-1', 'worker-1']) {
      expect(
        () => environment.getContainer(name),
        `serviço ausente: ${name}`,
      ).not.toThrow();
    }
    await inspectOneShot('migrate');
  });

  it('FND-01 o migrate termina com código 0 e os serviços postgres, api e worker seguem rodando', async () => {
    const migrate = (await inspectOneShot('migrate')).State;
    expect(migrate.Status).toBe('exited');
    expect(migrate.ExitCode).toBe(0);

    for (const name of ['postgres-1', 'api-1', 'worker-1']) {
      expect(
        (await inspect(environment.getContainer(name))).State.Running,
        `${name} deveria estar rodando`,
      ).toBe(true);
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

// ---------------------------------------------------------------- ElasticMQ (M3, AD-021)

// A porta do ElasticMQ não precisa ser publicada: os scripts abaixo rodam num contêiner descartável do
// serviço `worker` (mesma rede, mesmas variáveis SQS_ENDPOINT, AWS_REGION, BILLING_QUEUE_URL e
// BILLING_DLQ_URL), com o SDK da AWS que a imagem já traz. Assim o teste também prova a configuração
// que o worker recebe. Só o stdout conta: o CLI escreve o progresso no stderr.
async function runInWorkerImage(
  script: string,
  extraEnvironment: Record<string, string> = {},
): Promise<unknown> {
  const environmentFlags = Object.entries(extraEnvironment).flatMap(
    ([name, value]) => ['-e', `${name}=${value}`],
  );
  const { stdout } = await execFileAsync(
    'docker',
    [
      'compose',
      '-p',
      projectName,
      '-f',
      'compose.yaml',
      'run',
      '--rm',
      '--no-deps',
      '-T',
      ...environmentFlags,
      'worker',
      'node',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        JAEGER_UI_PORT: String(jaegerUiPort),
      },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const lastLine = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(lastLine) as unknown;
}

const INSPECT_QUEUES = `
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION });
const read = async (url, names) => (await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: names }))).Attributes;
console.log(JSON.stringify({
  queueUrl: process.env.BILLING_QUEUE_URL,
  dlqUrl: process.env.BILLING_DLQ_URL,
  billing: await read(process.env.BILLING_QUEUE_URL, ['VisibilityTimeout', 'RedrivePolicy', 'QueueArn']),
  dlq: await read(process.env.BILLING_DLQ_URL, ['QueueArn']),
}));
`;

const SEND_MESSAGE = `
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION });
await client.send(new SendMessageCommand({ QueueUrl: process.env.BILLING_QUEUE_URL, MessageBody: process.env.MESSAGE_BODY }));
console.log(JSON.stringify({ sent: true }));
`;

// Depois do restart o emulador leva um instante para voltar: o script tenta por até 40 s.
const FIND_MESSAGE = `
import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
const client = new SQSClient({ endpoint: process.env.SQS_ENDPOINT, region: process.env.AWS_REGION });
const deadline = Date.now() + 40000;
let lastError = null;
while (Date.now() < deadline) {
  try {
    const response = await client.send(new ReceiveMessageCommand({ QueueUrl: process.env.BILLING_QUEUE_URL, MaxNumberOfMessages: 10, WaitTimeSeconds: 2, VisibilityTimeout: 0 }));
    const bodies = (response.Messages ?? []).map((message) => message.Body);
    if (bodies.includes(process.env.MESSAGE_BODY)) { console.log(JSON.stringify({ found: true })); process.exit(0); }
  } catch (error) { lastError = String(error); }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log(JSON.stringify({ found: false, lastError }));
`;

interface QueueInspection {
  queueUrl: string;
  dlqUrl: string;
  billing: {
    VisibilityTimeout: string;
    RedrivePolicy: string;
    QueueArn: string;
  };
  dlq: { QueueArn: string };
}

describe('FND-01 ElasticMQ com a fila do faturamento (M3)', () => {
  it('FND-01 sobe o elasticmq e ele começa antes do worker', async () => {
    expect(
      () => environment.getContainer('elasticmq-1'),
      'serviço ausente: elasticmq-1',
    ).not.toThrow();
    const elasticmq = (await inspect(environment.getContainer('elasticmq-1')))
      .State;
    const worker = (await inspect(environment.getContainer('worker-1'))).State;

    expect(elasticmq.Running).toBe(true);
    expect(Date.parse(elasticmq.StartedAt)).toBeLessThanOrEqual(
      Date.parse(worker.StartedAt),
    );
  });

  it('FND-01 as filas billing e billing-dlq já existem, a billing com visibilidade de 60 s e redrive para a DLQ com maxReceiveCount 12', async () => {
    const inspection = (await runInWorkerImage(
      INSPECT_QUEUES,
    )) as QueueInspection;

    expect(new URL(inspection.queueUrl).pathname.endsWith('/billing')).toBe(
      true,
    );
    expect(new URL(inspection.dlqUrl).pathname.endsWith('/billing-dlq')).toBe(
      true,
    );
    expect(Number(inspection.billing.VisibilityTimeout)).toBe(60);
    const redrive = JSON.parse(inspection.billing.RedrivePolicy) as {
      deadLetterTargetArn: string;
      maxReceiveCount: number | string;
    };
    expect(redrive.deadLetterTargetArn).toBe(inspection.dlq.QueueArn);
    expect(Number(redrive.maxReceiveCount)).toBe(12);
  });

  // Por último: o restart muda o estado do emulador, e o worker fica parado para os testes que viessem depois.
  it('FND-01 uma mensagem enviada à billing continua lá depois de docker compose restart elasticmq', async () => {
    // O worker do compose consome a billing: ele receberia esta mensagem (que não passa no schema do
    // faturamento), a deixaria sem resposta e ela ficaria invisível por 60 s, e a leitura abaixo não a
    // acharia. Com o worker parado, só o teste lê a fila, e o que se prova é a persistência no volume.
    // O `run` dos scripts usa o serviço só pela imagem e pela configuração (--no-deps), então segue valendo.
    await composeCli(['stop', '--timeout', '10', 'worker']);
    const body = `persistencia-${randomBytes(6).toString('hex')}`;
    await runInWorkerImage(SEND_MESSAGE, { MESSAGE_BODY: body });

    await composeCli(['restart', '--timeout', '10', 'elasticmq']);

    expect(
      await runInWorkerImage(FIND_MESSAGE, { MESSAGE_BODY: body }),
    ).toEqual({ found: true });
  }, 180_000);
});
