import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, commitEmpty, git, initRepo, makeTempDir } from '../../test/helpers/git-sandbox.ts';

interface Snapshot {
  head: string;
  refs: string;
  worktrees: string;
  config: string;
}

interface SnapshotModule {
  takeSnapshot(projectDir: string): Snapshot;
  compareSnapshots(before: Snapshot, after: Snapshot): string[];
  snapshotFile(sessionId: string, agentId: string): string;
}

let mod: SnapshotModule;

// Import dinâmico: o módulo é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
beforeAll(async () => {
  mod = (await import(pathToFileURL(join(import.meta.dirname, 'git-snapshot.mjs')).href)) as SnapshotModule;
});

afterEach(cleanupTempDirs);

function repo(): string {
  const dir = makeTempDir('snap-');
  initRepo(dir);
  return dir;
}

describe('AI-12 takeSnapshot lê o estado do git', () => {
  it('AI-12 o head é o git rev-parse HEAD', () => {
    const dir = repo();

    expect(mod.takeSnapshot(dir).head.trim()).toBe(git(dir, 'rev-parse', 'HEAD').trim());
  });

  it('AI-12 os refs trazem branches, tags, refs/remotes e o stash, com o hash de cada um', () => {
    const dir = repo();
    git(dir, 'branch', 'outra');
    git(dir, 'tag', 'v1');
    git(dir, 'update-ref', 'refs/remotes/origin/x', 'HEAD');
    git(dir, 'update-ref', 'refs/stash', 'HEAD');

    const { refs } = mod.takeSnapshot(dir);
    const head = git(dir, 'rev-parse', 'HEAD').trim();

    for (const name of ['refs/heads/main', 'refs/heads/outra', 'refs/tags/v1', 'refs/remotes/origin/x', 'refs/stash']) {
      expect(refs, name).toContain(`${name} ${head}`);
    }
  });

  it('AI-12 as worktrees listam a pasta de cada uma', () => {
    const dir = repo();
    const extra = join(makeTempDir('wt-'), 'extra');
    git(dir, 'worktree', 'add', '-q', extra, '-b', 'wt');

    const { worktrees } = mod.takeSnapshot(dir);

    expect(worktrees).toContain(dir);
    expect(worktrees).toContain(extra);
  });

  it('AI-12 o config é o conteúdo do .git/config', () => {
    const dir = repo();
    git(dir, 'config', 'alias.p', 'push');

    expect(mod.takeSnapshot(dir).config).toBe(readFileSync(join(dir, '.git', 'config'), 'utf8'));
    expect(mod.takeSnapshot(dir).config).toContain('alias');
  });

  it('AI-12 dois retratos seguidos do mesmo estado são iguais', () => {
    const dir = repo();

    expect(mod.takeSnapshot(dir)).toEqual(mod.takeSnapshot(dir));
  });
});

describe('AI-12 compareSnapshots devolve uma linha em português por diferença', () => {
  it('AI-12 retratos iguais dão lista vazia', () => {
    const dir = repo();
    const snapshot = mod.takeSnapshot(dir);

    expect(mod.compareSnapshots(snapshot, { ...snapshot })).toEqual([]);
  });

  it('AI-12 um commit novo muda o HEAD e o ref da branch, cada um em uma linha que começa pelo nome do campo', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    commitEmpty(dir);

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes.filter((line) => line.startsWith('HEAD'))).toHaveLength(1);
    const refsLines = changes.filter((line) => line.startsWith('refs'));
    expect(refsLines).toHaveLength(1);
    expect(refsLines[0]).toContain('refs/heads/main');
    expect(changes.some((line) => line.startsWith('worktrees') || line.startsWith('config'))).toBe(false);
  });

  it.each([
    ['uma branch adicionada', ['branch', 'nova'], 'refs/heads/nova'],
    ['uma tag adicionada', ['tag', 'v9'], 'refs/tags/v9'],
    ['um ref de remoto adicionado', ['update-ref', 'refs/remotes/origin/y', 'HEAD'], 'refs/remotes/origin/y'],
    ['um stash adicionado', ['update-ref', 'refs/stash', 'HEAD'], 'refs/stash'],
  ])('AI-12 %s aparece em refs, com o nome do ref na mensagem', (_label, args, name) => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(dir, ...args);

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain(name);
  });

  it('AI-12 um ref removido aparece em refs, com o nome na mensagem', () => {
    const dir = repo();
    git(dir, 'branch', 'sai');
    const before = mod.takeSnapshot(dir);
    git(dir, 'branch', '-D', 'sai');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain('refs/heads/sai');
  });

  it('AI-12 um ref que aponta para outro commit aparece em refs, com o nome na mensagem', () => {
    const dir = repo();
    git(dir, 'branch', 'move');
    commitEmpty(dir);
    const before = mod.takeSnapshot(dir);
    git(dir, 'branch', '-f', 'move', 'HEAD');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain('refs/heads/move');
  });

  it('AI-12 duas branches novas aparecem as duas na mensagem de refs', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(dir, 'branch', 'a1');
    git(dir, 'branch', 'a2');

    const text = mod.compareSnapshots(before, mod.takeSnapshot(dir)).join('\n');

    expect(text).toContain('refs/heads/a1');
    expect(text).toContain('refs/heads/a2');
  });

  it('AI-12 uma worktree nova aparece em worktrees', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(dir, 'worktree', 'add', '-q', join(makeTempDir('wt-'), 'extra'), '-b', 'wt2');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes.filter((line) => line.startsWith('worktrees'))).toHaveLength(1);
  });

  it('AI-12 uma mudança no .git/config aparece em config', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(dir, 'config', 'core.hooksPath', '/tmp/x');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('config')).toBe(true);
  });

  it('AI-12 as linhas são texto em português, e não JSON nem a lista bruta', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    commitEmpty(dir);

    for (const line of mod.compareSnapshots(before, mod.takeSnapshot(dir))) {
      expect(line).not.toMatch(/^[{[]/);
      expect(line.length).toBeGreaterThan('HEAD'.length + 5);
    }
  });
});

describe('AI-12 snapshotFile', () => {
  const original = process.env.TMPDIR;

  afterEach(() => {
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
  });

  it('AI-12 o caminho é absoluto e fica dentro de os.tmpdir()', () => {
    const file = mod.snapshotFile('sess-1', 'ag-1');

    expect(isAbsolute(file)).toBe(true);
    expect(relative(tmpdir(), file).startsWith('..')).toBe(false);
  });

  it('AI-12 respeita o TMPDIR', () => {
    const dir = makeTempDir('tmpdir-');
    process.env.TMPDIR = dir;

    const file = mod.snapshotFile('sess-1', 'ag-1');

    expect(file.startsWith(dir)).toBe(true);
  });

  it('AI-12 o caminho é por sessão e por agente', () => {
    const files = new Set([
      mod.snapshotFile('sess-1', 'ag-1'),
      mod.snapshotFile('sess-1', 'ag-2'),
      mod.snapshotFile('sess-2', 'ag-1'),
    ]);

    expect(files.size).toBe(3);
    expect(mod.snapshotFile('sess-1', 'ag-1')).toBe(mod.snapshotFile('sess-1', 'ag-1'));
  });

  it('AI-12 um agent_id com barras não sai de os.tmpdir()', () => {
    const dir = makeTempDir('tmpdir-');
    process.env.TMPDIR = dir;

    const file = mod.snapshotFile('../../s', '../../../evil');

    expect(relative(dir, file).startsWith('..')).toBe(false);
  });
});
