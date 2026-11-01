// PostToolUse do Edit e do Write (AI-34): formata o arquivo que acabou de ser
// editado, para o agente já trabalhar sobre o código no formato do projeto.
// Formatar aqui é conveniência: a garantia é o prettier --check do pre-push e
// do CI, então o hook nunca falha a ferramenta.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Devolve o caminho a formatar, ou null quando a ferramenta não editou arquivo.
export function targetToFormat(input) {
  if (input?.tool_name !== 'Edit' && input?.tool_name !== 'Write') return null;
  const file = input.tool_input?.file_path;
  return typeof file === 'string' && file !== '' ? file : null;
}

// O -- encerra as opções: um arquivo chamado --version.ts é caminho, não opção.
export function prettierArgs(file) {
  return ['--write', '--ignore-unknown', '--', file];
}

// Só um caminho absoluto dentro do projeto (as worktrees dos agentes moram
// nele). O ../ já resolvido e a comparação por pasta inteira impedem que uma
// irmã com o mesmo prefixo, como app-outro, conte como dentro de app.
function insideProject(file, projectDir) {
  if (!isAbsolute(file)) return false;
  const rel = relative(resolve(projectDir), resolve(file));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// Raiz do repositório ou da worktree que contém a pasta; null fora de um.
function repositoryRoot(dir) {
  const result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const file = targetToFormat(input);
    const projectDir =
      process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
    if (!file || !insideProject(file, projectDir)) return;
    // O Prettier lê o .prettierignore do cwd. O da pasta principal deixa
    // .claude/worktrees/ de fora, então o arquivo de um agente isolado é
    // formatado a partir da raiz da worktree dele.
    spawnSync(
      join(projectDir, 'node_modules', '.bin', 'prettier'),
      prettierArgs(file),
      {
        cwd: repositoryRoot(dirname(file)) ?? projectDir,
        stdio: 'ignore',
      },
    );
  } catch {
    // Sem formatar, o --check do pre-push e do CI aponta o arquivo.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
  process.exit(0);
}
