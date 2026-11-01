// PostToolUse do Edit e do Write (AI-34): formata o arquivo que acabou de ser
// editado, para o agente já trabalhar sobre o código no formato do projeto.
// Formatar aqui é conveniência: a garantia é o prettier --check do pre-push e
// do CI, então o hook nunca falha a ferramenta.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Devolve o caminho a formatar, ou null quando a ferramenta não editou arquivo.
export function targetToFormat(input) {
  if (input?.tool_name !== 'Edit' && input?.tool_name !== 'Write') return null;
  const file = input.tool_input?.file_path;
  return typeof file === 'string' && file !== '' ? file : null;
}

function main() {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const file = targetToFormat(input);
    if (!file) return;
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
    // O .prettierignore e o .prettierrc.json são achados a partir do arquivo.
    spawnSync(join(projectDir, 'node_modules', '.bin', 'prettier'), ['--write', '--ignore-unknown', file], {
      cwd: projectDir,
      stdio: 'ignore',
    });
  } catch {
    // Sem formatar, o --check do pre-push e do CI aponta o arquivo.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
  process.exit(0);
}
