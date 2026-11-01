import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  GenericContainer,
  getContainerRuntimeClient,
  TestContainers,
  Wait,
} from 'testcontainers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WAIT_GUARD_MS } from '../../helpers/async.ts';
import { composeImage } from '../../helpers/compose-image.ts';
import { repoRoot } from '../../helpers/repo-root.ts';

// FND-16, controle negativo de execução: o último item do critério promete que uma rota que responde 500, ou um
// erro fora de application/problem+json, reprova a execução (código de saída 1). Os testes de test/repo só conferem a
// forma do compose.yaml e dos workflows; aqui a imagem do serviço `schemathesis`, lida do compose.yaml (a versão mora
// só lá), roda de verdade contra servidores mínimos que o teste sobe no host. Se uma troca de imagem ou de opções
// fizesse o Schemathesis deixar de reprovar, este teste quebraria.

// O nome que o Testcontainers dá ao host dentro do contêiner, depois de TestContainers.exposeHostPorts.
const HOST_NAME = 'host.testcontainers.internal';
// Mesmos valores do compose.yaml na semente; poucos exemplos bastam, porque o servidor erra em toda requisição.
const SEED = '20261101';
const MAX_EXAMPLES = '3';
const SCHEMA_IN_CONTAINER = '/schema/openapi.yaml';
// Saída do Schemathesis quando alguma checagem reprova (a 2 é erro de uso, como opção inválida).
const EXIT_CHECK_FAILED = 1;

interface FuzzRun {
  exitCode: number;
  output: string;
  requests: number;
}

interface FakeApi {
  server: Server;
  port: number;
  requests: () => number;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) =>
            server.close(() => resolve()).closeAllConnections(),
          ),
      ),
  );
});

// O servidor responde sempre o mesmo status e Content-Type, e conta as requisições: a falha do Schemathesis só
// prova algo se ele chegou até aqui.
async function startFakeApi(
  status: number,
  contentType: string,
  body: string,
): Promise<FakeApi> {
  let received = 0;
  const server = createServer((request, response) => {
    received += 1;
    request.resume();
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, requests: () => received };
}

// Roda o contêiner até ele terminar e lê o código de saída no Docker. O openapi.yaml do repositório vai
// montado só para leitura, como no compose.yaml.
async function runSchemathesis(api: FakeApi, checks: string): Promise<FuzzRun> {
  await TestContainers.exposeHostPorts(api.port);
  const container = await new GenericContainer(composeImage('schemathesis'))
    .withBindMounts([
      {
        source: join(repoRoot, 'openapi.yaml'),
        target: SCHEMA_IN_CONTAINER,
        mode: 'ro',
      },
    ])
    .withCommand([
      'run',
      SCHEMA_IN_CONTAINER,
      '--url',
      `http://${HOST_NAME}:${api.port}`,
      '--checks',
      checks,
      '--seed',
      SEED,
      '--max-examples',
      MAX_EXAMPLES,
    ])
    // A espera de "one shot" do Testcontainers lança quando o código de saída não é 0, e é justamente o 1 que se
    // quer ler: espera-se o banner (a imagem subiu) e depois o término do contêiner pelo Docker.
    .withWaitStrategy(Wait.forLogMessage(/Schemathesis v/))
    .withStartupTimeout(WAIT_GUARD_MS)
    .start();
  try {
    const client = await getContainerRuntimeClient();
    const { StatusCode } = (await client.container
      .getById(container.getId())
      .wait()) as { StatusCode: number };
    const stream = await container.logs();
    let output = '';
    for await (const chunk of stream) output += String(chunk);
    return { exitCode: StatusCode, output, requests: api.requests() };
  } finally {
    await container.stop();
  }
}

beforeAll(async () => {
  // Traz a imagem antes dos testes: a primeira busca no registro pode passar do prazo de um teste.
  const warmup = await new GenericContainer(composeImage('schemathesis'))
    .withCommand(['--version'])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();
  await warmup.stop();
});

describe('FND-16 controle negativo de execução: o Schemathesis reprova com código de saída 1', () => {
  it('FND-16 uma API que responde 500 a tudo reprova a checagem not_a_server_error com código de saída 1', async () => {
    const api = await startFakeApi(500, 'text/plain', 'erro interno');

    const run = await runSchemathesis(api, 'not_a_server_error');

    expect(run.requests, run.output).toBeGreaterThan(0);
    expect(run.exitCode, run.output).toBe(EXIT_CHECK_FAILED);
  });

  it('FND-16 uma API que responde erro em application/json, e não em application/problem+json, reprova a checagem content_type_conformance com código de saída 1', async () => {
    const api = await startFakeApi(
      400,
      'application/json',
      JSON.stringify({ message: 'requisição inválida' }),
    );

    const run = await runSchemathesis(api, 'content_type_conformance');

    expect(run.requests, run.output).toBeGreaterThan(0);
    expect(run.exitCode, run.output).toBe(EXIT_CHECK_FAILED);
  });
});
