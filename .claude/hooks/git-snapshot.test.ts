import { chmodSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  commitEmpty,
  git,
  initRepo,
  makeTempDir,
  writeFileIn,
} from '../../test/helpers/git-sandbox.ts';

interface Snapshot {
  head: string;
  refs: string;
  worktrees: string;
  config: string;
  // AI-28 e AI-12: o `git status --porcelain=v1 -z --untracked-files=all` do início, gravado como texto JSON de uma
  // lista de entradas (StatusRecord), com o hash do conteúdo de cada arquivo sujo, para uma segunda edição do mesmo
  // arquivo aparecer e para um nome com quebra de linha, tab ou aspas não quebrar a leitura.
  status: string;
}

// Uma entrada da lista JSON do status. `origin` é a origem de um rename ou de uma cópia e é null fora deles; `hash` é o
// `git hash-object` do arquivo no disco, e null quando ele não existe (apagado).
interface StatusRecord {
  code: string;
  path: string;
  origin: string | null;
  hash: string | null;
}

interface SnapshotModule {
  takeSnapshot(projectDir: string): Snapshot;
  changesDuring(beforeStatus: string, afterStatus: string): string[];
  compareSnapshots(
    before: Snapshot,
    after: Snapshot,
    options?: { agentRoot?: string },
  ): string[];
  snapshotFile(sessionId: string, agentId: string): string;
  // As entradas do `git status --porcelain=v1 -z`: um registro do git, uma entrada, com o caminho do arquivo e, num
  // rename ou numa cópia, a origem em `origin`.
  statusEntries(projectDir: string): {
    code: string;
    path: string;
    origin?: string | null;
  }[];
}

// O status do retrato como lista. Aceita o texto JSON (o formato do critério) ou a lista já pronta.
function statusList(status: unknown): StatusRecord[] {
  return (
    typeof status === 'string' ? JSON.parse(status) : status
  ) as StatusRecord[];
}

// Monta o status gravado a partir das linhas `XY caminho\thash` que as comparações abaixo descrevem.
function statusOf(...lines: string[]): string {
  return JSON.stringify(
    lines.map((line): StatusRecord => {
      const [path = '', hash = null] = line.slice(3).split('\t');
      return { code: line.slice(0, 2), path, origin: null, hash };
    }),
  );
}

let mod: SnapshotModule;

// Import dinâmico: o módulo é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
beforeAll(async () => {
  mod = (await import(
    pathToFileURL(join(import.meta.dirname, 'git-snapshot.mjs')).href
  )) as SnapshotModule;
});

afterEach(cleanupTempDirs);

function repo(): string {
  const dir = makeTempDir('snap-');
  initRepo(dir);
  return dir;
}

// A mudança do HEAD da worktree do agente (A3 da Revisão do #19) cita a worktree ou o commit novo (completo ou
// abreviado em 7 caracteres).
function citesWorktreeOrCommit(
  changes: string[],
  agentRoot: string,
  commit: string,
): boolean {
  const text = changes.join('\n');
  return text.includes(agentRoot) || text.includes(commit.slice(0, 7));
}

// A atribuição de refs do AI-33 fica: nenhuma linha de refs cita a branch do agente. O commit conta pelo HEAD.
function expectCommitWithoutAgentRef(
  changes: string[],
  agentRoot: string,
  commit: string,
  agentBranch: string,
): void {
  expect(changes.length).toBeGreaterThan(0);
  expect(citesWorktreeOrCommit(changes, agentRoot, commit)).toBe(true);
  for (const line of changes.filter((item) => item.startsWith('refs')))
    expect(line).not.toContain(`refs/heads/${agentBranch}`);
}

describe('AI-12 takeSnapshot lê o estado do git', () => {
  it('AI-12 o head é o git rev-parse HEAD', () => {
    const dir = repo();

    expect(mod.takeSnapshot(dir).head.trim()).toBe(
      git(dir, 'rev-parse', 'HEAD').trim(),
    );
  });

  it('AI-12 os refs trazem branches, tags, refs/remotes e o stash, com o hash de cada um', () => {
    const dir = repo();
    git(dir, 'branch', 'outra');
    git(dir, 'tag', 'v1');
    git(dir, 'update-ref', 'refs/remotes/origin/x', 'HEAD');
    git(dir, 'update-ref', 'refs/stash', 'HEAD');

    const { refs } = mod.takeSnapshot(dir);
    const head = git(dir, 'rev-parse', 'HEAD').trim();

    for (const name of [
      'refs/heads/main',
      'refs/heads/outra',
      'refs/tags/v1',
      'refs/remotes/origin/x',
      'refs/stash',
    ]) {
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

    expect(mod.takeSnapshot(dir).config).toBe(
      readFileSync(join(dir, '.git', 'config'), 'utf8'),
    );
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
    expect(
      changes.some(
        (line) => line.startsWith('worktrees') || line.startsWith('config'),
      ),
    ).toBe(false);
  });

  it.each([
    ['uma branch adicionada', ['branch', 'nova'], 'refs/heads/nova'],
    ['uma tag adicionada', ['tag', 'v9'], 'refs/tags/v9'],
    ['um stash adicionado', ['update-ref', 'refs/stash', 'HEAD'], 'refs/stash'],
  ])(
    'AI-12 %s aparece em refs, com o nome do ref na mensagem',
    (_label, args, name) => {
      const dir = repo();
      const before = mod.takeSnapshot(dir);
      git(dir, ...args);

      const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

      expect(changes).toHaveLength(1);
      expect(changes[0]?.startsWith('refs')).toBe(true);
      expect(changes[0]).toContain(name);
    },
  );

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
    git(
      dir,
      'worktree',
      'add',
      '-q',
      join(makeTempDir('wt-'), 'extra'),
      '-b',
      'wt2',
    );

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes.filter((line) => line.startsWith('worktrees'))).toHaveLength(
      1,
    );
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

// AI-33: o retrato não atribui ao agente o que outra sessão faz no mesmo repositório. A outra worktree nasce antes do
// primeiro retrato, para a lista de worktrees não mudar entre os dois (essa mudança é coberta pelo teste AI-12).
describe('AI-33 o retrato não atribui ao agente o que outra sessão faz no mesmo repositório', () => {
  function repoWithOtherWorktree(): { dir: string; other: string } {
    const dir = repo();
    const other = join(makeTempDir('wt-'), 'outra');
    git(dir, 'worktree', 'add', '-q', other, '-b', 'outra');
    return { dir, other };
  }

  it('AI-33 um commit na worktree de outra branch não aparece na comparação', () => {
    const { dir, other } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    commitEmpty(other, 'da outra sessão');

    expect(git(dir, 'rev-parse', 'outra').trim()).not.toBe(
      git(dir, 'rev-parse', 'main').trim(),
    );
    expect(mod.compareSnapshots(before, mod.takeSnapshot(dir))).toEqual([]);
  });

  it('AI-33 a branch criada na outra worktree antes do retrato do início e movida até a parada também não aparece', () => {
    const { dir, other } = repoWithOtherWorktree();
    commitEmpty(other, 'antes do início');
    const before = mod.takeSnapshot(dir);
    commitEmpty(other, 'depois do início');
    commitEmpty(other, 'mais um');

    expect(mod.compareSnapshots(before, mod.takeSnapshot(dir))).toEqual([]);
  });

  it('AI-33 um ref remoto que muda entre os retratos não aparece na comparação', () => {
    const { dir } = repoWithOtherWorktree();
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const before = mod.takeSnapshot(dir);
    commitEmpty(dir, 'outro commit');
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/nova', 'HEAD');

    const text = mod.compareSnapshots(before, mod.takeSnapshot(dir)).join('\n');

    expect(text).not.toContain('refs/remotes');
  });

  it('AI-33 um ref remoto novo (adicionado, não só movido) não aparece na comparação', () => {
    const { dir } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    git(dir, 'update-ref', 'refs/remotes/origin/y', 'HEAD');

    expect(mod.compareSnapshots(before, mod.takeSnapshot(dir))).toEqual([]);
  });

  it('AI-33 controle negativo: uma branch nova que nenhuma worktree usa continua aparecendo em refs', () => {
    const { dir } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    git(dir, 'branch', 'solta');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain('refs/heads/solta');
  });

  it('AI-33 controle negativo: um commit na branch da própria pasta do retrato continua aparecendo (HEAD e ref)', () => {
    const { dir } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    commitEmpty(dir, 'do agente');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes.filter((line) => line.startsWith('HEAD'))).toHaveLength(1);
    const refsLines = changes.filter((line) => line.startsWith('refs'));
    expect(refsLines).toHaveLength(1);
    expect(refsLines[0]).toContain('refs/heads/main');
  });

  it('AI-33 controle negativo: uma tag nova continua aparecendo em refs', () => {
    const { dir } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    git(dir, 'tag', 'v33');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain('refs/tags/v33');
  });

  it('AI-33 controle negativo: mudar a branch da outra worktree junto com uma branch solta só atribui a solta', () => {
    const { dir, other } = repoWithOtherWorktree();
    const before = mod.takeSnapshot(dir);
    commitEmpty(other, 'da outra sessão');
    git(dir, 'branch', 'solta2');

    const text = mod.compareSnapshots(before, mod.takeSnapshot(dir)).join('\n');

    expect(text).toContain('refs/heads/solta2');
    expect(text).not.toContain('refs/heads/outra');
  });
});

// A1/A2 da Revisão 1 (AI-12, AI-33): só fica fora da comparação de refs a branch que outra worktree já usava no início,
// a da worktree do próprio agente (`agentRoot`, pelo caminho exato) e os refs remotos. Nome de branch e pasta de
// worktree parecidos com os do Claude Code não escondem nada.
describe('AI-33 a comparação não esconde o que o agente fez com uma branch ou uma worktree', () => {
  it('AI-33 uma branch que existia fora de qualquer worktree, presa numa worktree nova e movida, aparece em refs e em worktrees', () => {
    const dir = repo();
    git(dir, 'branch', 'alvo');
    const before = mod.takeSnapshot(dir);
    const wt = join(makeTempDir('wt-'), 'nova');
    git(dir, 'worktree', 'add', '-q', wt, 'alvo');
    commitEmpty(wt, 'move a alvo');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes.filter((line) => line.startsWith('refs'))).toHaveLength(1);
    expect(changes.join('\n')).toContain('refs/heads/alvo');
    expect(changes.filter((line) => line.startsWith('worktrees'))).toHaveLength(
      1,
    );
  });

  it('AI-33 a main solta (HEAD da pasta principal destacado), presa numa worktree nova e movida, aparece em refs', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '--detach');
    const before = mod.takeSnapshot(dir);
    const wt = join(makeTempDir('wt-'), 'nova');
    git(dir, 'worktree', 'add', '-q', wt, 'main');
    commitEmpty(wt, 'move a main');

    const text = mod
      .compareSnapshots(before, mod.takeSnapshot(dir), {
        agentRoot: join(makeTempDir('wt-'), 'outra'),
      })
      .join('\n');

    expect(text).toContain('refs/heads/main');
  });

  it('AI-33 uma worktree nova sob .claude/worktrees/ da pasta do retrato, que não é o agentRoot, aparece em worktrees', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(
      dir,
      'worktree',
      'add',
      '-q',
      join(dir, '.claude', 'worktrees', 'x'),
      '-b',
      'x',
    );

    const semOpcao = mod.compareSnapshots(before, mod.takeSnapshot(dir));
    const comOutraRaiz = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
      agentRoot: join(dir, '.claude', 'worktrees', 'y'),
    });

    expect(
      semOpcao.filter((line) => line.startsWith('worktrees')),
    ).toHaveLength(1);
    expect(
      comOutraRaiz.filter((line) => line.startsWith('worktrees')),
    ).toHaveLength(1);
  });

  it('AI-33 uma branch worktree-agent-x criada na pasta principal aparece em refs', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    git(dir, 'branch', 'worktree-agent-x');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir));

    expect(changes).toHaveLength(1);
    expect(changes[0]?.startsWith('refs')).toBe(true);
    expect(changes[0]).toContain('refs/heads/worktree-agent-x');
  });

  // Controle negativo 1: a branch da worktree do próprio agente (agentRoot) fica fora da comparação de refs (AI-33),
  // mas o commit feito nela conta como mudança pelo HEAD da worktree (AI-12, A3 da Revisão do #19).
  // O segundo cenário deixa a pasta principal em outra branch, sem o checkout da main.
  it.each([
    ['com a pasta principal na main', () => undefined],
    [
      'sem o checkout da main',
      (dir: string) => git(dir, 'checkout', '-q', '-b', 'outra'),
    ],
  ])(
    'AI-33 e AI-12 com agentRoot, um commit na branch da worktree do agente que existia no início (%s) sai do refs e aparece pelo HEAD da worktree',
    (_label, prepare) => {
      const dir = repo();
      prepare(dir);
      const agentRoot = join(makeTempDir('wt-'), 'agente');
      git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agente');
      const before = mod.takeSnapshot(dir);
      commitEmpty(agentRoot, 'do agente');
      const commit = git(agentRoot, 'rev-parse', 'HEAD').trim();

      const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
        agentRoot,
      });

      expectCommitWithoutAgentRef(changes, agentRoot, commit, 'agente');
    },
  );

  it('AI-33 controle: com agentRoot, a worktree e a branch criadas durante a execução também não aparecem', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    const agentRoot = join(makeTempDir('wt-'), 'agente');
    git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agente-novo');
    commitEmpty(agentRoot, 'do agente');

    expect(
      mod.compareSnapshots(before, mod.takeSnapshot(dir), { agentRoot }),
    ).toEqual([]);
  });

  it('AI-33 controle: o agentRoot só poupa o caminho exato; outra worktree nova junto com ele continua aparecendo', () => {
    const dir = repo();
    const agentRoot = join(makeTempDir('wt-'), 'agente');
    git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agente');
    const before = mod.takeSnapshot(dir);
    git(
      dir,
      'worktree',
      'add',
      '-q',
      join(dir, '.claude', 'worktrees', 'intrusa'),
      '-b',
      'intrusa',
    );

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
      agentRoot,
    });

    expect(changes.filter((line) => line.startsWith('worktrees'))).toHaveLength(
      1,
    );
    expect(changes.join('\n')).toContain('refs/heads/intrusa');
  });

  // Controle negativo 2: com o agentRoot dado, o que outra sessão faz continua fora da comparação.
  it('AI-33 controle: com agentRoot, um commit em outra worktree do início e um ref remoto não aparecem', () => {
    const dir = repo();
    const other = join(makeTempDir('wt-'), 'outra');
    git(dir, 'worktree', 'add', '-q', other, '-b', 'outra');
    const agentRoot = join(makeTempDir('wt-'), 'agente');
    git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agente');
    const before = mod.takeSnapshot(dir);
    commitEmpty(other, 'da outra sessão');
    git(dir, 'update-ref', 'refs/remotes/origin/z', 'HEAD');

    expect(
      mod.compareSnapshots(before, mod.takeSnapshot(dir), { agentRoot }),
    ).toEqual([]);
  });

  // A2 da Revisão 2: só a branch presa à worktree do agente no retrato do início fica fora da comparação. Se o agente
  // troca a própria worktree para a main (livre no início) e a move, a main mudou e a comparação precisa dizer.
  it('AI-33 o agente que troca a própria worktree para a main e faz um commit nela faz a main aparecer em refs', () => {
    const dir = repo();
    git(dir, 'checkout', '-q', '-b', 'outra');
    const agentRoot = join(makeTempDir('wt-'), 'agente');
    git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agente');
    const before = mod.takeSnapshot(dir);
    git(agentRoot, 'checkout', '-q', 'main');
    commitEmpty(agentRoot, 'move a main pela worktree do agente');

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
      agentRoot,
    });

    expect(changes.join('\n')).toContain('refs/heads/main');
    expect(changes.filter((line) => line.startsWith('refs'))).toHaveLength(1);
  });
});

// A3 da Revisão do #19 (AI-12): o retrato guarda o HEAD da worktree do agente isolado, e um commit feito ali conta como
// mudança. Antes só a branch dela era conhecida, e essa fica fora da comparação de refs (AI-33). O critério é a saída de
// compareSnapshots: o teste não fixa o nome do campo interno que guarda o HEAD da worktree.
describe('AI-12 um commit do agente isolado na própria worktree conta como mudança', () => {
  // A worktree nasce antes do primeiro retrato, onde o Claude Code a cria. A pasta fica no .gitignore, como no projeto,
  // para o status da pasta principal não depender da pasta aninhada.
  function repoWithAgentWorktree(): { dir: string; agentRoot: string } {
    const dir = repo();
    writeFileIn(dir, '.gitignore', '.claude/worktrees/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'ignora as worktrees');
    const agentRoot = join(dir, '.claude', 'worktrees', 'agent-x');
    git(dir, 'worktree', 'add', '-q', agentRoot, '-b', 'agent-x');
    return { dir, agentRoot };
  }

  it.each([
    [
      'um commit novo',
      (agentRoot: string) => commitEmpty(agentRoot, 'do agente isolado'),
    ],
    [
      'um amend do commit da worktree',
      (agentRoot: string) =>
        git(
          agentRoot,
          'commit',
          '-q',
          '--allow-empty',
          '--amend',
          '-m',
          'reescrito',
        ),
    ],
  ])(
    'AI-12 %s na worktree do agente aparece na comparação, citando a worktree ou o commit',
    (_label, act) => {
      const { dir, agentRoot } = repoWithAgentWorktree();
      const before = mod.takeSnapshot(dir);
      act(agentRoot);
      const commit = git(agentRoot, 'rev-parse', 'HEAD').trim();

      const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
        agentRoot,
      });

      expect(changes.length).toBeGreaterThan(0);
      expect(citesWorktreeOrCommit(changes, agentRoot, commit)).toBe(true);
    },
  );

  it('AI-12 vários commits na worktree do agente citam o HEAD final', () => {
    const { dir, agentRoot } = repoWithAgentWorktree();
    const before = mod.takeSnapshot(dir);
    commitEmpty(agentRoot, 'um');
    commitEmpty(agentRoot, 'dois');
    const commit = git(agentRoot, 'rev-parse', 'HEAD').trim();

    const changes = mod.compareSnapshots(before, mod.takeSnapshot(dir), {
      agentRoot,
    });

    expect(changes.join('\n')).toContain(commit.slice(0, 7));
  });

  // Controle negativo 1: sem commit, o retrato da worktree não muda.
  it('AI-12 controle: sem commit na worktree do agente, nada é atribuído', () => {
    const { dir, agentRoot } = repoWithAgentWorktree();
    const before = mod.takeSnapshot(dir);

    expect(
      mod.compareSnapshots(before, mod.takeSnapshot(dir), { agentRoot }),
    ).toEqual([]);
  });

  // Controle negativo 2: um arquivo editado na worktree sem commit não é mudança de git (é o `git status`, que a
  // parada confere à parte).
  it('AI-12 controle: um arquivo editado na worktree do agente sem commit não é mudança de git', () => {
    const { dir, agentRoot } = repoWithAgentWorktree();
    const before = mod.takeSnapshot(dir);
    writeFileIn(agentRoot, 'src/app.ts', 'export const editado = 1;\n');
    writeFileIn(agentRoot, 'src/novo.ts', 'export {};\n');

    expect(
      mod.compareSnapshots(before, mod.takeSnapshot(dir), { agentRoot }),
    ).toEqual([]);
  });

  // Controle negativo 3: o commit de outra sessão em outra worktree continua fora (AI-33), com o agentRoot dado.
  it('AI-12 controle: com agentRoot, só o commit da worktree do agente é citado, e o de outra worktree não', () => {
    const { dir, agentRoot } = repoWithAgentWorktree();
    const other = join(makeTempDir('wt-'), 'outra');
    git(dir, 'worktree', 'add', '-q', other, '-b', 'outra');
    const before = mod.takeSnapshot(dir);
    commitEmpty(other, 'da outra sessão');
    const otherCommit = git(other, 'rev-parse', 'HEAD').trim();
    commitEmpty(agentRoot, 'do agente isolado');
    const agentCommit = git(agentRoot, 'rev-parse', 'HEAD').trim();

    const text = mod
      .compareSnapshots(before, mod.takeSnapshot(dir), { agentRoot })
      .join('\n');

    expect(citesWorktreeOrCommit([text], agentRoot, agentCommit)).toBe(true);
    expect(text).not.toContain(other);
    expect(text).not.toContain(otherCommit.slice(0, 7));
  });
});

function renameFile(dir: string, from: string, to: string): void {
  renameSync(join(dir, from), join(dir, to));
}

function sorted(paths: string[]): string[] {
  return [...paths].sort();
}

// O status gravado (AI-12): uma lista JSON de entradas. O `statusOf` monta o texto a partir de linhas `XY caminho\thash`.
describe('AI-28 changesDuring compara duas saídas do git status', () => {
  const BEFORE = [
    ' M src/antes.ts',
    '?? src/novo-antes.ts',
    'D  src/some-antes.ts',
  ];

  it('AI-28 saídas iguais não atribuem nada', () => {
    expect(mod.changesDuring(statusOf(...BEFORE), statusOf(...BEFORE))).toEqual(
      [],
    );
    expect(mod.changesDuring(statusOf(), statusOf())).toEqual([]);
  });

  it('AI-28 uma linha que aparece é atribuída', () => {
    expect(
      mod
        .changesDuring(
          statusOf(...BEFORE),
          statusOf(...BEFORE, ' M src/durante.ts', '?? src/criado.ts'),
        )
        .sort(),
    ).toEqual(['src/criado.ts', 'src/durante.ts']);
  });

  it('AI-28 uma linha que some é atribuída (o arquivo voltou ao estado do HEAD)', () => {
    expect(
      mod.changesDuring(
        statusOf(...BEFORE),
        statusOf(' M src/antes.ts', '?? src/novo-antes.ts'),
      ),
    ).toEqual(['src/some-antes.ts']);
  });

  it('AI-28 uma linha que muda é atribuída (o arquivo foi para o índice, ou foi apagado)', () => {
    expect(
      sorted(
        mod.changesDuring(
          statusOf(...BEFORE),
          statusOf(
            'M  src/antes.ts',
            '?? src/novo-antes.ts',
            'D  src/some-antes.ts',
          ),
        ),
      ),
    ).toEqual(['src/antes.ts']);
    expect(
      mod.changesDuring(statusOf(' M src/a.ts'), statusOf(' D src/a.ts')),
    ).toEqual(['src/a.ts']);
  });

  it('AI-28 a mesma linha com outro hash de conteúdo é atribuída', () => {
    expect(
      mod.changesDuring(
        statusOf(' M src/a.ts\thash1', ' M src/b.ts\thash2'),
        statusOf(' M src/a.ts\thash9', ' M src/b.ts\thash2'),
      ),
    ).toEqual(['src/a.ts']);
  });

  // Controle negativo: sem o retrato do início (a comparação contra o HEAD, que é só o status da parada), a mudança
  // anterior ao agente é atribuída a ele.
  it('AI-28 controle: contra o HEAD, sem o início, a mudança anterior é atribuída; com o início, não', () => {
    const duringOnly = statusOf(' M src/antes.ts', ' M src/durante.ts');

    expect(sorted(mod.changesDuring(statusOf(), duringOnly))).toEqual([
      'src/antes.ts',
      'src/durante.ts',
    ]);
    expect(mod.changesDuring(statusOf(' M src/antes.ts'), duringOnly)).toEqual([
      'src/durante.ts',
    ]);
  });
});

// Repositório de verdade: a mudança é feita no disco, e o retrato do início e o da parada são tirados com
// takeSnapshot, como os hooks fazem.
describe('AI-28 changesDuring com o retrato do git de um repositório real', () => {
  function seeded(): string {
    const dir = repo();
    writeFileIn(dir, 'src/limpo.ts', 'export const limpo = 1;\n');
    writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'mais arquivos');
    return dir;
  }

  function changes(dir: string, act: () => void): string[] {
    const before = mod.takeSnapshot(dir);
    act();
    return sorted(
      mod.changesDuring(before.status, mod.takeSnapshot(dir).status),
    );
  }

  it('AI-28 sem nenhuma mudança entre o início e a parada, nada é atribuído', () => {
    const dir = seeded();

    expect(changes(dir, () => undefined)).toEqual([]);
  });

  it('AI-28 uma mudança feita antes do início não é atribuída ao agente', () => {
    const dir = seeded();
    writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 2;\n');
    writeFileIn(dir, 'src/criado-antes.ts', 'export {};\n');

    expect(changes(dir, () => undefined)).toEqual([]);
  });

  it('AI-28 um arquivo alterado ou criado entre o início e a parada é atribuído, em pasta nova também', () => {
    const dir = seeded();
    writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 2;\n');

    const result = changes(dir, () => {
      writeFileIn(dir, 'src/limpo.ts', 'export const limpo = 2;\n');
      writeFileIn(dir, 'src/pasta/nova/criado.ts', 'export {};\n');
    });

    expect(result).toEqual(['src/limpo.ts', 'src/pasta/nova/criado.ts']);
  });

  it('AI-28 um arquivo rastreado apagado durante a execução é atribuído', () => {
    const dir = seeded();

    expect(changes(dir, () => rmSync(join(dir, 'src/limpo.ts')))).toEqual([
      'src/limpo.ts',
    ]);
  });

  it('AI-28 um arquivo já sujo no início e alterado de novo é atribuído, mesmo com a linha do status igual', () => {
    const dir = seeded();
    writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 2;\n');
    writeFileIn(dir, 'src/criado-antes.ts', 'export const a = 1;\n');

    const result = changes(dir, () => {
      writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 3;\n');
      writeFileIn(dir, 'src/criado-antes.ts', 'export const a = 2;\n');
    });

    expect(result).toEqual(['src/criado-antes.ts', 'src/sujo-antes.ts']);
  });

  // Controle negativo: o status da parada sozinho (contra o HEAD) atribui ao agente o que já estava sujo.
  it('AI-28 controle: contra o HEAD, sem o retrato do início, a mudança anterior seria atribuída', () => {
    const dir = seeded();
    writeFileIn(dir, 'src/sujo-antes.ts', 'export const sujo = 2;\n');
    const before = mod.takeSnapshot(dir);
    writeFileIn(dir, 'src/limpo.ts', 'export const limpo = 2;\n');
    const after = mod.takeSnapshot(dir);

    expect(sorted(mod.changesDuring(statusOf(), after.status))).toEqual([
      'src/limpo.ts',
      'src/sujo-antes.ts',
    ]);
    expect(mod.changesDuring(before.status, after.status)).toEqual([
      'src/limpo.ts',
    ]);
  });
});

// A5 da Revisão do #19 (AI-12): o status vem de `--porcelain=v1 -z`. Sem o -z, o git escapa entre aspas, com octal, o
// nome fora do ASCII ou com espaço, o `git hash-object` não acha o arquivo e a segunda edição passa batida.
describe('AI-12 o status lido com -z não escapa nome fora do ASCII nem com espaço', () => {
  const NAMES = ['src/ação.ts', 'src/a b.ts'];

  // Os dois arquivos existem no HEAD: o teste os suja antes do início (rastreados) ou os cria sem rastrear.
  function seeded(): string {
    const dir = repo();
    for (const name of NAMES) writeFileIn(dir, name, 'export const v = 0;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'nomes difíceis');
    return dir;
  }

  function writeAll(dir: string, content: string): void {
    for (const name of NAMES) writeFileIn(dir, name, content);
  }

  it.each([
    ['rastreados', seeded],
    ['novos (não rastreados)', repo],
  ])(
    'AI-12 arquivos %s já sujos no início e editados de novo durante o agente são atribuídos, pelo nome sem escape',
    (_label, makeDir) => {
      const dir = makeDir();
      writeAll(dir, 'export const v = 1;\n');
      const before = mod.takeSnapshot(dir);
      writeAll(dir, 'export const v = 2;\n');

      expect(
        sorted(mod.changesDuring(before.status, mod.takeSnapshot(dir).status)),
      ).toEqual(sorted(NAMES));
    },
  );

  it('AI-12 o status do retrato traz o nome como é, sem aspas e sem octal', () => {
    const dir = seeded();
    writeAll(dir, 'export const v = 1;\n');

    const { status } = mod.takeSnapshot(dir);

    expect(sorted(statusList(status).map((entry) => entry.path))).toEqual(
      sorted(NAMES),
    );
    expect(status).not.toContain('\\303');
  });

  // Controle negativo: sem a segunda edição, nada é atribuído, mesmo com os nomes difíceis já sujos no início.
  it('AI-12 controle: arquivos de nome difícil sujos no início e sem nova edição não são atribuídos', () => {
    const dir = seeded();
    writeAll(dir, 'export const v = 1;\n');
    const before = mod.takeSnapshot(dir);

    expect(
      mod.changesDuring(before.status, mod.takeSnapshot(dir).status),
    ).toEqual([]);
  });

  // Controle negativo: um arquivo de nome difícil criado durante o agente é atribuído com o nome certo.
  it('AI-12 controle: um arquivo de nome difícil criado durante o agente é atribuído pelo nome sem escape', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    writeAll(dir, 'export const v = 1;\n');

    expect(
      sorted(mod.changesDuring(before.status, mod.takeSnapshot(dir).status)),
    ).toEqual(sorted(NAMES));
  });
});

// Forma escolhida para a falha do `git hash-object` (A5): o `takeSnapshot` lança um Error. Um status vazio ou com um
// hash fixo (`?`) faria a segunda edição passar batida; um erro obriga quem chama (os hooks) a registrar a exceção.
// A leitura negada vem de `chmod 000`, que o root ignora: o teste só roda para um usuário comum.
describe('AI-12 uma falha do git hash-object não vira status vazio', () => {
  const isRoot = process.getuid?.() === 0;

  // O erro cita o arquivo, para quem lê a exceção saber qual leitura falhou.
  it.skipIf(isRoot).each([
    ['novo', 'src/ilegivel.ts'],
    ['rastreado e alterado', 'src/app.ts'],
  ])(
    'AI-12 um arquivo %s sujo e ilegível faz o takeSnapshot lançar erro que cita %s',
    (_label, file) => {
      const dir = repo();
      writeFileIn(dir, file, 'export const a = 1;\n');
      chmodSync(join(dir, file), 0o000);

      expect(() => mod.takeSnapshot(dir)).toThrow(file);
    },
  );

  // Controle negativo: o mesmo arquivo, legível, gera retrato sem erro.
  it('AI-12 controle: o mesmo arquivo, legível, gera o retrato com o status dele', () => {
    const dir = repo();
    writeFileIn(dir, 'src/ilegivel.ts', 'export {};\n');

    expect(mod.takeSnapshot(dir).status).toContain('src/ilegivel.ts');
  });
});

// A16 da Revisão 4 (AI-12): no `-z`, um rename traz o destino e, depois do NUL seguinte, a origem. O `R` costuma estar na
// coluna X (rename no índice), mas um rename feito na worktree e registrado só com `git add -N` põe o `R` na coluna Y,
// e a origem vem do mesmo jeito. Quem lê o `-z` só pela coluna X trata a origem como um arquivo com código próprio.
describe('AI-12 o rename lido do status -z não vira uma entrada com a origem', () => {
  // Cada caso renomeia um arquivo rastreado: o destino e a origem, e como o git registra o rename.
  const CASES: [string, string, string, (dir: string) => void][] = [
    [
      'o R na coluna Y (mv e git add -N)',
      'src/app.ts',
      'src/novo.ts',
      (dir) => {
        renameFile(dir, 'src/app.ts', 'src/novo.ts');
        git(dir, 'add', '-N', 'src/novo.ts');
      },
    ],
    [
      'o R na coluna Y, com espaço e acento nos nomes',
      'src/app.ts',
      'src/ação nova.ts',
      (dir) => {
        renameFile(dir, 'src/app.ts', 'src/ação nova.ts');
        git(dir, 'add', '-N', 'src/ação nova.ts');
      },
    ],
    [
      'o R na coluna X (git mv)',
      'src/app.ts',
      'src/movido.ts',
      (dir) => git(dir, 'mv', 'src/app.ts', 'src/movido.ts'),
    ],
  ];

  function pathsOf(dir: string): string[] {
    return mod.statusEntries(dir).map((entry) => entry.path);
  }

  it('AI-12 o git de teste põe o R na coluna Y com o add -N (premissa dos casos)', () => {
    const dir = repo();
    renameFile(dir, 'src/app.ts', 'src/novo.ts');
    git(dir, 'add', '-N', 'src/novo.ts');

    expect(git(dir, 'status', '--porcelain=v1')).toBe(
      ' R src/app.ts -> src/novo.ts\n',
    );
    expect(
      git(dir, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    ).toBe(' R src/novo.ts\0src/app.ts\0');
  });

  it.each(CASES)(
    'AI-12 com %s o destino é uma entrada e a origem não é',
    (_label, origin, destination, act) => {
      const dir = repo();
      act(dir);

      const paths = pathsOf(dir);

      expect(paths.filter((path) => path === destination)).toHaveLength(1);
      expect(paths).not.toContain(origin);
    },
  );

  // Um registro do git, uma entrada: o rename sozinho dá exatamente uma, a do destino, sem sobra com o caminho da origem
  // cortado ou lido como se tivesse código.
  it.each(CASES)(
    'AI-12 com %s o status tem exatamente uma entrada, a do destino',
    (_label, _origin, destination, act) => {
      const dir = repo();
      act(dir);

      expect(pathsOf(dir)).toEqual([destination]);
    },
  );

  // Controle: um arquivo comum sujo ao lado do rename segue como entrada própria, na ordem do git.
  it('AI-12 controle: um arquivo alterado e outro criado junto do rename seguem como entradas próprias', () => {
    const dir = repo();
    writeFileIn(dir, 'src/outro.ts', 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'outro');
    renameFile(dir, 'src/app.ts', 'src/novo.ts');
    git(dir, 'add', '-N', 'src/novo.ts');
    writeFileIn(dir, 'src/outro.ts', 'export const v = 1;\n');
    writeFileIn(dir, 'src/criado.ts', 'export {};\n');

    const paths = pathsOf(dir);

    expect(sorted(paths)).toEqual([
      'src/criado.ts',
      'src/novo.ts',
      'src/outro.ts',
    ]);
  });

  // O retrato e a comparação não atribuem a origem como arquivo à parte: um rename feito durante o agente atribui o destino.
  it('AI-12 o rename na coluna Y feito durante o agente atribui o destino e não a origem como arquivo à parte', () => {
    const dir = repo();
    const before = mod.takeSnapshot(dir);
    renameFile(dir, 'src/app.ts', 'src/novo.ts');
    git(dir, 'add', '-N', 'src/novo.ts');

    const changed = mod.changesDuring(
      before.status,
      mod.takeSnapshot(dir).status,
    );

    expect(changed).toContain('src/novo.ts');
    expect(changed.filter((path) => path !== 'src/novo.ts')).toEqual([]);
  });
});

// AI-12: o status é gravado como lista JSON de entradas (código, caminho, origem, hash) e o `git hash-object` recebe os
// caminhos como argumentos. Com um caminho por linha na entrada padrão, um nome com quebra de linha virava dois caminhos,
// um com aspas no começo era lido como escapado, e o retrato lançava ou perdia a segunda edição.
describe('AI-12 o status em JSON aguenta nome com quebra de linha, tab e aspas no começo', () => {
  const HARD_NAMES: [string, string][] = [
    ['quebra de linha', 'src/a\nb.ts'],
    ['tab', 'src/a\tb.ts'],
    ['aspas no começo', '"aspas.ts'],
  ];
  const HARD = HARD_NAMES.map(([, name]) => name);

  function dirtyRepo(content: string): string {
    const dir = repo();
    for (const name of [...HARD, 'src/comum.ts'])
      writeFileIn(dir, name, content);
    return dir;
  }

  it.each(HARD_NAMES)(
    'AI-12 o takeSnapshot não lança com um arquivo sujo com %s no nome',
    (_label, name) => {
      const dir = repo();
      writeFileIn(dir, name, 'export {};\n');

      expect(() => mod.takeSnapshot(dir)).not.toThrow();
    },
  );

  it('AI-12 o status do retrato é uma lista JSON de entradas com código, caminho, origem nula e o hash do arquivo', () => {
    const dir = dirtyRepo('export const v = 1;\n');

    const entries = statusList(mod.takeSnapshot(dir).status);

    expect(sorted(entries.map((entry) => entry.path))).toEqual(
      sorted([...HARD, 'src/comum.ts']),
    );
    for (const entry of entries) {
      expect(entry.code).toBe('??');
      expect(entry.origin).toBeNull();
      expect(entry.hash).toBe(git(dir, 'hash-object', '--', entry.path).trim());
    }
  });

  it.each(HARD_NAMES)(
    'AI-12 o arquivo com %s no nome, sujo no início e editado de novo, é atribuído pelo nome exato',
    (_label, name) => {
      const dir = dirtyRepo('export const v = 1;\n');
      const before = mod.takeSnapshot(dir);
      writeFileIn(dir, name, 'export const v = 2;\n');

      expect(
        mod.changesDuring(before.status, mod.takeSnapshot(dir).status),
      ).toEqual([name]);
    },
  );

  // Controle negativo: sem nova edição nada é atribuído, e o nome comum ao lado segue como uma entrada igual.
  it('AI-12 controle: sem nova edição, os nomes difíceis e o nome comum não são atribuídos', () => {
    const dir = dirtyRepo('export const v = 1;\n');
    const before = mod.takeSnapshot(dir);

    const after = mod.takeSnapshot(dir);

    expect(mod.changesDuring(before.status, after.status)).toEqual([]);
    expect(statusList(after.status)).toEqual(statusList(before.status));
  });

  it('AI-12 controle: o nome comum editado de novo continua sendo atribuído, sozinho', () => {
    const dir = dirtyRepo('export const v = 1;\n');
    const before = mod.takeSnapshot(dir);
    writeFileIn(dir, 'src/comum.ts', 'export const v = 2;\n');

    expect(
      mod.changesDuring(before.status, mod.takeSnapshot(dir).status),
    ).toEqual(['src/comum.ts']);
  });
});

// AI-03 e AI-12: o status guarda a origem de um rename ou de uma cópia. O hook de parada confere a origem junto com o
// destino, porque um `git mv test/a.test.ts src/a.ts` deixaria só `src/a.ts` à vista e tiraria o teste do lugar.
describe('AI-03 e AI-12 o status guarda a origem de um rename', () => {
  const CASES: [string, (dir: string) => void][] = [
    [
      'git mv (R na coluna X)',
      (dir) => git(dir, 'mv', 'src/app.ts', 'src/movido.ts'),
    ],
    [
      'mv e git add -N (R na coluna Y)',
      (dir) => {
        renameFile(dir, 'src/app.ts', 'src/movido.ts');
        git(dir, 'add', '-N', 'src/movido.ts');
      },
    ],
  ];

  it.each(CASES)(
    'AI-03 o statusEntries guarda a origem do rename feito com %s',
    (_label, act) => {
      const dir = repo();
      act(dir);

      const entries = mod.statusEntries(dir);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe('src/movido.ts');
      expect(entries[0]?.origin).toBe('src/app.ts');
    },
  );

  it.each(CASES)(
    'AI-12 o retrato grava a origem do rename feito com %s e o destino como caminho',
    (_label, act) => {
      const dir = repo();
      act(dir);

      const entries = statusList(mod.takeSnapshot(dir).status);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.path).toBe('src/movido.ts');
      expect(entries[0]?.origin).toBe('src/app.ts');
    },
  );

  // Controle negativo: fora de um rename a origem é nula, e o arquivo comum não ganha uma origem.
  it('AI-12 controle: um arquivo alterado e outro criado não têm origem', () => {
    const dir = repo();
    writeFileIn(dir, 'src/app.ts', 'export const v = 1;\n');
    writeFileIn(dir, 'src/criado.ts', 'export {};\n');

    const entries = mod.statusEntries(dir);

    expect(sorted(entries.map((entry) => entry.path))).toEqual([
      'src/app.ts',
      'src/criado.ts',
    ]);
    for (const entry of entries) expect(entry.origin ?? null).toBeNull();
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
    expect(mod.snapshotFile('sess-1', 'ag-1')).toBe(
      mod.snapshotFile('sess-1', 'ag-1'),
    );
  });

  it('AI-12 um agent_id com barras não sai de os.tmpdir()', () => {
    const dir = makeTempDir('tmpdir-');
    process.env.TMPDIR = dir;

    const file = mod.snapshotFile('../../s', '../../../evil');

    expect(relative(dir, file).startsWith('..')).toBe(false);
  });
});
