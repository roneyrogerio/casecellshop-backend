import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from './git-sandbox.ts';
import { repoRoot } from './repo-root.ts';

// Árvore temporária com o .oxlintrc.json e o plugin do projeto, por link e sem cópia: o oxlint resolve o plugin
// (jsPlugins) e os `files` dos overrides a partir da pasta da configuração, então a mesma configuração vale na árvore,
// e nada é escrito dentro do repositório (um lint em paralelo ou uma execução interrompida tropeçaria nele).
export function newLintTree(prefix: string): string {
  const dir = makeTempDir(prefix);
  // O import de 'kysely' das amostras e as regras com tipos resolvem a partir da pasta da amostra.
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'), 'dir');
  symlinkSync(join(repoRoot, 'scripts'), join(dir, 'scripts'), 'dir');
  symlinkSync(join(repoRoot, '.oxlintrc.json'), join(dir, '.oxlintrc.json'));
  return dir;
}

export const oxlintBin = join(repoRoot, 'node_modules', '.bin', 'oxlint');
