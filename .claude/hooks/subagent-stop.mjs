// Hook de parada (SubagentStop) do implementer, do test-writer e do reviewer
// (AI-03, AI-12). O
// "terminei" do agente deixa de ser uma afirmação e passa a ser uma checagem:
// enquanto o lint, o typecheck ou os testes ligados às mudanças falharem, ele
// volta ao trabalho com a saída da falha. O test-writer não roda testes, porque
// os dele devem nascer vermelhos.
//
// Não sai cedo com stop_hook_active: isso soltaria o agente logo depois do
// primeiro bloqueio. O teto é um contador por agente: na quarta parada vermelha
// ele deixa terminar e a falha vira exceção para a sessão principal decidir.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compareSnapshots, snapshotFile, takeSnapshot } from './git-snapshot.mjs';
import { allows } from './path-guard.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKS = {
  implementer: ['lint', 'typecheck', 'test:changed'],
  'test-writer': ['lint', 'typecheck'],
};

const MAX_BLOCKS = 3;

const GIT_WATCHED = new Set(['implementer', 'test-writer', 'reviewer']);

// Só o fim da saída volta ao agente: é onde o erro aparece, e a saída inteira de
// um teste custaria contexto a cada devolução.
const MAX_OUTPUT_CHARS = 4000;

export async function decide(input, deps) {
  // Uma mudança no git (AI-12) não volta ao agente: ele não pode desfazê-la,
  // porque o bash-guard lhe nega reset e restore. Vira exceção já na primeira
  // parada, para a sessão principal desfazer antes de qualquer outra coisa.
  if (GIT_WATCHED.has(input.agent_type)) {
    const gitChanges = deps.gitChanges();
    if (gitChanges.length > 0) {
      return {
        action: 'exception',
        message: `${input.agent_type} mudou o estado do git, o que só a sessão principal faz (AI-11, AI-12). Desfaça antes de seguir:\n${gitChanges.map((change) => `- ${change}`).join('\n')}`,
      };
    }
  }

  const checks = CHECKS[input.agent_type];
  if (!checks) return { action: 'allow' };

  const key = `${input.session_id}:${input.agent_id}`;
  const failures = [];

  // O git status pega também o que foi escrito pelo Bash, que a guarda de
  // caminho não vê: um arquivo fora do papel devolve o agente.
  const outside = deps.changedFiles().filter((file) => !allows(input.agent_type, file));
  if (outside.length > 0) {
    failures.push({ name: 'arquivos fora do papel', output: outside.join('\n') });
  }
  if (input.agent_type === 'implementer' && deps.scriptsChanged()) {
    failures.push({
      name: 'scripts do package.json',
      output: 'O bloco "scripts" mudou: ele define o que o CI e este hook rodam, e é da sessão principal.',
    });
  }
  for (const name of checks) {
    const result = await deps.runCheck(name);
    if (!result.ok) failures.push({ name, output: result.output });
  }

  if (failures.length === 0) {
    deps.writeCount(key, 0);
    return { action: 'allow' };
  }

  const details = failures.map(({ name, output }) => `### ${CHECKS[input.agent_type].includes(name) ? `npm run ${name}` : name}\n${output}`).join('\n\n');
  const count = deps.readCount(key);
  if (count >= MAX_BLOCKS) {
    return {
      action: 'exception',
      message: `${input.agent_type} parou com checagens vermelhas depois de ${MAX_BLOCKS} devoluções: a falha virou exceção para a sessão principal decidir (escada ou exceção ao mantenedor).\n\n${details}`,
    };
  }

  deps.writeCount(key, count + 1);
  return {
    action: 'block',
    message: `Ainda não terminou: ${failures.map(({ name }) => name).join(', ')} falhou. Corrija e termine de novo (devolução ${count + 1} de ${MAX_BLOCKS}).\n\n${details}`,
  };
}

function counterFile(key) {
  const dir = join(tmpdir(), 'casecellshop-subagent-stop');
  mkdirSync(dir, { recursive: true });
  return join(dir, key.replaceAll(/[^\w.-]/g, '_'));
}

// Caminhos relativos do git status, inclusive arquivos novos dentro de pastas
// novas; fora de um repositório git, nenhum.
function changedFiles(projectDir) {
  const status = spawnSync('git', ['-C', projectDir, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (status.status !== 0) return [];
  return status.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3))
    .map((file) => (file.includes(' -> ') ? file.slice(file.indexOf(' -> ') + 4) : file))
    .map((file) => file.replace(/^"|"$/g, ''));
}

async function scriptsChanged(projectDir) {
  const head = spawnSync('git', ['-C', projectDir, 'show', 'HEAD:package.json'], { encoding: 'utf8' });
  if (head.status !== 0) return false;
  try {
    const { scriptsDiffer } = await import('../../scripts/check-scripts.ts');
    return scriptsDiffer(head.stdout, readFileSync(join(projectDir, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
}

// Sem retrato não há como provar que o git ficou igual: falha fechada, como
// mudança.
function gitChanges(projectDir, input) {
  let before;
  try {
    before = JSON.parse(readFileSync(snapshotFile(input.session_id, input.agent_id), 'utf8'));
  } catch {
    return ['retrato do git ausente: o início do agente não gravou o estado do git, então não há como provar que ele ficou igual'];
  }
  try {
    return compareSnapshots(before, takeSnapshot(projectDir));
  } catch (error) {
    return [`estado do git ilegível na parada (${error.message})`];
  }
}

function recordException(projectDir, message) {
  // Fora do git: a sessão principal lê este registro depois de cada delegação.
  const stateDir = join(projectDir, '.claude', 'state');
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'stop-exceptions.log'), `${new Date().toISOString()} ${message}\n\n`);
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

// O relatório do reviewer vai para o arquivo direto da mensagem final dele, sem
// passar pela sessão principal: o github-guard confere o comentário contra isto.
function saveReview(projectDir, input) {
  if (typeof input.last_assistant_message !== 'string' || !input.last_assistant_message) return;
  const dir = join(projectDir, '.claude', 'reviews');
  mkdirSync(dir, { recursive: true });
  const name = String(input.agent_id ?? 'reviewer').replaceAll(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  writeFileSync(join(dir, `${name}.md`), input.last_assistant_message);
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('subagent-stop: entrada do hook ilegível\n');
    process.exit(2);
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  if (input.agent_type === 'reviewer') saveReview(projectDir, input);
  const changedScripts = input.agent_type === 'implementer' ? await scriptsChanged(projectDir) : false;

  const decision = await decide(input, {
    runCheck: (name) => {
      const run = spawnSync('npm', ['run', '--silent', name], { cwd: projectDir, encoding: 'utf8' });
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.slice(-MAX_OUTPUT_CHARS);
      return Promise.resolve({ ok: run.status === 0, output });
    },
    readCount: (key) => {
      try {
        return Number(readFileSync(counterFile(key), 'utf8')) || 0;
      } catch {
        return 0;
      }
    },
    writeCount: (key, n) => writeFileSync(counterFile(key), String(n)),
    changedFiles: () => changedFiles(projectDir),
    scriptsChanged: () => changedScripts,
    gitChanges: () => gitChanges(projectDir, input),
  });

  if (decision.action === 'block') {
    process.stderr.write(decision.message);
    process.exit(2);
  }
  if (decision.action === 'exception') recordException(projectDir, decision.message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
