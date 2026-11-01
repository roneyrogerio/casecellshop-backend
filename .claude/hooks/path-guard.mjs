// Guarda de caminho por papel. Roda no PreToolUse de Edit, Write e NotebookEdit
// (.claude/settings.json) e nega a edição fora do que o agente pode escrever.
// O agent_type só vem nas chamadas de subagente (ou com --agent); a sessão
// principal só encontra aqui a regra das pastas gravadas pelos hooks.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { realPath } from './git-snapshot.mjs';

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
  // O Prettier acha a configuração subindo a partir do arquivo (AI-34).
  /^\.prettierrc(\..+)?$/,
  /^prettier\.config\./,
  /^\.prettierignore$/,
  // O oxlint lê o .eslintignore por padrão; o lint usa o .gitignore (AI-48), e
  // este nome fica negado para não voltar a ter efeito.
  /^\.eslintignore$/,
  // Código sem uso e código repetido (AI-35, AI-36): a configuração e a linha de
  // base decidem o que cada checagem enxerga.
  /^\.?knip(\.config)?\.(jsonc?|[cm]?[jt]s)$/,
  /^\.jscpd.*\.json$/,
  /^\.editorconfig$/,
  // O pnpm aceita o manifesto em YAML; outro manifesto ao lado mudaria os scripts.
  /^package\.yaml$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
  /^\.gitignore$/,
  /^\.mcp\.json$/,
  /^claude(\.local)?\.md$/,
  /^agents\.md$/,
];

function isProtectedName(rel) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  // O Prettier lê a chave prettier de um package.json aninhado (AI-04); o da
  // raiz segue liberado, conferido pelo hook de parada e pelo CI (AI-05).
  if (name === 'package.json' && rel.includes('/')) return true;
  return PROTECTED_NAMES.some((re) => re.test(name));
}

function isProtected(rel) {
  return (
    PROTECTED_FROM_IMPLEMENTER.some((entry) => isUnder(rel, entry)) ||
    isProtectedName(rel)
  );
}

// Testes unitários ficam ao lado do arquivo testado (CONVENTIONS.md, "Testes"),
// então o papel se decide também pelo nome do arquivo, e não só pela pasta.
export function isTestFile(rel) {
  return isUnder(rel, 'test') || rel.endsWith('.test.ts');
}

const RULES = {
  // Um .oxlintrc.json ou vitest.config.ts dentro de test/ mudaria como os
  // próprios testes rodam (FND-08), então os nomes negados valem aqui também.
  'test-writer': {
    allows: (rel) => isTestFile(rel) && !isProtectedName(rel),
    reason:
      'O test-writer só edita testes: arquivos *.test.ts e test/, fora da configuração da verificação (AGENTS.md, "Guardrails").',
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

const caseInsensitive = new Map();

// Se o sistema de arquivos da pasta não distingue caixa (o padrão do macOS): o
// mesmo caminho com a caixa trocada existe e é a mesma pasta.
function ignoresCase(dir) {
  if (!caseInsensitive.has(dir)) {
    const swapped = [...dir]
      .map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()))
      .join('');
    let same = false;
    try {
      same = swapped !== dir && statSync(swapped).ino === statSync(dir).ino;
    } catch {
      same = false;
    }
    caseInsensitive.set(dir, same);
  }
  return caseInsensitive.get(dir);
}

// Pelo caminho real dos dois lados (AI-26): a raiz e o alvo podem vir um pelo
// link simbólico e o outro pela pasta de verdade, como o /private do macOS. O
// alvo vai sem o path.resolve, que resolveria o .. pelo texto antes do link
// (A21 do #26). Num sistema de arquivos que não distingue caixa, "Test/x.ts" e
// "test/x.ts" são o mesmo arquivo, e a raiz também (A20 do #26); o resultado
// vem em minúsculas, que é como as regras comparam.
function relativeTo(root, target) {
  return relativeFromRoot(root, realPath(joinedTarget(root, target)));
}

function joinedTarget(root, target) {
  return path.isAbsolute(target) ? target : `${root}${path.sep}${target}`;
}

// O caminho já com o prefixo real, relativo à raiz real e na regra de caixa
// dela; o resultado vem em minúsculas, que é como as regras comparam.
function relativeFromRoot(root, absolute) {
  const realRoot = realPath(root);
  const fold = ignoresCase(realRoot)
    ? (value) => value.toLowerCase()
    : (value) => value;
  return path
    .relative(fold(realRoot), fold(absolute))
    .split(path.sep)
    .join('/')
    .toLowerCase();
}

const isOutside = (rel) =>
  rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);

// O caminho como foi pedido, sem seguir o último componente: um link com nome
// protegido (src/.oxlintrc.json apontando para src/x.json) não passa como o
// arquivo que ele aponta (revisão de segurança do #26). As pastas vão pelo
// caminho real, como no relativeTo, para um pedido por um link de pasta (o /tmp
// do macOS) ou em outra caixa não cair fora da raiz e pular a conferência do
// nome (A13 do #27). Fora da raiz, não conta.
function requestedRelative(root, target) {
  const joined = joinedTarget(root, target);
  const rel = relativeFromRoot(
    root,
    path.join(realPath(path.dirname(joined)), path.basename(joined)),
  );
  return isOutside(rel) ? null : rel;
}

// O caminho pedido só pelo texto, sem seguir link nenhum. Fora da raiz, não
// conta.
function textRelative(root, absolute) {
  const rel = path
    .relative(path.resolve(root), path.resolve(absolute))
    .split(path.sep)
    .join('/')
    .toLowerCase();
  return isOutside(rel) ? null : rel;
}

// A decisão inteira, sem processo nem stdin: devolve o motivo da recusa, ou null
// para deixar passar. O main só lê a entrada e escreve a resposta do hook.
// root é a raiz das regras de papel (a worktree do agente isolado, AI-26);
// projectDir é a pasta principal, onde ficam as pastas gravadas pelos hooks,
// conferidas para qualquer sessão (AI-15).
export function decide(input, root, projectDir = root) {
  const rule = RULES[input.agent_type];
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!root || !target)
    return rule ? `${rule.reason} Caminho não informado.` : null;

  const rel = relativeTo(root, target);
  const absolute = joinedTarget(root, target);
  const fromProject = projectDir ? relativeTo(projectDir, absolute) : rel;
  // O caminho pedido em duas leituras: pelas pastas reais e pelo texto, com o
  // .. resolvido antes de qualquer link, como o path.resolve faz. Não se sabe
  // qual delas a ferramenta usa para gravar, então as duas são conferidas
  // (A3 da fatia 2 do #30).
  const requested = [
    requestedRelative(root, target),
    textRelative(root, absolute),
  ].filter(Boolean);
  const requestedFromProject = projectDir
    ? [
        requestedRelative(projectDir, absolute),
        textRelative(projectDir, absolute),
      ].filter(Boolean)
    : [];
  // Pelo caminho real e pelo pedido: um link dentro das pastas dos hooks para
  // um arquivo editável gravaria o relatório que o github-guard lê (A14 do #27).
  const owned = [rel, fromProject, ...requested, ...requestedFromProject].find(
    (candidate) => candidate && hookOwned(candidate),
  );
  if (owned) return `${HOOK_OWNED_REASON} Caminho: ${owned}`;
  if (!rule) return null;
  if (isOutside(rel)) {
    return `${rule.reason} O caminho está fora do repositório.`;
  }
  if (!rule.allows(rel)) return `${rule.reason} Caminho: ${rel}`;
  const denied = requested.find((candidate) => !rule.allows(candidate));
  return denied ? `${rule.reason} Caminho pedido: ${denied}` : null;
}

// AI-26: a raiz contra a qual o caminho é decidido. Para um agente isolado, é a
// raiz da worktree dele, tirada do cwd da entrada; vale só uma worktree do mesmo
// repositório da pasta principal, para um cwd qualquer não escolher a raiz.
export function rootFor(input, projectDir) {
  if (!input?.cwd || !projectDir) return projectDir;
  const top = gitOut(input.cwd, 'rev-parse', '--show-toplevel');
  // Pelo caminho real: o /private do macOS ou um link simbólico no projectDir
  // não podem fazer a mesma pasta parecer outra (A4 do #19).
  if (!top || realPath(top) === realPath(projectDir)) return projectDir;
  const common = (dir) => {
    const value = gitOut(dir, 'rev-parse', '--git-common-dir');
    return value ? realPath(path.resolve(dir, value)) : null;
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
