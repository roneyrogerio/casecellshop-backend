import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface GuardInput {
  agent_type?: string;
  tool_input: { command: string };
}

interface Verdict {
  allow: boolean;
  reason?: string;
}

let check: (input: GuardInput) => Verdict;

// Import dinâmico: o hook é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
// Cada grupo que usa `check` o carrega, para a falta do módulo não esconder os testes de processo.
async function loadCheck(): Promise<void> {
  const hookPath = join(import.meta.dirname, 'bash-guard.mjs');
  const module = (await import(pathToFileURL(hookPath).href)) as { check: typeof check };
  check = module.check;
}

const SUBAGENTS = ['implementer', 'test-writer', 'reviewer'];

const FORBIDDEN_VERBS = [
  'commit',
  'push',
  'reset',
  'checkout',
  'switch',
  'restore',
  'rebase',
  'merge',
  'stash',
  'tag',
  'branch',
  'clean',
  'filter-branch',
  'update-ref',
];

function bash(agentType: string | undefined, command: string): GuardInput {
  return { ...(agentType ? { agent_type: agentType } : {}), tool_input: { command } };
}

// O mesmo comando de git, em cada posição em que um shell o executaria.
function positions(gitCommand: string): [string, string][] {
  return [
    ['no início', gitCommand],
    ['depois de ;', `echo a; ${gitCommand}`],
    ['depois de &&', `npm test && ${gitCommand}`],
    ['depois de ||', `false || ${gitCommand}`],
    ['depois de |', `echo a | ${gitCommand}`],
    ['dentro de sh -c com aspas duplas', `sh -c "${gitCommand}"`],
    ['dentro de bash -c com aspas simples', `bash -c '${gitCommand}'`],
    ['dentro de sh -c depois de &&', `sh -c "ls && ${gitCommand}"`],
    ['depois de uma quebra de linha', `ls\n${gitCommand}`],
  ];
}

describe('AI-11 o bash-guard nega aos subagentes os comandos que mudam o estado do git', () => {
  beforeAll(loadCheck);

  it.each(FORBIDDEN_VERBS)('AI-11 nega git %s em qualquer posição, para os três subagentes', (verb) => {
    for (const agentType of SUBAGENTS) {
      for (const [label, command] of positions(`git ${verb} -x arg`)) {
        const verdict = check(bash(agentType, command));
        expect(verdict.allow, `${agentType} ${label}: ${command}`).toBe(false);
        expect(verdict.reason, `${agentType} ${label}`).toBeTruthy();
      }
    }
  });

  it.each(FORBIDDEN_VERBS)('AI-11 nega git -C <dir> %s, mesmo com mais espaços', (verb) => {
    for (const command of [`git -C ../outro ${verb}`, `git -C /tmp/x   ${verb} --all`, `git   ${verb}`, `echo a; git -C . ${verb}`]) {
      expect(check(bash('implementer', command)).allow, command).toBe(false);
    }
  });

  it.each([
    'git commit -m "feat: x"',
    'git commit --amend --no-edit',
    'git push origin HEAD',
    'git reset --hard HEAD~1',
    'git checkout -- src/app.ts',
    'git restore .',
    'git stash pop',
    'git branch -D main',
    'git tag -d v1',
  ])('AI-11 nega o comando completo "%s"', (command) => {
    for (const agentType of SUBAGENTS) expect(check(bash(agentType, command)).allow).toBe(false);
  });

  // Controle negativo: o que só lê o estado, e os outros comandos, passam.
  it.each([
    'git status',
    'git status --porcelain',
    'git diff',
    'git diff --stat HEAD~1',
    'git log',
    'git log --oneline -5',
    'git show HEAD',
    'git -C . status',
    'npm test',
    'npm run lint',
    'ls',
    'ls -la src',
    'git status && npm test',
    'git diff | head -20',
    'git log --grep=commit',
    'git log --grep push --oneline',
    'echo commit push reset',
    'ls commit.txt',
    'sh -c "git status"',
    'cat src/git-push-notes.ts',
  ])('AI-11 libera "%s" para os subagentes', (command) => {
    for (const agentType of SUBAGENTS) {
      const verdict = check(bash(agentType, command));
      expect(verdict.allow, `${agentType}: ${command}`).toBe(true);
    }
  });

  it('AI-11 libera comando vazio', () => {
    expect(check(bash('implementer', '')).allow).toBe(true);
  });
});

describe('AI-11 a sessão principal passa', () => {
  beforeAll(loadCheck);

  it.each(['git commit -m "feat: x"', 'git push origin HEAD', 'git reset --hard', 'sh -c "git checkout main"', 'git status'])(
    'AI-11 sem agent_type libera "%s"',
    (command) => {
      expect(check(bash(undefined, command)).allow).toBe(true);
    },
  );
});

describe('AI-11 o bash-guard como processo', () => {
  const hook = join(import.meta.dirname, 'bash-guard.mjs');

  function run(raw: string) {
    const result = spawnSync(process.execPath, [hook], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(import.meta.dirname, '..', '..') },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function payload(agentType: string | undefined, command: string): string {
    return JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { command },
    });
  }

  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"agent_type": "implementer", "tool_input": {'],
  ])('AI-11 entrada ilegível recusa com código 2 (%s)', (_label, raw) => {
    const result = run(raw);

    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
  });

  // Recusar vale como código 2 com o motivo no stderr, ou como a decisão "deny" no stdout (como o path-guard).
  function isDenied(result: ReturnType<typeof run>): boolean {
    if (result.code === 2) return result.stderr !== '';
    if (result.code !== 0 || result.stdout === '') return false;
    const output = JSON.parse(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    return output.hookSpecificOutput?.permissionDecision === 'deny';
  }

  it('AI-11 o implementer com git commit é recusado', () => {
    expect(isDenied(run(payload('implementer', 'git commit -m x')))).toBe(true);
  });

  it('AI-11 o reviewer com sh -c "git push" é recusado', () => {
    expect(isDenied(run(payload('reviewer', 'sh -c "git push origin HEAD"')))).toBe(true);
  });

  it('AI-11 controle: o implementer com git status passa, sem saída', () => {
    const result = run(payload('implementer', 'git status'));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('AI-11 controle: a sessão principal com git commit passa, sem saída', () => {
    const result = run(payload(undefined, 'git commit -m x'));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});
