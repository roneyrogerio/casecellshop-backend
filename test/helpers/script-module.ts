import { spawnSync } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { repoRoot } from './repo-root.ts';
import { makeTempDir, writeFileIn } from './git-sandbox.ts';

// Carrega um script de scripts/ por import dinâmico. Enquanto o script não existe (ou não exporta a função), o teste
// reprova por asserção com uma mensagem clara, e não por erro de import que quebraria a coleta do arquivo.
export type ScriptModule = Record<string, unknown>;

export async function loadScript(file: string): Promise<ScriptModule> {
  const path = join(repoRoot, 'scripts', file);
  if (!existsSync(path)) return {};
  return (await import(pathToFileURL(path).href)) as ScriptModule;
}

export function exportedFn<T extends (...args: never[]) => unknown>(
  mod: ScriptModule,
  file: string,
  name: string,
): T {
  const fn = mod[name];
  if (typeof fn !== 'function')
    expect.fail(`scripts/${file} não existe ou não exporta a função ${name}`);
  return fn as T;
}

// Pasta temporária com uma cópia do script (e de scripts/lib, se ele importar de lá), para rodar o CLI sem tocar no
// repositório: a raiz do script é a pasta temporária, seja lida pelo cwd, seja pelo caminho do arquivo.
export function sandboxWithScript(file: string): string {
  const source = join(repoRoot, 'scripts', file);
  expect(existsSync(source), `scripts/${file} não existe`).toBe(true);
  const dir = makeTempDir('script-cli-');
  writeFileIn(dir, 'package.json', '{"type":"module"}\n');
  cpSync(source, join(dir, 'scripts', file), { recursive: true });
  const lib = join(repoRoot, 'scripts', 'lib');
  if (existsSync(lib))
    cpSync(lib, join(dir, 'scripts', 'lib'), { recursive: true });
  return dir;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Roda `node scripts/<file>` na pasta, com o ambiente limpo de variáveis do git da máquina.
export function runScript(
  dir: string,
  file: string,
  env: Record<string, string> = {},
): CliResult {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith('GIT_'),
    ),
  );
  const result = spawnSync(process.execPath, [join('scripts', file)], {
    cwd: dir,
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
