import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir, writeFileIn } from './git-sandbox.ts';
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

// Roda o tsc com o tsconfig.json do projeto (herdado por caminho absoluto) sobre um único `amostra.ts` numa árvore
// nova. `include` é refeito, `typeRoots` aponta para o repositório (fora dele os tipos do Node não são achados) e o
// `"type": "module"` vem de um package.json da árvore.
export function typecheckSample(
  prefix: string,
  content: string,
): { status: number | null; output: string } {
  const tree = makeTempDir(prefix);
  symlinkSync(
    join(repoRoot, 'node_modules'),
    join(tree, 'node_modules'),
    'dir',
  );
  writeFileIn(tree, 'package.json', JSON.stringify({ type: 'module' }));
  writeFileIn(
    tree,
    'tsconfig.json',
    JSON.stringify({
      extends: join(repoRoot, 'tsconfig.json'),
      compilerOptions: {
        typeRoots: [join(repoRoot, 'node_modules', '@types')],
      },
      include: ['amostra.ts'],
    }),
  );
  writeFileIn(tree, 'amostra.ts', content);
  const result = spawnSync(
    join(repoRoot, 'node_modules', '.bin', 'tsc'),
    ['--noEmit', '-p', join(tree, 'tsconfig.json')],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

export const oxlintBin = join(repoRoot, 'node_modules', '.bin', 'oxlint');

// Roda o oxlint com a configuração do projeto sobre um único arquivo `lib/x.ts` numa árvore nova (fora de `src/`, para
// as regras de `src/` não interferirem). Devolve o código de saída e a saída junta.
export function lintSampleFile(
  prefix: string,
  content: string,
): { status: number | null; output: string } {
  const tree = newLintTree(prefix);
  writeFileIn(tree, 'lib/x.ts', content);
  const result = spawnSync(oxlintBin, ['lib/x.ts'], {
    cwd: tree,
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr };
}
