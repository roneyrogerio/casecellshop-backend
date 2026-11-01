import { spawnSync } from 'node:child_process';

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

// Roda `node <script> <args>` de forma síncrona, com a saída em texto. É o único `spawnSync` do node dos ajudantes que
// executam um script do repositório (CLI de scripts/, hook de .claude/hooks/); cada um deles só escolhe o ambiente.
export function runNode(
  script: string,
  args: string[],
  options: NodeRunOptions,
): NodeRun {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
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
