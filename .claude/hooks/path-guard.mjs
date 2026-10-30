// Guarda de caminho por papel. Roda no PreToolUse de Edit, Write e NotebookEdit
// (.claude/settings.json) e nega a edição fora do que o agente pode escrever.
// O agent_type só vem nas chamadas de subagente (ou com --agent); a sessão
// principal não tem regra aqui e passa direto.
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

function main() {
let input;
  try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Sem entrada legível não dá para saber o papel: o código 2 bloqueia a edição.
  process.stderr.write('path-guard: entrada do hook ilegível\n');
  process.exit(2);
}

const rule = RULES[input.agent_type];
if (!rule) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!root || !target) deny(`${rule.reason} Caminho não informado.`);

// Em minúsculas porque o sistema de arquivos padrão do macOS não diferencia
// maiúsculas: "Test/x.ts" e "test/x.ts" são o mesmo arquivo.
const rel = path
  .relative(root, path.resolve(root, target))
  .split(path.sep)
  .join('/')
  .toLowerCase();
if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
  deny(`${rule.reason} O caminho está fora do repositório.`);
}
if (!rule.allows(rel)) deny(`${rule.reason} Caminho: ${rel}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
