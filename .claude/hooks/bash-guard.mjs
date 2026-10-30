// PreToolUse do Bash (AI-11). Os subagentes só leem o git; o git push, de
// qualquer sessão, só passa na forma estreita do fluxo. A regra de permissão
// compara texto e não separa papéis, então este hook lê o comando inteiro.
//
// É a camada de retorno rápido, não a prova: sempre sobra uma grafia que escapa
// (variável, alias, script escrito pelo próprio agente). A prova de que o git
// do subagente ficou igual é o retrato comparado na parada (AI-12).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SUBAGENTS = new Set(['implementer', 'test-writer', 'reviewer']);

// Lista do que passa, e não do que é negado: um verbo novo, ou esquecido, fica
// negado por padrão. A lista anterior, de verbos negados, deixava passar pull,
// cherry-pick, worktree e config.
const READ_VERBS = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
  'merge-base', 'blame', 'grep', 'cat-file', 'describe', 'shortlog',
]);

// Opções globais do git que levam o valor na palavra seguinte.
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

// -c e --config-env definem configuração só para aquele comando, alias inclusive.
const CONFIG_OPTIONS = new Set(['-c', '--config-env']);

const PUSH_OPTIONS = new Set(['-u', '--set-upstream']);

// Nome de branch comum; refspec com + ou :, refs/… e a main ficam de fora.
const BRANCH = /^[A-Za-z0-9][\w./-]*$/;
const PROTECTED_TARGETS = new Set(['main', 'master']);

// O shell junta as partes de "g\it" e de '"git"' na mesma palavra, então tirar
// aspas e barras invertidas antes de comparar segue o que o shell executa. Os
// redirecionamentos (2>&1, > arquivo) não são argumentos do comando.
function segmentsOf(command) {
  return command
    .replaceAll(/["'\\]/g, '')
    .replaceAll(/\d*(?:&>>?|>>?|<)(?:&\d+|\s*[^\s;&|(){}`]+)/g, ' ')
    .split(/[;&|(){}`\n]/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

function isGitWord(word) {
  return word.slice(word.lastIndexOf('/') + 1) === 'git';
}

// Cada git do trecho, em qualquer palavra (depois de env, xargs, time, sh -c…):
// as opções globais, o verbo e os argumentos dele.
function gitCalls(words) {
  const calls = [];
  for (let i = 0; i < words.length; i += 1) {
    if (!isGitWord(words[i])) continue;
    const globals = [];
    let j = i + 1;
    while (j < words.length && words[j].startsWith('-')) {
      const option = words[j];
      globals.push(option);
      j += GLOBAL_WITH_VALUE.has(option) ? 2 : 1;
    }
    calls.push({ globals, verb: words[j], args: words.slice(j + 1) });
    i = j;
  }
  return calls;
}

function pushProblem({ globals, args }) {
  if (globals.length > 0) return `opção antes do verbo (${globals.join(' ')})`;
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (!PUSH_OPTIONS.has(arg)) return `opção ${arg}`;
    } else positional.push(arg);
  }
  const [remote, target, ...rest] = positional;
  if (rest.length > 0) return 'mais de um destino';
  if (remote !== undefined && remote !== 'origin') return `remoto ${remote}`;
  if (target === undefined || target === 'HEAD') return null;
  if (!BRANCH.test(target) || target.startsWith('refs/')) return `destino ${target}`;
  if (PROTECTED_TARGETS.has(target)) return `destino ${target}`;
  return null;
}

export function check(input) {
  const agentType = input.agent_type;
  const subagent = SUBAGENTS.has(agentType);
  const command = String(input.tool_input?.command ?? '');
  for (const words of segmentsOf(command)) {
    for (const call of gitCalls(words)) {
      if (subagent) {
        const config = call.globals.find((option) => CONFIG_OPTIONS.has(option));
        if (config) {
          return { allow: false, reason: `${agentType} não roda git ${config}: a opção define configuração e alias só para aquele comando (AI-11).` };
        }
        if (call.verb !== undefined && !READ_VERBS.has(call.verb)) {
          return {
            allow: false,
            reason: `${agentType} só lê o git (status, diff, log, show e os outros verbos de leitura); git ${call.verb} fica com a sessão principal (AI-11). Para desfazer uma edição sua, edite o arquivo de volta.`,
          };
        }
      } else if (call.verb === 'push') {
        const problem = pushProblem(call);
        if (problem) {
          return {
            allow: false,
            reason: `git push só passa como git push [-u|--set-upstream] [origin [HEAD|<branch>]], sem main como destino; este tem ${problem} (AI-11). Remoção, força, espelho e push sem hook ficam fora do fluxo.`,
          };
        }
      }
    }
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
