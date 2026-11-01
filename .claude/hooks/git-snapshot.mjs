// Retrato do git de um subagente (AI-12). A guarda do Bash compara texto, e
// sempre sobra uma grafia que escapa (variável, alias, script escrito pelo
// próprio agente); o retrato tirado no início e comparado na parada prova o que
// mudou sem depender de como o comando foi escrito.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  if (inside.status !== 0) return { head: '', refs: '', worktrees: '', config: '' };
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
  };
}

function refMap(text) {
  const map = new Map();
  for (const line of String(text ?? '').split('\n').filter(Boolean)) {
    const space = line.lastIndexOf(' ');
    map.set(line.slice(0, space), line.slice(space + 1));
  }
  return map;
}

function describeRefs(before, after) {
  const old = refMap(before);
  const now = refMap(after);
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
  const refs = describeRefs(before.refs, after.refs);
  if (refs.length > 0) changes.push(`refs mudaram: ${refs.join('; ')}`);
  if (before.worktrees !== after.worktrees) changes.push('worktrees mudaram: a lista do git worktree list é outra');
  if (before.config !== after.config) changes.push('config mudou: o .git/config é outro (alias, remoto ou core.hooksPath)');
  return changes;
}

// Fica fora do repositório, como o contador do hook de parada; o nome perde
// barras e pontos iniciais para um id estranho não sair da pasta temporária.
export function snapshotFile(sessionId, agentId) {
  const safe = (value) => String(value ?? '').replaceAll(/[^\w.-]/g, '_').replace(/^\.+/, '_');
  return join(tmpdir(), 'casecellshop-git-snapshot', `${safe(sessionId)}__${safe(agentId)}.json`);
}

// AI-28: o que mudou na pasta principal entre o início e a parada do agente,
// pelo git status gravado no retrato. Stub do PR das guardas.
export function changesDuring(_beforeStatus, _afterStatus) {
  throw new Error('não implementado');
}
