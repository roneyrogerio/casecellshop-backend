// Guarda de caminho por papel. Roda no PreToolUse de Edit, Write e NotebookEdit
// (.claude/settings.json) e nega a edição fora do que o agente pode escrever.
// O agent_type só vem nas chamadas de subagente (ou com --agent); a sessão
// principal não tem regra aqui e passa direto.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// O implementer não toca no que decide se o trabalho dele está certo (AI-04): os
// testes, a spec, o contrato e tudo que configura a verificação (CI, scripts de
// conferência, lint, typecheck, Vitest). Um agente que pode editar o próprio
// avaliador consegue passar sem acertar; o METR registrou exatamente isso.
export const PROTECTED_FROM_IMPLEMENTER = [
  '.specs',
  '.claude',
  '.github',
  'scripts',
  'src/contract',
  'openapi.yaml',
  'architecture.md',
  'agents.md',
  'claude.md',
  'vitest.config.ts',
  'tsconfig.json',
  '.oxlintrc.json',
  'commitlint.config.mjs',
  'redocly.yaml',
  '.npmrc',
];

// Testes unitários ficam ao lado do arquivo testado (CONVENTIONS.md, "Testes"),
// então o papel se decide também pelo nome do arquivo, e não só pela pasta.
function isTestFile(rel) {
  return isUnder(rel, 'test') || rel.endsWith('.test.ts');
}

const RULES = {
  'test-writer': {
    allows: (rel) => isTestFile(rel),
    reason: 'O test-writer só edita testes: arquivos *.test.ts e test/ (AGENTS.md, "Guardrails").',
  },
  implementer: {
    allows: (rel) => !isTestFile(rel) && !PROTECTED_FROM_IMPLEMENTER.some((entry) => isUnder(rel, entry)),
    reason:
      'O implementer não edita testes, specs, o contrato nem as instruções da IA (AGENTS.md, "Guardrails").',
  },
};

function isUnder(rel, entry) {
  return rel === entry || rel.startsWith(`${entry}/`);
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
