// PreToolUse das ferramentas MCP do GitHub (AI-08). Garante o que a lista de
// ferramentas do servidor não garante sozinha: PR nasce em rascunho, e um
// relatório do reviewer chega ao PR exatamente como foi escrito, porque com MCP
// o corpo do comentário passa pelo modelo.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REVIEW_HEADING = '## Revisão';

export function check(input, deps) {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};

  if (tool.endsWith('__create_pull_request') && args.draft !== true) {
    return { allow: false, reason: 'O PR nasce em rascunho: chame create_pull_request com draft: true.' };
  }

  if (tool.endsWith('__add_issue_comment')) {
    // Só o espaço antes do título é ignorado, porque não muda o relatório; do
    // título em diante, o texto tem de ser idêntico ao arquivo.
    const body = typeof args.body === 'string' ? args.body.trimStart() : '';
    const saved = deps.reviewBodies().map((review) => review.trimStart());
    if (body.startsWith(REVIEW_HEADING) && !saved.includes(body)) {
      return {
        allow: false,
        reason:
          'Relatório de revisão diferente do salvo em .claude/reviews/: poste o texto do arquivo, exatamente como o reviewer o escreveu.',
      };
    }
  }

  return { allow: true };
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const reviewsDir = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), '.claude', 'reviews');
  const decision = check(input, {
    reviewBodies: () =>
      existsSync(reviewsDir)
        ? readdirSync(reviewsDir)
            .filter((file) => file.endsWith('.md'))
            .map((file) => readFileSync(join(reviewsDir, file), 'utf8'))
        : [],
  });
  if (!decision.allow) {
    process.stderr.write(decision.reason);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
