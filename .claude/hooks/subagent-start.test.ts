import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, commitEmpty, initRepo, makeTempDir } from '../../test/helpers/git-sandbox.ts';

interface Snapshot {
  head: string;
  refs: string;
  worktrees: string;
  config: string;
}

interface SnapshotModule {
  takeSnapshot(projectDir: string): Snapshot;
  snapshotFile(sessionId: string, agentId: string): string;
}

const hook = join(import.meta.dirname, 'subagent-start.mjs');

let snapshots: SnapshotModule;

beforeAll(async () => {
  snapshots = (await import(pathToFileURL(join(import.meta.dirname, 'git-snapshot.mjs')).href)) as SnapshotModule;
});

afterEach(cleanupTempDirs);

interface Sandbox {
  project: string;
  tmp: string;
}

function makeSandbox(): Sandbox {
  const project = makeTempDir('start-proj-');
  initRepo(project);
  return { project, tmp: makeTempDir('start-tmp-') };
}

function run(sandbox: Sandbox, raw: string, env: { projectDir?: string | null } = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, TMPDIR: sandbox.tmp };
  delete base.CLAUDE_PROJECT_DIR;
  const projectDir = env.projectDir === undefined ? sandbox.project : env.projectDir;
  if (projectDir !== null) base.CLAUDE_PROJECT_DIR = projectDir;
  const result = spawnSync(process.execPath, [hook], {
    input: raw,
    encoding: 'utf8',
    cwd: makeTempDir('start-cwd-'),
    env: base,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function startInput(sandbox: Sandbox, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: 'SubagentStart',
    session_id: 's1',
    agent_id: 'a1',
    agent_type: 'implementer',
    cwd: sandbox.project,
    ...extra,
  });
}

// O caminho vem do módulo, com o TMPDIR do sandbox, como o processo o enxerga.
function pathIn(sandbox: Sandbox, sessionId: string, agentId: string): string {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = sandbox.tmp;
  try {
    return snapshots.snapshotFile(sessionId, agentId);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

function readSnapshot(sandbox: Sandbox, sessionId = 's1', agentId = 'a1'): Snapshot {
  return JSON.parse(readFileSync(pathIn(sandbox, sessionId, agentId), 'utf8')) as Snapshot;
}

describe('AI-12 o hook de início grava o retrato do git do agente', () => {
  it.each(['implementer', 'test-writer', 'reviewer'])(
    'AI-12 o %s tem o retrato gravado em snapshotFile, igual ao takeSnapshot do projeto, sem saída',
    (agentType) => {
      const sandbox = makeSandbox();

      const result = run(sandbox, startInput(sandbox, { agent_type: agentType }));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
      expect(readSnapshot(sandbox)).toEqual(snapshots.takeSnapshot(sandbox.project));
    },
  );

  it('AI-12 o retrato fica dentro do TMPDIR, e não no projeto', () => {
    const sandbox = makeSandbox();

    run(sandbox, startInput(sandbox));

    expect(pathIn(sandbox, 's1', 'a1').startsWith(sandbox.tmp)).toBe(true);
    expect(existsSync(pathIn(sandbox, 's1', 'a1'))).toBe(true);
    expect(readdirSync(sandbox.project).filter((name) => name.includes('snapshot'))).toEqual([]);
  });

  it('AI-12 cada agente tem o seu retrato', () => {
    const sandbox = makeSandbox();

    run(sandbox, startInput(sandbox, { agent_id: 'a1' }));
    commitEmpty(sandbox.project);
    run(sandbox, startInput(sandbox, { agent_id: 'a2' }));

    expect(readSnapshot(sandbox, 's1', 'a1').head).not.toBe(readSnapshot(sandbox, 's1', 'a2').head);
  });

  it('AI-12 rodar de novo (retomada) sobrescreve o retrato', () => {
    const sandbox = makeSandbox();
    run(sandbox, startInput(sandbox));
    const first = readSnapshot(sandbox);
    commitEmpty(sandbox.project);

    const result = run(sandbox, startInput(sandbox));

    expect(result.code).toBe(0);
    expect(readSnapshot(sandbox).head).not.toBe(first.head);
    expect(readSnapshot(sandbox)).toEqual(snapshots.takeSnapshot(sandbox.project));
  });

  it('AI-12 sem CLAUDE_PROJECT_DIR usa o cwd da entrada', () => {
    const sandbox = makeSandbox();

    const result = run(sandbox, startInput(sandbox), { projectDir: null });

    expect(result.code).toBe(0);
    expect(readSnapshot(sandbox)).toEqual(snapshots.takeSnapshot(sandbox.project));
  });

  // Controle negativo: a entrada ilegível não grava retrato nenhum e avisa, sem bloquear o início do agente com código 2.
  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"session_id": "s1", "agent_id": '],
  ])('AI-12 entrada ilegível sai com código diferente de 0, avisa no stderr e não grava (%s)', (_label, raw) => {
    const sandbox = makeSandbox();

    const result = run(sandbox, raw);

    expect(result.code).not.toBe(0);
    expect(result.code).not.toBe(2);
    expect(result.stderr).not.toBe('');
    expect(readdirSync(sandbox.tmp)).toEqual([]);
  });
});
