import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, git, initRepo, makeTempDir } from '../../test/helpers/git-sandbox.ts';

// O hook é um script: o que o Claude Code vê é o código de saída, o stderr e os arquivos gravados.
const hookFile = join(import.meta.dirname, 'post-tool.mjs');
const stopFile = join(import.meta.dirname, 'subagent-stop.mjs');

afterEach(cleanupTempDirs);

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(script: string, project: string, raw: string): HookResult {
  const result = spawnSync(process.execPath, [script], {
    input: raw,
    encoding: 'utf8',
    cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runPostTool(project: string, input: unknown): HookResult {
  return runScript(hookFile, project, JSON.stringify(input));
}

function handback(project: string, agentType: string | undefined, agentId: string, message: unknown): HookResult {
  return runPostTool(project, {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    cwd: project,
    ...(agentType ? { agent_type: agentType } : {}),
    agent_id: agentId,
    tool_name: 'SubagentHandback',
    tool_input: { message },
  });
}

function skill(project: string, name: unknown, toolName = 'Skill'): HookResult {
  return runPostTool(project, {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    cwd: project,
    tool_name: toolName,
    tool_input: { skill: name },
  });
}

function reviewsDir(project: string): string {
  return join(project, '.claude', 'reviews');
}

function savedReviews(project: string): string[] {
  return existsSync(reviewsDir(project)) ? readdirSync(reviewsDir(project)) : [];
}

function securityRecords(project: string): string[] {
  const dir = join(project, '.claude', 'state', 'security-review');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function headOf(project: string): string {
  return git(project, 'rev-parse', 'HEAD').trim();
}

const REPORT = '## Revisão 2\n\n- achado: não corrigido (rodada 2)\n\n```ts\nconst a = `x`;\n```\n';

describe('AI-15 o PostToolUse do SubagentHandback grava o relatório do reviewer', () => {
  it('AI-15 o reviewer em segundo plano tem o tool_input.message gravado em .claude/reviews/<agent_id>.md, sem alteração', () => {
    const project = makeTempDir('ai15-');

    const result = handback(project, 'reviewer', 'r1', REPORT);

    expect(result.code).toBe(0);
    expect(readFileSync(join(reviewsDir(project), 'r1.md'), 'utf8')).toBe(REPORT);
  });

  it('AI-15 a mensagem curta e sem quebra de linha também é gravada exatamente como veio', () => {
    const project = makeTempDir('ai15-');

    handback(project, 'reviewer', 'r2', '## Revisão 1');

    expect(readFileSync(join(reviewsDir(project), 'r2.md'), 'utf8')).toBe('## Revisão 1');
  });

  it('AI-15 o relatório de um agente não toca o de outro', () => {
    const project = makeTempDir('ai15-');

    handback(project, 'reviewer', 'r1', 'A');
    handback(project, 'reviewer', 'r2', 'B');

    expect(readFileSync(join(reviewsDir(project), 'r1.md'), 'utf8')).toBe('A');
    expect(readFileSync(join(reviewsDir(project), 'r2.md'), 'utf8')).toBe('B');
  });

  // Controle negativo: só o reviewer entrega relatório.
  it.each([
    ['implementer', 'implementer'],
    ['test-writer', 'test-writer'],
    ['agente sem tipo', undefined],
    ['general-purpose', 'general-purpose'],
  ])('AI-15 controle: o %s não grava relatório', (_label, agentType) => {
    const project = makeTempDir('ai15-');

    const result = handback(project, agentType, 'x1', REPORT);

    expect(result.code).toBe(0);
    expect(savedReviews(project)).toEqual([]);
  });

  it.each([
    ['vazia', ''],
    ['número', 42],
    ['nulo', null],
    ['objeto', { text: REPORT }],
    ['lista', [REPORT]],
    ['ausente', undefined],
  ])('AI-15 a mensagem %s não grava nada e o hook sai com 0', (_label, message) => {
    const project = makeTempDir('ai15-');

    const result = handback(project, 'reviewer', 'r1', message);

    expect(result.code).toBe(0);
    expect(savedReviews(project)).toEqual([]);
  });

  it('AI-15 um tool_name que não é SubagentHandback não grava relatório, mesmo com message', () => {
    const project = makeTempDir('ai15-');

    const result = runPostTool(project, {
      agent_type: 'reviewer',
      agent_id: 'r1',
      tool_name: 'Bash',
      tool_input: { message: REPORT },
    });

    expect(result.code).toBe(0);
    expect(savedReviews(project)).toEqual([]);
  });

  it.each(['../../evil', '..', '../x', 'a/b', '/etc/passwd', '.oculto', 'com espaço', 'a\\b', 'x\u0000y'])(
    'AI-15 o agent_id %j não grava fora de .claude/reviews/',
    (agentId) => {
      const project = makeTempDir('ai15-');

      const result = handback(project, 'reviewer', agentId, REPORT);

      expect(result.code).toBe(0);
      const saved = savedReviews(project);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatch(/^[\w-][\w.-]*$/);
      expect(readFileSync(join(reviewsDir(project), saved[0] ?? ''), 'utf8')).toBe(REPORT);
      expect(existsSync(join(project, '..', 'evil.md'))).toBe(false);
      expect(readdirSync(project).sort()).toEqual(['.claude']);
      expect(readdirSync(join(project, '.claude')).sort()).toEqual(['reviews']);
    },
  );

  // O mesmo nome que o hook de parada daria: o relatório do foreground e o do background caem no mesmo arquivo.
  it.each(['../../evil', '.oculto', 'a b/c'])('AI-15 o agent_id %j vira o mesmo nome de arquivo que o hook de parada usa', (agentId) => {
    const viaPostTool = makeTempDir('ai15-');
    const viaStop = makeTempDir('ai15-');
    handback(viaPostTool, 'reviewer', agentId, REPORT);
    runScript(
      stopFile,
      viaStop,
      JSON.stringify({ agent_type: 'reviewer', agent_id: agentId, session_id: 's1', last_assistant_message: REPORT }),
    );

    expect(savedReviews(viaPostTool)).toHaveLength(1);
    expect(savedReviews(viaPostTool)).toEqual(savedReviews(viaStop));
  });
});

describe('AI-16 o PostToolUse da Skill grava o SHA do HEAD quando abre o security-review', () => {
  it('AI-16 abrir o security-review grava .claude/state/security-review/<SHA completo do HEAD> e o hook sai com 0', () => {
    const project = makeTempDir('ai16-');
    initRepo(project);
    const head = headOf(project);

    const result = skill(project, 'security-review');

    expect(result.code).toBe(0);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(project, '.claude', 'state', 'security-review', head))).toBe(true);
    expect(securityRecords(project)).toEqual([head]);
  });

  it('AI-16 depois de um commit novo, a nova abertura registra o novo HEAD e o registro do anterior continua', () => {
    const project = makeTempDir('ai16-');
    initRepo(project);
    const first = headOf(project);
    skill(project, 'security-review');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'outro');
    const second = headOf(project);

    skill(project, 'security-review');

    expect(second).not.toBe(first);
    expect([...securityRecords(project)].sort()).toEqual([first, second].sort());
  });

  // Controle negativo: o registro é do commit em que a revisão abriu, e não de qualquer commit.
  it('AI-16 controle: sem abrir o security-review, o commit novo não ganha registro', () => {
    const project = makeTempDir('ai16-');
    initRepo(project);
    const first = headOf(project);
    skill(project, 'security-review');
    git(project, 'commit', '-q', '--allow-empty', '-m', 'outro');

    expect(securityRecords(project)).toEqual([first]);
    expect(existsSync(join(project, '.claude', 'state', 'security-review', headOf(project)))).toBe(false);
  });

  it.each(['hello', 'review', 'security-review-extra', 'Security-Review', '', 42])(
    'AI-16 controle: a skill %j não grava registro',
    (name) => {
      const project = makeTempDir('ai16-');
      initRepo(project);

      const result = skill(project, name);

      expect(result.code).toBe(0);
      expect(securityRecords(project)).toEqual([]);
    },
  );

  it('AI-16 controle: outra ferramenta com tool_input.skill igual não grava registro', () => {
    const project = makeTempDir('ai16-');
    initRepo(project);

    const result = skill(project, 'security-review', 'Bash');

    expect(result.code).toBe(0);
    expect(securityRecords(project)).toEqual([]);
  });

  it('AI-16 fora de um repositório git não grava nada e a ferramenta não falha (código 0)', () => {
    const project = makeTempDir('ai16-');
    mkdirSync(join(project, 'src'));

    const result = skill(project, 'security-review');

    expect(result.code).toBe(0);
    expect(existsSync(join(project, '.claude', 'state', 'security-review'))).toBe(false);
  });

  it('AI-16 num repositório sem nenhum commit não grava nada e sai com 0', () => {
    const project = makeTempDir('ai16-');
    git(project, 'init', '-q');

    const result = skill(project, 'security-review');

    expect(result.code).toBe(0);
    expect(securityRecords(project)).toEqual([]);
  });
});

describe('AI-15 AI-16 o PostToolUse com entrada ilegível recusa, como os outros hooks', () => {
  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"tool_name": "SubagentHandback", "tool_input": {'],
  ])('AI-15 entrada ilegível sai com código 2, motivo no stderr e nada gravado (%s)', (_label, raw) => {
    const project = makeTempDir('ai15-');
    initRepo(project);

    const result = runScript(hookFile, project, raw);

    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
    expect(savedReviews(project)).toEqual([]);
    expect(securityRecords(project)).toEqual([]);
  });

  it('AI-15 controle: JSON legível de uma ferramenta sem relação sai com 0 e não grava nada', () => {
    const project = makeTempDir('ai15-');
    initRepo(project);

    const result = runPostTool(project, { tool_name: 'Read', tool_input: { file_path: 'x' } });

    expect(result.code).toBe(0);
    expect(existsSync(join(project, '.claude'))).toBe(false);
  });
});
