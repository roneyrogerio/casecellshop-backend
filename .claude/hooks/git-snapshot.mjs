// Retrato do git de um subagente (AI-12). A guarda do Bash compara texto, e
// sempre sobra uma grafia que escapa (variável, alias, script escrito pelo
// próprio agente); o retrato tirado no início e comparado na parada prova o que
// mudou sem depender de como o comando foi escrito.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

function git(projectDir, ...args) {
  const result = spawnSync('git', ['-C', projectDir, ...args], {
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} falhou: ${result.stderr.trim()}`);
  return result.stdout;
}

// Os refs cobrem branches, tags, refs/remotes (que mudam num push) e o stash;
// o .git/config cobre alias, remotos e core.hooksPath.
export function takeSnapshot(projectDir) {
  // Fora de um repositório o retrato é vazio, e não um erro: não há estado do
  // git a proteger. Um .git que some no meio do agente aparece como mudança.
  const inside = spawnSync(
    'git',
    ['-C', projectDir, 'rev-parse', '--git-dir'],
    { encoding: 'utf8' },
  );
  if (inside.status !== 0)
    return {
      head: '',
      refs: '',
      worktrees: '',
      config: '',
      status: '',
      foreignBranches: [],
      worktreeBranches: {},
      worktreeHeads: {},
    };
  const commonDir = resolve(
    projectDir,
    git(projectDir, 'rev-parse', '--git-common-dir').trim(),
  );
  return {
    head: git(projectDir, 'rev-parse', 'HEAD').trim(),
    refs: git(projectDir, 'for-each-ref', '--format=%(refname) %(objectname)'),
    // Só as pastas: o HEAD de cada worktree já está nos refs, e repeti-lo aqui
    // contaria um commit comum também como worktree nova.
    worktrees: git(projectDir, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .join('\n'),
    config: readFileSync(join(commonDir, 'config'), 'utf8'),
    status: statusWithHashes(projectDir),
    foreignBranches: foreignBranches(projectDir),
    worktreeBranches: worktreeBranches(projectDir),
    worktreeHeads: worktreeHeads(projectDir),
  };
}

// O caminho pelo realpath, para o /private do macOS e um link simbólico não
// separarem a mesma pasta. Um caminho que ainda não existe (o arquivo novo de um
// Write) sai pelo realpath do maior ancestral que existe, mais o resto.
export function realPath(path) {
  const absolute = resolve(path);
  let base = absolute;
  for (;;) {
    try {
      return join(realpathSync(base), relative(base, absolute));
    } catch {
      const parent = dirname(base);
      if (parent === base) return absolute;
      base = parent;
    }
  }
}

// O HEAD de cada worktree, pelo caminho real: um commit do agente isolado na
// própria worktree move só a branch dela, que fica fora dos refs (AI-33), e
// apareceria só aqui (A3 do #19).
function worktreeHeads(projectDir) {
  const map = {};
  let current = null;
  for (const line of git(projectDir, 'worktree', 'list', '--porcelain').split(
    '\n',
  )) {
    if (line.startsWith('worktree '))
      current = realPath(line.slice('worktree '.length));
    else if (line.startsWith('HEAD ') && current)
      map[current] = line.slice('HEAD '.length);
  }
  return map;
}

// A branch em uso em cada worktree, pelo caminho: identifica a do agente isolado.
function worktreeBranches(projectDir) {
  const map = {};
  let current = null;
  for (const line of git(projectDir, 'worktree', 'list', '--porcelain').split(
    '\n',
  )) {
    if (line.startsWith('worktree '))
      current = resolve(line.slice('worktree '.length));
    else if (line.startsWith('branch ') && current)
      map[current] = line.slice('branch '.length);
  }
  return map;
}

// AI-33: as branches em uso por outra worktree do repositório são de outra
// sessão (ou de outro agente isolado), não do agente desta parada.
function foreignBranches(projectDir) {
  const own = resolve(git(projectDir, 'rev-parse', '--show-toplevel').trim());
  const branches = [];
  let current = null;
  for (const line of git(projectDir, 'worktree', 'list', '--porcelain').split(
    '\n',
  )) {
    if (line.startsWith('worktree '))
      current = resolve(line.slice('worktree '.length));
    else if (line.startsWith('branch ') && current !== own)
      branches.push(line.slice('branch '.length));
  }
  return branches;
}

// As entradas do git status pelo formato -z: o nome vem como está, sem aspas nem
// octal para acento e espaço (A5 do #19). No rename, o destino; a origem vem na
// entrada seguinte e é pulada. O hook de parada usa o mesmo parser (A9 do #19).
export function statusEntries(projectDir) {
  const parts = git(
    projectDir,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ).split('\0');
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) continue;
    const code = part.slice(0, 2);
    entries.push({ code, path: part.slice(3) });
    // O rename ou a cópia, no índice (X) ou na worktree (Y), traz a origem em
    // seguida.
    if (/[RC]/.test(code)) index += 1;
  }
  return entries;
}

// Caminho de uma linha do status gravado no retrato: `XY caminho\thash`.
function statusPath(line) {
  return line.slice(3).split('\t')[0];
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// O status sozinho não pega a segunda edição de um arquivo que já estava sujo
// (a linha " M x" fica igual), então cada linha leva o hash do conteúdo atual.
// Uma falha do hash-object lança: um status sem hash esconderia a edição.
function statusWithHashes(projectDir) {
  const entries = statusEntries(projectDir);
  if (entries.length === 0) return '';
  const present = entries
    .map((entry) => entry.path)
    .filter((file) => isFile(join(projectDir, file)));
  const hashes = new Map();
  if (present.length > 0) {
    const hashed = spawnSync(
      'git',
      ['-C', projectDir, 'hash-object', '--stdin-paths'],
      { input: present.join('\n'), encoding: 'utf8' },
    );
    if (hashed.status !== 0)
      throw new Error(
        `git hash-object falhou (${present.join(', ')}): ${hashed.stderr.trim()}`,
      );
    const lines = hashed.stdout.split('\n');
    present.forEach((file, index) => hashes.set(file, lines[index] ?? ''));
  }
  return entries
    .map(({ code, path }) => `${code} ${path}\t${hashes.get(path) ?? '-'}`)
    .join('\n');
}

function refMap(text) {
  const map = new Map();
  for (const line of String(text ?? '')
    .split('\n')
    .filter(Boolean)) {
    const space = line.lastIndexOf(' ');
    map.set(line.slice(0, space), line.slice(space + 1));
  }
  return map;
}

// Os refs remotos mudam no fetch ou no push de qualquer sessão (AI-33).
const REMOTE_REFS = 'refs/remotes/';

function describeRefs(before, after, ignored) {
  const keep = (map) =>
    new Map(
      [...map].filter(
        ([name]) => !name.startsWith(REMOTE_REFS) && !ignored.has(name),
      ),
    );
  const old = keep(refMap(before));
  const now = keep(refMap(after));
  const parts = [];
  for (const [name, hash] of now) {
    if (!old.has(name)) parts.push(`${name} criado em ${hash.slice(0, 12)}`);
    else if (old.get(name) !== hash)
      parts.push(
        `${name} passou de ${old.get(name).slice(0, 12)} para ${hash.slice(0, 12)}`,
      );
  }
  for (const name of old.keys())
    if (!now.has(name)) parts.push(`${name} removido`);
  return parts;
}

// agentRoot é a raiz da worktree do agente isolado (AI-24): a branch e a entrada
// dela, criadas pelo Claude Code em volta da execução, não contam. Das branches
// de outra worktree (AI-33), só contam como de outra sessão as que já estavam
// presas a outra worktree no início; uma branch presa durante a execução é do
// agente até prova em contrário.
export function compareSnapshots(before, after, { agentRoot } = {}) {
  const changes = [];
  if (before.head !== after.head)
    changes.push(`HEAD passou de ${before.head} para ${after.head}`);
  // A3 do #19: a branch do agente fica fora dos refs, mas um commit na worktree
  // que já existia no início muda o HEAD dela. Uma worktree criada durante a
  // execução não tem HEAD no início para comparar.
  if (agentRoot) {
    const key = realPath(agentRoot);
    const start = before.worktreeHeads?.[key];
    const stop = after.worktreeHeads?.[key];
    if (start && stop && start !== stop)
      changes.push(
        `commit na worktree do agente (${agentRoot}): HEAD passou de ${start} para ${stop}`,
      );
  }
  const own = agentRoot ? resolve(agentRoot) : null;
  // Do início, a branch da worktree do agente; da parada, só uma branch que nem
  // existia no início (criada durante a execução), nunca uma que já existia e
  // passou a ser usada ali, como a main (A2 da Revisão 2 do #19).
  const existed = refMap(before.refs);
  const atStop = own ? after.worktreeBranches?.[own] : undefined;
  const agentBranches = [
    own ? before.worktreeBranches?.[own] : undefined,
    atStop && !existed.has(atStop) ? atStop : undefined,
  ].filter(Boolean);
  const ignored = new Set([
    ...(before.foreignBranches ?? []),
    ...agentBranches,
  ]);
  const refs = describeRefs(before.refs, after.refs, ignored);
  if (refs.length > 0) changes.push(`refs mudaram: ${refs.join('; ')}`);
  const listed = (list) =>
    String(list ?? '')
      .split('\n')
      .filter((line) => !own || line !== `worktree ${own}`)
      .join('\n');
  if (listed(before.worktrees) !== listed(after.worktrees))
    changes.push('worktrees mudaram: a lista do git worktree list é outra');
  if (before.config !== after.config)
    changes.push(
      'config mudou: o .git/config é outro (alias, remoto ou core.hooksPath)',
    );
  return changes;
}

// Fica fora do repositório, como o contador do hook de parada; o nome perde
// barras e pontos iniciais para um id estranho não sair da pasta temporária.
export function snapshotFile(sessionId, agentId) {
  const safe = (value) =>
    String(value ?? '')
      .replaceAll(/[^\w.-]/g, '_')
      .replace(/^\.+/, '_');
  return join(
    tmpdir(),
    'casecellshop-git-snapshot',
    `${safe(sessionId)}__${safe(agentId)}.json`,
  );
}

// O que os próprios hooks e o Claude Code gravam na pasta principal enquanto
// o agente roda: o relatório do reviewer, os registros e as worktrees.
const HOOK_WRITTEN = [
  '.claude/reviews/',
  '.claude/state/',
  '.claude/worktrees/',
];

function statusMap(text) {
  const map = new Map();
  for (const line of String(text ?? '')
    .split('\n')
    .filter(Boolean))
    map.set(statusPath(line), line);
  return map;
}

// AI-28: o que mudou na pasta principal entre o início e a parada do agente. Uma
// mudança que já estava lá no início, sem alteração, não é atribuída a ele.
export function changesDuring(beforeStatus, afterStatus) {
  const before = statusMap(beforeStatus);
  const after = statusMap(afterStatus);
  const changed = [];
  for (const [file, line] of after)
    if (before.get(file) !== line) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed.filter(
    (file) => !HOOK_WRITTEN.some((prefix) => file.startsWith(prefix)),
  );
}
