import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DockerComposeEnvironment,
  type StartedDockerComposeEnvironment,
} from 'testcontainers';
import { repoRoot as root } from './repo-root.ts';

const execFileAsync = promisify(execFile);

// FND-13: o compose recebe a porta 0 e o Docker escolhe a porta do host na hora do `up`. Escolher uma porta livre
// antes (um `listen(0)` seguido de `close`) deixa uma janela em que outro processo a ocupa, e o `up` falha com
// "address already in use" quando a máquina está carregada.
export const EPHEMERAL_PORT_ENV = {
  API_PORT: '0',
  JAEGER_UI_PORT: '0',
} as const;

// A porta que o Docker publicou no host para a porta do contêiner, lida depois do `up`.
export function publishedPort(
  environment: StartedDockerComposeEnvironment,
  container: string,
  containerPort: number,
): number {
  return environment.getContainer(container).getMappedPort(containerPort);
}

// O CLI do compose no mesmo projeto, arquivo e variáveis do `up`, para achar os contêineres do teste. Não sobe o
// projeto: o `up` só existe em `upComposeProject`, e é por ele que o detector de test/repo/node-floor.test.ts acha
// os testes que precisam da imagem do Dockerfile (FND-12). Um `runCompose(p, ['up'])` passaria despercebido por ele.
export async function runCompose(
  projectName: string,
  args: string[],
): Promise<string> {
  if (args.includes('up'))
    throw new Error(
      'runCompose não sobe o projeto: use upComposeProject, que o detector do FND-12 enxerga',
    );
  const { stdout, stderr } = await execFileAsync(
    'docker',
    ['compose', '-p', projectName, '-f', 'compose.yaml', ...args],
    {
      cwd: root,
      env: { ...process.env, ...EPHEMERAL_PORT_ENV },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  return `${stdout}${stderr}`;
}

// Sobe o compose com nome de projeto próprio e as portas do host escolhidas pelo Docker. Se o `up` falha, lê os
// logs dos serviços (`collectLogs`), derruba o projeto para não deixar contêineres e volume para trás, e relança o
// erro com os logs. `heading` diz de quais serviços e linhas eles vêm.
export async function upComposeProject(
  projectName: string,
  heading: string,
  collectLogs: () => Promise<string>,
): Promise<StartedDockerComposeEnvironment> {
  try {
    return await new DockerComposeEnvironment(root, 'compose.yaml')
      .withProjectName(projectName)
      .withEnvironment({ ...EPHEMERAL_PORT_ENV })
      .withBuild()
      .withStartupTimeout(240_000)
      .up();
  } catch (error) {
    const logs = await collectLogs();
    await runCompose(projectName, [
      'down',
      '--volumes',
      '--timeout',
      '5',
    ]).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${reason}\n\n--- ${heading} ---\n${logs}`, {
      cause: error,
    });
  }
}
