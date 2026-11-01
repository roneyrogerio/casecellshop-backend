// Retrato do git de um subagente (AI-12). A guarda do Bash compara texto, e
// sempre sobra uma grafia que escapa (variável, alias, script escrito pelo
// próprio agente); o retrato tirado no início e comparado na parada prova o que
// mudou sem depender de como o comando foi escrito.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function git(projectDir, ...args) {
  const result = spawnSync('git', ['-C', projectDir, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} falhou: ${result.stderr.trim()}`);
  return result.stdout;
}

// Os refs cobrem branches, tags, refs/remotes (que mudam num push) e o stash;
// o .git/config cobre alias, remotos e core.hooksPath.
export function takeSnapshot(projectDir) {
  // Fora de um repositório o retrato é vazio, e não um erro: não há estado do
  // git a proteger. Um .git que some no meio do agente aparece como mudança.
  const inside = spawnSync('git', ['-C', projectDir, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
  if (inside.status !== 0) return { head: '', refs: '', worktrees: '', config: '', status: '', foreignBranches: [] };
  const commonDir = resolve(projectDir, git(projectDir, 'rev-parse', '--git-common-dir').trim());
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
  };
}

// AI-33: as branches em uso por outra worktree do repositório são de outra
// sessão (ou de outro agente isolado), não do agente desta parada.
function foreignBranches(projectDir) {
  const own = resolve(git(projectDir, 'rev-parse', '--show-toplevel').trim());
  const branches = [];
  let current = null;
  for (const line of git(projectDir, 'worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) current = resolve(line.slice('worktree '.length));
    else if (line.startsWith('branch ') && current !== own) branches.push(line.slice('branch '.length));
  }
  return branches;
}

// Caminho de uma linha do git status (porcelain v1): no rename, o destino; sem
// as aspas que o git põe em nomes com espaço.
function statusPath(line) {
  const file = line.slice(3).split('\t')[0];
  const target = file.includes(' -> ') ? file.slice(file.indexOf(' -> ') + 4) : file;
  return target.replace(/^"|"$/g, '');
}

// O status sozinho não pega a segunda edição de um arquivo que já estava sujo
// (a linha " M x" fica igual), então cada linha leva o hash do conteúdo atual.
function statusWithHashes(projectDir) {
  const lines = git(projectDir, 'status', '--porcelain=v1', '--untracked-files=all').split('\n').filter(Boolean);
  if (lines.length === 0) return '';
  const paths = lines.map(statusPath);
  const present = paths.filter((file) => existsSync(join(projectDir, file)));
  const hashed = spawnSync('git', ['-C', projectDir, 'hash-object', '--stdin-paths'], { input: present.join('\n'), encoding: 'utf8' });
  const hashes = new Map(present.map((file, index) => [file, hashed.stdout.split('\n')[index] ?? '?']));
  return lines.map((line, index) => `${line}\t${hashes.get(paths[index]) ?? '-'}`).join('\n');
}

// A worktree de um agente isolado e a branch dela são criadas e apagadas pelo
// próprio Claude Code (AI-24), em volta da execução do agente.
const MANAGED_BRANCH = 'refs/heads/worktree-agent-';
const MANAGED_WORKTREES = '/.claude/worktrees/';

function refMap(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n').filter((ref) => ref && !ref.startsWith(MANAGED_BRANCH))) {
    const space = line.lastIndexOf(' ');
    map.set(line.slice(0, space), line.slice(space + 1));
  }
  return map;
}

// Os refs remotos mudam no fetch ou no push de qualquer sessão (AI-33).
const REMOTE_REFS = 'refs/remotes/';

function describeRefs(before, after, ignored) {
  const keep = (map) => new Map([...map].filter(([name]) => !name.startsWith(REMOTE_REFS) && !ignored.has(name)));
  const old = keep(refMap(before));
  const now = keep(refMap(after));
  const parts = [];
  for (const [name, hash] of now) {
    if (!old.has(name)) parts.push(`${name} criado em ${hash.slice(0, 12)}`);
    else if (old.get(name) !== hash) parts.push(`${name} passou de ${old.get(name).slice(0, 12)} para ${hash.slice(0, 12)}`);
  }
  for (const name of old.keys()) if (!now.has(name)) parts.push(`${name} removido`);
  return parts;
}

export function compareSnapshots(before, after) {
  const changes = [];
  if (before.head !== after.head) changes.push(`HEAD passou de ${before.head} para ${after.head}`);
  const ignored = new Set([...(before.foreignBranches ?? []), ...(after.foreignBranches ?? [])]);
  const refs = describeRefs(before.refs, after.refs, ignored);
  if (refs.length > 0) changes.push(`refs mudaram: ${refs.join('; ')}`);
  const ownWorktrees = (list) =>
    String(list ?? '')
      .split('\n')
      .filter((line) => !line.includes(MANAGED_WORKTREES))
      .join('\n');
  if (ownWorktrees(before.worktrees) !== ownWorktrees(after.worktrees)) changes.push('worktrees mudaram: a lista do git worktree list é outra');
  if (before.config !== after.config) changes.push('config mudou: o .git/config é outro (alias, remoto ou core.hooksPath)');
  return changes;
}

// Fica fora do repositório, como o contador do hook de parada; o nome perde
// barras e pontos iniciais para um id estranho não sair da pasta temporária.
export function snapshotFile(sessionId, agentId) {
  const safe = (value) => String(value ?? '').replaceAll(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  return join(tmpdir(), 'casecellshop-git-snapshot', `${safe(sessionId)}__${safe(agentId)}.json`);
}

// O que os próprios hooks e o Claude Code gravam na pasta principal enquanto
// o agente roda: o relatório do reviewer, os registros e as worktrees.
const HOOK_WRITTEN = ['.claude/reviews/', '.claude/state/', '.claude/worktrees/'];

function statusMap(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n').filter(Boolean)) map.set(statusPath(line), line);
  return map;
}

// AI-28: o que mudou na pasta principal entre o início e a parada do agente. Uma
// mudança que já estava lá no início, sem alteração, não é atribuída a ele.
export function changesDuring(beforeStatus, afterStatus) {
  const before = statusMap(beforeStatus);
  const after = statusMap(afterStatus);
  const changed = [];
  for (const [file, line] of after) if (before.get(file) !== line) changed.push(file);
  for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed.filter((file) => !HOOK_WRITTEN.some((prefix) => file.startsWith(prefix)));
}
