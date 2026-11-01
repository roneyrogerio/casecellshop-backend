import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, writeFileIn } from '../helpers/git-sandbox.ts';
import { newLintTree, oxlintBin } from '../helpers/lint-tree.ts';
import { repoRoot } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-48: o lint lê os arquivos ignorados só do .gitignore (`oxlint --ignore-path .gitignore`). O .eslintignore, que o
// oxlint leria por padrão, não pode calar o lint: a guarda o nega ao implementer (AI-04), e mesmo assim o script
// não o lê.
afterAll(cleanupTempDirs);

const LINT_SCRIPT = 'oxlint --ignore-path .gitignore';

const SQL_RAW =
  "declare const sql: { raw: (t: string) => unknown };\nexport const q = sql.raw('on_hand');\n";

interface Run {
  status: number | null;
  output: string;
}

function lintTree(eslintignore: string | null, args: string[]): Run {
  const tree = newLintTree('ai48-lint-');
  // O link para scripts/ existe só para o oxlint achar o plugin: o .gitignore o tira da varredura, que sem o
  // tsconfig do projeto acusaria os testes de lá por tipos.
  writeFileIn(tree, '.gitignore', 'node_modules/\nscripts/\n');
  writeFileIn(tree, 'src/x.ts', SQL_RAW);
  // Um arquivo limpo fora de src/: sem ele, o controle com tudo ignorado sairia com "nenhum arquivo para o lint".
  writeFileIn(tree, 'lib/ok.ts', 'export const ok = 1;\n');
  if (eslintignore !== null) writeFileIn(tree, '.eslintignore', eslintignore);
  const result = runCommand(oxlintBin, args, { cwd: tree });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe('AI-48 o lint não lê o .eslintignore', () => {
  it('AI-48 o script lint do package.json é exatamente `oxlint --ignore-path .gitignore`', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.lint).toBe(LINT_SCRIPT);
  }, 30_000);

  it('AI-48 com um .eslintignore com src/, o lint com --ignore-path .gitignore ainda reprova o sql.raw de src/', () => {
    const run = lintTree('src/\n', ['--ignore-path', '.gitignore']);
    expect(run.output).toContain('sql.raw');
    expect(run.status).not.toBe(0);
  }, 180_000);

  // Controle: sem a flag o oxlint lê o .eslintignore e cala o arquivo, o que prova que o teste anterior mede a flag.
  // Se este falhar, o oxlint desta versão não lê o .eslintignore e a premissa do critério deixou de valer.
  it('AI-48 controle: sem a flag, o mesmo .eslintignore cala o lint do arquivo', () => {
    const run = lintTree('src/\n', []);
    expect(run.output).not.toContain('sql.raw');
    expect(run.status).toBe(0);
  }, 180_000);

  // Controle da amostra: sem .eslintignore o sql.raw é reprovado pelo lint, com ou sem a flag.
  it('AI-48 controle: sem .eslintignore, a amostra com sql.raw reprova', () => {
    const run = lintTree(null, ['--ignore-path', '.gitignore']);
    expect(run.output).toContain('sql.raw');
    expect(run.status).not.toBe(0);
  }, 180_000);
});
