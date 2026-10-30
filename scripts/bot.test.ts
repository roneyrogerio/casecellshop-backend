import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planCommand } from './bot.ts';

type Plan = { cmd: 'git' | 'gh'; args: string[] } | { error: string };

const ctx = { branch: 'feat/exemplo' };

function expectCommand(plan: Plan): { cmd: 'git' | 'gh'; args: string[] } {
  if ('error' in plan) throw new Error(`esperava um comando, veio o erro: ${plan.error}`);
  return plan;
}

function expectError(plan: Plan): void {
  expect('error' in plan, `esperava erro, veio ${JSON.stringify(plan)}`).toBe(true);
  if ('error' in plan) expect(plan.error).not.toBe('');
}

// Sequência contígua de tokens dentro dos args.
function containsRun(args: string[], run: string[]): boolean {
  return args.some((_, index) => run.every((token, offset) => args[index + offset] === token));
}

describe('AI-08 push', () => {
  it('AI-08 o push vai da HEAD para a branch atual, com git', () => {
    const plan = expectCommand(planCommand(['push'], ctx));

    expect(plan.cmd).toBe('git');
    expect(plan.args.slice(-4)).toEqual(['push', '-u', 'origin', 'HEAD:refs/heads/feat/exemplo']);
  });

  it('AI-08 o push não usa opção de força', () => {
    const plan = expectCommand(planCommand(['push'], ctx));

    expect(plan.args.some((arg) => /^(--force|-f$|--force-with-lease|--delete|\+)/.test(arg))).toBe(false);
  });

  it.each(['main', 'master', ''])('AI-08 o push recusa a branch "%s"', (branch) => {
    expectError(planCommand(['push'], { branch }));
  });

  it.each([
    ['--force'],
    ['-f'],
    ['--force-with-lease'],
    ['--delete'],
    ['origin', 'main'],
    ['HEAD:refs/heads/main'],
    ['+HEAD:refs/heads/main'],
  ])('AI-08 o push recusa o argumento extra %j', (...extra) => {
    expectError(planCommand(['push', ...extra], ctx));
  });
});

describe('AI-08 pr-create', () => {
  it('AI-08 o pr-create monta o PR em rascunho contra a main, com título e body-file', () => {
    const plan = expectCommand(planCommand(['pr-create', '--title', 'feat(x): algo', '--body-file', '/tmp/corpo.md'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(containsRun(plan.args, ['pr', 'create'])).toBe(true);
    expect(plan.args).toContain('--draft');
    expect(containsRun(plan.args, ['--base', 'main'])).toBe(true);
    expect(containsRun(plan.args, ['--title', 'feat(x): algo'])).toBe(true);
    expect(containsRun(plan.args, ['--body-file', '/tmp/corpo.md'])).toBe(true);
  });

  it.each([
    ['sem --title', ['pr-create', '--body-file', 'f.md']],
    ['sem --body-file', ['pr-create', '--title', 't']],
    ['com --body', ['pr-create', '--title', 't', '--body', 'texto']],
    ['com --body além do --body-file', ['pr-create', '--title', 't', '--body-file', 'f.md', '--body', 'texto']],
    ['sem nada', ['pr-create']],
  ])('AI-08 o pr-create recusa %s', (_label, argv) => {
    expectError(planCommand(argv, ctx));
  });
});

describe('AI-08 pr-edit, pr-comment, pr-ready e pr-draft', () => {
  it('AI-08 o pr-edit usa gh pr edit --body-file', () => {
    const plan = expectCommand(planCommand(['pr-edit', '--body-file', 'f.md'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(plan.args).toEqual(['pr', 'edit', '--body-file', 'f.md']);
  });

  it('AI-08 o pr-comment usa gh pr comment --body-file', () => {
    const plan = expectCommand(planCommand(['pr-comment', '--body-file', 'f.md'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(plan.args).toEqual(['pr', 'comment', '--body-file', 'f.md']);
  });

  it.each(['pr-edit', 'pr-comment'])('AI-08 o %s recusa --body no lugar de --body-file', (verb) => {
    expectError(planCommand([verb, '--body', 'texto'], ctx));
  });

  it.each(['pr-edit', 'pr-comment'])('AI-08 o %s recusa a chamada sem --body-file', (verb) => {
    expectError(planCommand([verb], ctx));
  });

  it('AI-08 o pr-ready usa gh pr ready', () => {
    expect(expectCommand(planCommand(['pr-ready'], ctx))).toEqual({ cmd: 'gh', args: ['pr', 'ready'] });
  });

  it('AI-08 o pr-draft usa gh pr ready --undo', () => {
    expect(expectCommand(planCommand(['pr-draft'], ctx))).toEqual({ cmd: 'gh', args: ['pr', 'ready', '--undo'] });
  });
});

describe('AI-08 leituras', () => {
  it('AI-08 o pr-view usa gh pr view com --json', () => {
    const plan = expectCommand(planCommand(['pr-view'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(containsRun(plan.args, ['pr', 'view'])).toBe(true);
    expect(plan.args).toContain('--json');
  });

  it('AI-08 o checks usa gh pr checks', () => {
    const plan = expectCommand(planCommand(['checks'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(containsRun(plan.args, ['pr', 'checks'])).toBe(true);
  });

  it('AI-08 o run-log usa gh run view ID --log-failed', () => {
    const plan = expectCommand(planCommand(['run-log', '123456'], ctx));

    expect(plan.cmd).toBe('gh');
    expect(plan.args).toEqual(['run', 'view', '123456', '--log-failed']);
  });

  it.each(['abc', '12a', '-1', '1 2', '', '123;rm', '--web'])('AI-08 o run-log recusa o ID "%s"', (id) => {
    expectError(planCommand(['run-log', id], ctx));
  });

  it('AI-08 o run-log recusa a chamada sem ID', () => {
    expectError(planCommand(['run-log'], ctx));
  });
});

describe('AI-08 verbos fora da lista', () => {
  it.each(['merge', 'pr-merge', 'api', 'repo', 'pr-review', 'pr-close', 'issue-create', 'release', 'secret'])(
    'AI-08 recusa o verbo %s',
    (verb) => {
      expectError(planCommand([verb], ctx));
    },
  );

  it('AI-08 recusa a chamada vazia', () => {
    expectError(planCommand([], ctx));
  });

  it('AI-08 recusa um verbo vazio', () => {
    expectError(planCommand([''], ctx));
  });
});

describe('AI-08 o token nunca entra nos argumentos', () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.BOT_TOKEN;
    process.env.BOT_TOKEN = 'ghp_teste';
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.BOT_TOKEN;
    else process.env.BOT_TOKEN = previous;
  });

  it.each([
    ['push'],
    ['pr-create', '--title', 't', '--body-file', 'f.md'],
    ['pr-edit', '--body-file', 'f.md'],
    ['pr-comment', '--body-file', 'f.md'],
    ['pr-ready'],
    ['pr-draft'],
    ['pr-view'],
    ['checks'],
    ['run-log', '42'],
  ])('AI-08 %j não leva o token nos args', (...argv) => {
    const plan = planCommand(argv, ctx);

    expect('error' in plan).toBe(false);
    if (!('error' in plan)) expect(plan.args.some((arg) => arg.includes('ghp_teste'))).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('ghp_teste');
  });

  it('AI-08 o erro de um verbo recusado também não vaza o token', () => {
    expect(JSON.stringify(planCommand(['merge'], ctx))).not.toContain('ghp_teste');
  });
});
