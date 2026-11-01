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
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  changesDuring,
  compareSnapshots,
  originsOf,
  snapshotFile,
  statusEntries,
  takeSnapshot,
} from './git-snapshot.mjs';
import { allows, rootFor } from './path-guard.mjs';
import { saveReview, takeHandback } from './records.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHECKS = {
  implementer: [
    'lint',
    'typecheck',
    'check:unused',
    'check:duplication',
    'test:changed',
  ],
  'test-writer': ['lint', 'typecheck', 'check:unused', 'check:duplication'],
};

const MAX_BLOCKS = 3;

const GIT_WATCHED = new Set(['implementer', 'test-writer', 'reviewer']);

// Só o fim da saída volta ao agente: é onde o erro aparece, e a saída inteira de
// um teste custaria contexto a cada devolução.
const MAX_OUTPUT_CHARS = 4000;

// AI-30: o evento de parada não aceita onFailure: "block" (documentação do
// Claude Code), então a falha fechada fica aqui: um erro interno devolve o agente
// com a mensagem, em vez de deixá-lo parar sem a checagem.
export async function decide(input, deps) {
  try {
    return await decideChecked(input, deps);
  } catch (error) {
    return {
      action: 'block',
      message: `O hook de parada falhou por um erro interno, e a checagem não rodou: ${error instanceof Error ? error.message : String(error)}. Termine de novo; se o erro se repetir, ele vira exceção para a sessão principal.`,
    };
  }
}

async function decideChecked(input, deps) {
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

  // AI-28, AI-29: o que mudou na pasta principal durante a execução não é do
  // agente isolado nem do reviewer; ele não tem como desfazer, então vira exceção.
  if (GIT_WATCHED.has(input.agent_type)) {
    const outsideWorktree = deps.mainChanges();
    if (outsideWorktree.length > 0) {
      return {
        action: 'exception',
        message: `${input.agent_type} mudou arquivos da pasta principal durante a execução, fora do que o papel dele permite (AI-28, AI-29). Confira e desfaça antes de seguir:\n${outsideWorktree.map((file) => `- ${file}`).join('\n')}`,
      };
    }
  }

  const checks = CHECKS[input.agent_type];
  if (!checks) return { action: 'allow' };

  const key = `${input.session_id}:${input.agent_id}`;
  const failures = [];

  // O git status pega também o que foi escrito pelo Bash, que a guarda de
  // caminho não vê: um arquivo fora do papel devolve o agente.
  const outside = deps
    .changedFiles()
    .filter((file) => !allows(input.agent_type, file));
  if (outside.length > 0) {
    failures.push({
      name: 'arquivos fora do papel',
      output: outside.join('\n'),
    });
  }
  if (input.agent_type === 'implementer' && deps.scriptsChanged()) {
    failures.push({
      name: 'configuração do package.json',
      output:
        'O package.json mudou fora dos blocos de dependências: os scripts e as chaves de configuração definem o que o CI e este hook rodam, e são da sessão principal.',
    });
  }
  // Em sequência, e todas: a devolução cita cada checagem que falhou (AI-03). Rodar
  // em paralelo não reduziu o tempo (medido no PR #19: 25 s em sequência, 28 s em
  // paralelo, com os testes ligados à mudança em 21 s); o ganho vem do PR de testes.
  for (const name of checks) {
    const result = await deps.runCheck(name, input.cwd);
    if (!result.ok) failures.push({ name, output: result.output });
  }

  if (failures.length === 0) {
    deps.writeCount(key, 0);
    return { action: 'allow' };
  }

  const details = failures
    .map(
      ({ name, output }) =>
        `### ${CHECKS[input.agent_type].includes(name) ? `npm run ${name}` : name}\n${output}`,
    )
    .join('\n\n');
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
// O mesmo parser do retrato (A9 do #19), com os nomes sem aspas nem octal.
function changedFiles(projectDir) {
  try {
    // No rename ou na cópia, a origem também passa pela conferência do papel:
    // mover um teste para src/ mexe em test/ (A22 do #26).
    return statusEntries(projectDir).flatMap((entry) =>
      entry.origin ? [entry.path, entry.origin] : [entry.path],
    );
  } catch {
    return [];
  }
}

async function scriptsChanged(projectDir) {
  const head = spawnSync(
    'git',
    ['-C', projectDir, 'show', 'HEAD:package.json'],
    { encoding: 'utf8' },
  );
  if (head.status !== 0) return false;
  try {
    const { packageJsonDiffers } =
      await import('../../scripts/check-scripts.ts');
    return packageJsonDiffers(
      head.stdout,
      readFileSync(join(projectDir, 'package.json'), 'utf8'),
    );
  } catch {
    return false;
  }
}

function readSnapshot(input) {
  try {
    return JSON.parse(
      readFileSync(snapshotFile(input.session_id, input.agent_id), 'utf8'),
    );
  } catch {
    return null;
  }
}

// Sem retrato não há como provar que o git ficou igual: falha fechada, como
// mudança.
function gitChanges(before, after, agentRoot) {
  if (!before)
    return [
      'retrato do git ausente: o início do agente não gravou o estado do git, então não há como provar que ele ficou igual',
    ];
  if (previousFormat(before))
    return [
      'retrato do git no formato anterior, com o status em texto e não em JSON: o agente começou antes da atualização do hook, e não há como separar o que ele mudou',
    ];
  if (after instanceof Error)
    return [`estado do git ilegível na parada (${after.message})`];
  return compareSnapshots(before, after, { agentRoot });
}

// O retrato gravado antes da atualização do hook guardava o status em texto. O
// JSON.parse dele lançava a cada parada, e o agente voltava sem contar as
// devoluções (A17 do #27); ele conta como retrato ausente. O status vazio é o
// retrato fora de um repositório, nos dois formatos.
function previousFormat(before) {
  if (typeof before.status !== 'string' || before.status === '') return false;
  try {
    return !Array.isArray(JSON.parse(before.status));
  } catch {
    return true;
  }
}

// Um retrato antigo, sem o status ou com ele em texto, não tem como separar o
// que já estava sujo.
function mainChanges(before, after) {
  if (
    !before ||
    after instanceof Error ||
    typeof before.status !== 'string' ||
    previousFormat(before)
  )
    return [];
  const changed = changesDuring(before.status, after.status);
  // No rename ou na cópia, a origem também passa pela conferência do papel
  // (A22 do #26).
  return [...changed, ...originsOf(after.status, changed)];
}

function runNpm(name, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn('npm', ['run', '--silent', name], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) =>
      resolvePromise({ ok: false, output: String(error) }),
    );
    child.on('close', (code) =>
      resolvePromise({
        ok: code === 0,
        output: output.slice(-MAX_OUTPUT_CHARS),
      }),
    );
  });
}

function recordException(projectDir, message) {
  // Fora do git: a sessão principal lê este registro depois de cada delegação.
  const stateDir = join(projectDir, '.claude', 'state');
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(
    join(stateDir, 'stop-exceptions.log'),
    `${new Date().toISOString()} ${message}\n\n`,
  );
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

// O relatório do reviewer em primeiro plano é a mensagem final dele, gravada sem
// passar pela sessão principal (AI-15). Se ele já entregou pelo SubagentHandback,
// a mensagem final é só o encerramento e não substitui o relatório.
function recordReview(projectDir, input) {
  if (takeHandback(projectDir, input.agent_id)) return;
  if (
    typeof input.last_assistant_message !== 'string' ||
    !input.last_assistant_message
  )
    return;
  saveReview(projectDir, input.agent_id, input.last_assistant_message);
}

async function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write('subagent-stop: entrada do hook ilegível\n');
    process.exit(2);
  }
  const projectDir =
    process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  // AI-27: o agente isolado trabalha na worktree dele; a pasta principal só
  // entra na conferência do que mudou fora dela.
  const root = rootFor(input, projectDir);
  const isolated = root !== projectDir;
  if (input.agent_type === 'reviewer') recordReview(projectDir, input);
  const changedScripts =
    input.agent_type === 'implementer' ? await scriptsChanged(root) : false;
  const before = readSnapshot(input);
  let after;
  try {
    after = takeSnapshot(projectDir);
  } catch (error) {
    after = error instanceof Error ? error : new Error(String(error));
  }

  const decision = await decide(input, {
    runCheck: (name, cwd) =>
      runNpm(name, cwd ? rootFor({ cwd }, projectDir) : projectDir),
    readCount: (key) => {
      try {
        return Number(readFileSync(counterFile(key), 'utf8')) || 0;
      } catch {
        return 0;
      }
    },
    writeCount: (key, n) => writeFileSync(counterFile(key), String(n)),
    // Isolado, o agente responde pela worktree inteira, e o que mudou na pasta
    // principal não é dele. Sem worktree, ele responde só pelo que mudou na pasta
    // principal durante a execução, e não pelo que a sessão principal já tinha
    // deixado sem commit (AI-28). O reviewer não responde por arquivo nenhum.
    changedFiles: () =>
      isolated ? changedFiles(root) : mainChanges(before, after),
    scriptsChanged: () => changedScripts,
    gitChanges: () => gitChanges(before, after, isolated ? root : undefined),
    mainChanges: () =>
      isolated || input.agent_type === 'reviewer'
        ? mainChanges(before, after)
        : [],
  });

  if (decision.action === 'block') {
    process.stderr.write(decision.message);
    process.exit(2);
  }
  if (decision.action === 'exception')
    recordException(projectDir, decision.message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
