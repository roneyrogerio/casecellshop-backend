import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';

// Prazo do processo filho. Sem ele, um filho travado (git esperando credencial, oxlint em laço) prende o teste até o
// testTimeout do Vitest, ou para sempre num teste sem prazo (FND-13, "Processos").
const COMMAND_TIMEOUT_MS = 60_000;

type CommandOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  'encoding' | 'timeout'
> & {
  // Quem precisa de mais (ou de menos) tempo diz aqui; o padrão é o COMMAND_TIMEOUT_MS.
  timeout?: number;
};

// Única porta de entrada dos testes de repositório e dos ajudantes para rodar um processo de forma síncrona: sempre
// com `timeout` e a saída em texto. O `no-restricted-imports` do .oxlintrc.json proíbe o `spawnSync`, o `execSync` e
// o `execFileSync` de `node:child_process` nessas pastas, salvo neste arquivo.
export function runCommand(
  bin: string,
  args: readonly string[],
  options: CommandOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(bin, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
  });
}

export interface NodeRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface NodeRunOptions {
  cwd: string;
  // O ambiente inteiro do processo filho, e não um acréscimo: quem chama decide o que herdar do processo do teste.
  env: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
}

// Roda `node <script> <args>` de forma síncrona, com a saída em texto. É o único ponto dos ajudantes que executam um
// script do repositório (CLI de scripts/, hook de .claude/hooks/); cada um deles só escolhe o ambiente.
export function runNode(
  script: string,
  args: string[],
  options: NodeRunOptions,
): NodeRun {
  const result = runCommand(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Roda um hook de .claude/hooks/ como o Claude Code o roda: o JSON do evento na entrada padrão, o projeto em
// CLAUDE_PROJECT_DIR e como diretório de trabalho. O que o Claude Code vê é o código de saída e os dois fluxos.
export function runHook(hook: string, project: string, raw: string): HookRun {
  const result = runNode(hook, [], {
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    input: raw,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
