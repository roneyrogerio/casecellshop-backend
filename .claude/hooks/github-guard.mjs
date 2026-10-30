// PreToolUse das ferramentas MCP do GitHub (AI-08). Garante o que a lista de
// ferramentas do servidor não garante sozinha: PR nasce em rascunho, um
// relatório do reviewer chega ao PR exatamente como foi escrito, porque com MCP
// o corpo do comentário passa pelo modelo, e o PR só sai do rascunho depois do
// /security-review no commit que o dono vai ler (AI-16).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { securityReviewDir } from './records.mjs';

const SECURITY_REPORT = '## Revisão de segurança';

export function check(input, deps) {
  const tool = input.tool_name ?? '';
  const args = input.tool_input ?? {};

  if (tool.endsWith('__create_pull_request') && args.draft !== true) {
    return { allow: false, reason: 'O PR nasce em rascunho: chame create_pull_request com draft: true.' };
  }

  // Todo draft que não seja true tira do rascunho para o portão: um "false" ou um
  // 0 não pode passar por fora só por não ser o booleano.
  if (tool.endsWith('__update_pull_request') && 'draft' in args && args.draft !== true) {
    // O dono lê o que está no GitHub: o HEAD local precisa estar publicado, e o
    // registro do post-tool prova que o /security-review abriu nesse commit.
    const git = deps.git();
    if (!git) return { allow: false, reason: 'Sem git legível, o PR não sai do rascunho (AI-16).' };
    if (git.upstream !== git.head) {
      return {
        allow: false,
        reason: `O HEAD ${git.head} não está publicado na branch remota: faça o push antes de tirar o PR do rascunho (AI-16).`,
      };
    }
    if (!deps.securityReviewed(git.head)) {
      return {
        allow: false,
        reason: `Rode o /security-review no HEAD ${git.head} antes de tirar o PR do rascunho (AI-16).`,
      };
    }
  }

  if (tool.endsWith('__add_issue_comment')) {
    // Espaço no início e no fim não muda o relatório, e o caminho até a ferramenta
    // pode acrescentar uma quebra de linha final que o arquivo salvo não tem.
    const body = typeof args.body === 'string' ? args.body.trim() : '';
    // O relatório de segurança é escrito pela sessão principal; ele só vai ao PR
    // quando o /security-review abriu no HEAD atual (AI-16).
    if (body.startsWith(SECURITY_REPORT)) {
      const git = deps.git();
      if (git && deps.securityReviewed(git.head)) return { allow: true };
      return {
        allow: false,
        reason: 'O relatório de segurança só vai ao PR depois do /security-review no HEAD atual (AI-16).',
      };
    }
    // O outro comentário do fluxo é o relatório do reviewer, gravado por hook
    // (AI-15): qualquer corpo que não seja idêntico a um relatório salvo é
    // recusado.
    const saved = deps.reviewBodies().map((review) => review.trim());
    if (!body || !saved.includes(body)) {
      return {
        allow: false,
        reason:
          'Comentário diferente de todo relatório salvo em .claude/reviews/: o único comentário do fluxo é o relatório do reviewer, postado exatamente como ele o escreveu.',
      };
    }
  }

  return { allow: true };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // Sem entrada legível, recusa: deixar passar seria falhar aberto.
    process.stderr.write('github-guard: entrada do hook ilegível\n');
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const reviewsDir = join(projectDir, '.claude', 'reviews');
  const decision = check(input, {
    git: () => {
      const rev = (ref) => {
        const run = spawnSync('git', ['-C', projectDir, 'rev-parse', '--verify', '--quiet', ref], { encoding: 'utf8' });
        return run.status === 0 ? run.stdout.trim() : null;
      };
      const head = rev('HEAD');
      // O upstream é a referência remota local (@{u}), atualizada pelo próprio push.
      return head ? { head, upstream: rev('@{upstream}') } : null;
    },
    securityReviewed: (sha) => /^[0-9a-f]{40,64}$/.test(sha) && existsSync(join(securityReviewDir(projectDir), sha)),
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
