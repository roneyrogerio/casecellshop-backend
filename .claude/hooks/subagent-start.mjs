// SubagentStart do implementer, do test-writer e do reviewer (AI-12): grava o
// retrato do git que o hook de parada compara. Roda também na retomada, e aí
// regrava, porque a sessão principal pode ter commitado entre as duas partes.
// Este evento não bloqueia; se o retrato não sair, a parada trata a falta como
// exceção, então aqui basta avisar com código 1 (o 2 não tem efeito neste evento).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotFile, takeSnapshot } from './git-snapshot.mjs';
import { rootFor } from './path-guard.mjs';

// AI-25: a worktree de um agente isolado nasce sem node_modules, e sem eles o
// lint, os tipos e os testes do hook de parada não rodam. Devolve se instalou.
export function ensureDependencies(dir, run) {
  if (existsSync(join(dir, 'node_modules'))) return false;
  run('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: dir });
  return true;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('subagent-start: entrada do hook ilegível; sem retrato do git, a parada registra exceção\n');
    process.exit(1);
  }
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
    const file = snapshotFile(input.session_id, input.agent_id);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(takeSnapshot(projectDir)));
    const root = rootFor(input, projectDir);
    if (root !== projectDir) ensureDependencies(root, (command, args, options) => spawnSync(command, args, { ...options, stdio: 'ignore' }));
  } catch (error) {
    process.stderr.write(`subagent-start: retrato do git não gravado (${error.message})\n`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
