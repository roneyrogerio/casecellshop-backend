import { spawnSync } from 'node:child_process';
import { cpSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { git, makeTempDir } from './git-sandbox.ts';
import { repoRoot } from './repo-root.ts';
import { type NodeRun, runNode } from './run-node.ts';

// Ambiente de teste da identidade (AI-14): o git não pode enxergar a configuração global nem a do sistema da máquina,
// senão a credencial real do dono entraria no teste.

// Chaveiro falso: `security` (macOS) e `secret-tool` (Linux) que saem com 1 sem imprimir nada, como um item inexistente.
// Vão no começo do PATH, para o teste nunca ler nem gravar no chaveiro real da máquina.
function fakeKeychainDir(): string {
  const dir = makeTempDir('fake-keychain-');
  for (const tool of ['security', 'secret-tool']) {
    writeFileSync(join(dir, tool), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  return dir;
}

export function isolatedEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const dir = makeTempDir('git-global-');
  const globalFile = join(dir, 'gitconfig');
  writeFileSync(globalFile, '');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !key.startsWith('GIT_CONFIG_') &&
      key !== 'CLAUDE_CODE_REMOTE'
    )
      env[key] = value;
  }
  const path = [fakeKeychainDir(), env.PATH ?? '']
    .filter((part) => part !== '')
    .join(delimiter);
  return {
    ...env,
    GIT_CONFIG_GLOBAL: globalFile,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: dir,
    PATH: path,
    ...extra,
  };
}

export function makeRepo(prefix = 'identity-'): string {
  const dir = makeTempDir(prefix);
  git(dir, 'init', '-q');
  return dir;
}

export function localConfig(dir: string, key: string): string | undefined {
  const result = spawnSync('git', ['config', '--local', '--get', key], {
    cwd: dir,
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// Credential helper falso, local, que responde sem rede: simula a credencial que já está guardada na máquina.
export function setFakeCredential(dir: string, password: string): void {
  git(
    dir,
    'config',
    '--local',
    'credential.helper',
    `!f() { echo username=u; echo password=${password}; }; f`,
  );
}

// Cópia dos scripts (sem os testes) em um repositório temporário: rodar o CLI de verdade sem tocar no clone real.
export function makeScriptsSandbox(): string {
  const dir = makeRepo('scripts-sandbox-');
  cpSync(join(repoRoot, 'scripts'), join(dir, 'scripts'), {
    recursive: true,
    filter: (source) => !source.endsWith('.test.ts'),
  });
  cpSync(join(repoRoot, 'package.json'), join(dir, 'package.json'));
  return dir;
}

// Roda `node <dir>/scripts/<script> <args>` com o ambiente isolado (git sem a configuração da máquina, chaveiro falso),
// a entrada padrão vazia e 20 s de limite. Difere do `runScript` de script-module.ts, que herda o ambiente do processo
// do teste (sem as variáveis do git) e não passa argumentos: aqui `env` substitui o ambiente isolado inteiro.
export function runIsolatedScript(
  dir: string,
  script: string,
  args: string[],
  options: { env?: Record<string, string>; input?: string } = {},
): NodeRun {
  return runNode(join(dir, 'scripts', script), args, {
    cwd: dir,
    env: options.env ?? isolatedEnv(),
    input: options.input ?? '',
    timeout: 20_000,
  });
}
