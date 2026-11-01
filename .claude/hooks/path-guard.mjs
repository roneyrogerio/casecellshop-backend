// Guarda de caminho por papel. Roda no PreToolUse de Edit, Write e NotebookEdit
// (.claude/settings.json) e nega a edição fora do que o agente pode escrever.
// O agent_type só vem nas chamadas de subagente (ou com --agent); a sessão
// principal só encontra aqui a regra das pastas gravadas pelos hooks.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// O implementer não toca no que decide se o trabalho dele está certo (AI-04): os
// testes, a spec, o contrato e tudo que configura a verificação ou instrui os
// agentes. Um agente que pode editar o próprio avaliador consegue passar sem
// acertar; o METR registrou exatamente isso.
//
// Pastas e arquivos da raiz, pelo caminho:
export const PROTECTED_FROM_IMPLEMENTER = [
  '.specs',
  '.claude',
  '.github',
  'scripts',
  'src/contract',
  'openapi.yaml',
  'architecture.md',
  // Os hooks do git rodam nos commits e pushes da sessão principal, fora das
  // guardas dos agentes; a configuração do clone decide quais hooks rodam.
  '.githooks',
  '.git',
];

// Configurações valem em qualquer pasta (o oxlint aplica um .oxlintrc.json
// aninhado, e o Claude Code carrega um CLAUDE.md de subpasta), então estes se
// negam pelo nome do arquivo, onde quer que estejam.
const PROTECTED_NAMES = [
  /^\.oxlintrc(\..+)?$/,
  /^oxlint\.config\./,
  /^tsconfig.*\.json$/,
  /^vitest\.config\./,
  /^vite\.config\./,
  /^vitest\.workspace\./,
  /^commitlint\.config\./,
  /^redocly\.yaml$/,
  // O kysely-codegen lê esta configuração; ela mudaria os tipos gerados (FND-09).
  /^\.kysely-codegenrc(\..+)?$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^\.gitignore$/,
  /^\.mcp\.json$/,
  /^claude(\.local)?\.md$/,
  /^agents\.md$/,
];

function isProtected(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return PROTECTED_FROM_IMPLEMENTER.some((entry) => isUnder(rel, entry)) || PROTECTED_NAMES.some((re) => re.test(name));
}

// Testes unitários ficam ao lado do arquivo testado (CONVENTIONS.md, "Testes"),
// então o papel se decide também pelo nome do arquivo, e não só pela pasta.
export function isTestFile(rel) {
  return isUnder(rel, 'test') || rel.endsWith('.test.ts');
}

const RULES = {
  'test-writer': {
    allows: (rel) => isTestFile(rel),
    reason: 'O test-writer só edita testes: arquivos *.test.ts e test/ (AGENTS.md, "Guardrails").',
  },
  implementer: {
    allows: (rel) => !isTestFile(rel) && !isProtected(rel),
    reason:
      'O implementer não edita testes, specs, o contrato nem as instruções da IA (AGENTS.md, "Guardrails").',
  },
};

function isUnder(rel, entry) {
  return rel === entry || rel.startsWith(`${entry}/`);
}

// O hook de parada reaproveita a mesma regra para conferir o git status.
export function allows(agentType, rel) {
  const rule = RULES[agentType];
  return !rule || rule.allows(rel.toLowerCase());
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

// Pastas que só os hooks gravam (AI-15): o github-guard confia nos relatórios e
// nos registros que estão ali, então nenhuma sessão, a principal inclusive, as
// edita pelas ferramentas.
export const HOOK_OWNED = ['.claude/reviews', '.claude/state'];

export function hookOwned(rel) {
  return HOOK_OWNED.some((entry) => isUnder(rel.toLowerCase(), entry));
}

const HOOK_OWNED_REASON =
  '.claude/reviews/ e .claude/state/ são gravados só pelos hooks (AI-15): o relatório do reviewer e os registros não se editam à mão.';

// Em minúsculas porque o sistema de arquivos padrão do macOS não diferencia
// maiúsculas: "Test/x.ts" e "test/x.ts" são o mesmo arquivo.
function relativeTo(root, target) {
  return path
    .relative(root, path.resolve(root, target))
    .split(path.sep)
    .join('/')
    .toLowerCase();
}

// A decisão inteira, sem processo nem stdin: devolve o motivo da recusa, ou null
// para deixar passar. O main só lê a entrada e escreve a resposta do hook.
// root é a raiz das regras de papel (a worktree do agente isolado, AI-26);
// projectDir é a pasta principal, onde ficam as pastas gravadas pelos hooks,
// conferidas para qualquer sessão (AI-15).
export function decide(input, root, projectDir = root) {
  const rule = RULES[input.agent_type];
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!root || !target) return rule ? `${rule.reason} Caminho não informado.` : null;

  const rel = relativeTo(root, target);
  const fromProject = projectDir ? relativeTo(projectDir, path.resolve(root, target)) : rel;
  if (hookOwned(rel)) return `${HOOK_OWNED_REASON} Caminho: ${rel}`;
  if (hookOwned(fromProject)) return `${HOOK_OWNED_REASON} Caminho: ${fromProject}`;
  if (!rule) return null;
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return `${rule.reason} O caminho está fora do repositório.`;
  }
  return rule.allows(rel) ? null : `${rule.reason} Caminho: ${rel}`;
}

// AI-26: a raiz contra a qual o caminho é decidido. Para um agente isolado, é a
// raiz da worktree dele, tirada do cwd da entrada; vale só uma worktree do mesmo
// repositório da pasta principal, para um cwd qualquer não escolher a raiz.
export function rootFor(input, projectDir) {
  if (!input?.cwd || !projectDir) return projectDir;
  const top = gitOut(input.cwd, 'rev-parse', '--show-toplevel');
  if (!top || path.resolve(top) === path.resolve(projectDir)) return projectDir;
  const common = (dir) => {
    const value = gitOut(dir, 'rev-parse', '--git-common-dir');
    return value ? path.resolve(dir, value) : null;
  };
  const own = common(input.cwd);
  return own && own === common(projectDir) ? top : projectDir;
}

function gitOut(dir, ...args) {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    // Sem entrada legível não dá para saber o papel: o código 2 bloqueia a edição.
    process.stderr.write('path-guard: entrada do hook ilegível\n');
    process.exit(2);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const reason = decide(input, rootFor(input, projectDir), projectDir);
  if (reason) deny(reason);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
