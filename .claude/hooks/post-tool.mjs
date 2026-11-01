// PostToolUse do SubagentHandback e do Skill (.claude/settings.json). Grava o que
// os outros hooks conferem, sem passar pela sessão principal:
// - o relatório do reviewer em segundo plano, que chega no SubagentHandback e não
//   na mensagem final que o hook de parada recebe (AI-15);
// - o HEAD em que o /security-review abriu, que o github-guard exige para tirar o
//   PR do rascunho (AI-16).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { markHandback, saveReview, securityReviewDir } from './records.mjs';

function head(projectDir) {
  const run = spawnSync(
    'git',
    ['-C', projectDir, 'rev-parse', '--verify', '--quiet', 'HEAD'],
    { encoding: 'utf8' },
  );
  return run.status === 0 ? run.stdout.trim() : null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    input = null;
  }
  if (input === null || typeof input !== 'object') {
    process.stderr.write('post-tool: entrada do hook ilegível\n');
    process.exit(2);
  }

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const args = input.tool_input ?? {};

  if (
    input.tool_name === 'SubagentHandback' &&
    input.agent_type === 'reviewer'
  ) {
    if (typeof args.message === 'string' && args.message) {
      saveReview(projectDir, input.agent_id, args.message);
      markHandback(projectDir, input.agent_id);
    }
  }

  // Fora do git, ou sem commit, não há HEAD a registrar; o portão continua fechado.
  if (input.tool_name === 'Skill' && args.skill === 'security-review') {
    const sha = head(projectDir);
    if (sha) {
      mkdirSync(securityReviewDir(projectDir), { recursive: true });
      writeFileSync(
        join(securityReviewDir(projectDir), sha),
        `${new Date().toISOString()}\n`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
