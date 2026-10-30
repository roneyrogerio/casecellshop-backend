// PreToolUse do Bash (AI-11). Só a sessão principal commita, envia e muda o
// estado do git; os subagentes leem (status, diff, log, show) e rodam testes.
// A regra de permissão compara texto e não separa papéis, então este hook lê o
// comando inteiro: o git em qualquer posição (depois de ;, &&, ||, |, quebra de
// linha ou dentro de sh -c "…"), com caminho absoluto, variáveis antes ou
// opções globais antes do verbo.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SUBAGENTS = new Set(['implementer', 'test-writer', 'reviewer']);

const WRITE_VERBS = [
  'commit', 'push', 'reset', 'checkout', 'switch', 'restore', 'rebase', 'merge',
  'stash', 'tag', 'branch', 'clean', 'filter-branch', 'update-ref',
];

const GIT_WRITE = new RegExp(
  String.raw`^\s*(?:\w+=\S*\s+)*(?:\S*/)?git\s+(?:(?:-C|-c)\s+\S+\s+|--?[\w-]+(?:=\S+)?\s+)*(` +
    WRITE_VERBS.join('|') +
    String.raw`)\b`,
);

export function check(input) {
  if (!SUBAGENTS.has(input.agent_type)) return { allow: true };
  const command = String(input.tool_input?.command ?? '');
  // Aspas e crases também separam: assim o comando dentro de sh -c "…" vira um
  // trecho próprio e é conferido como os outros.
  const segments = command.split(/;|&&|\|\||\||\n|["'`]|\$\(/);
  const hit = segments.map((segment) => GIT_WRITE.exec(segment)).find(Boolean);
  if (hit) {
    return {
      allow: false,
      reason: `${input.agent_type} não roda git ${hit[1]}: só a sessão principal commita, envia e muda o estado do git (AI-11).`,
    };
  }
  return { allow: true };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('bash-guard: entrada do hook ilegível\n');
    process.exit(2);
  }
  const decision = check(input);
  if (!decision.allow) {
    process.stderr.write(decision.reason);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
