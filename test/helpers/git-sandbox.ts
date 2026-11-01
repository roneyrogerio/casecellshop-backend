import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Repositórios git temporários, offline, para os testes dos trilhos da fábrica (AI-08, AI-11, AI-12).
// O git roda sem hooks, sem assinatura e com identidade fixa, para a configuração da máquina não interferir.
const created: string[] = [];

const GIT_FLAGS = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@t',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'init.defaultBranch=main',
];

export function makeTempDir(prefix = 'sandbox-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  for (const dir of created.splice(0))
    rmSync(dir, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} falhou: ${result.stderr}`);
  return result.stdout;
}

export function writeFileIn(
  dir: string,
  relative: string,
  content: string,
): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Repositório com um commit na branch main.
export function initRepo(dir: string): void {
  git(dir, 'init', '-q');
  writeFileIn(dir, 'src/app.ts', 'export {};\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
}

// Um novo commit, vazio, para mudar o HEAD e a branch.
export function commitEmpty(dir: string, message = 'outro'): void {
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
}
