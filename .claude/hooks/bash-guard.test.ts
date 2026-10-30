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

// As formas de escrever o git que a regex antiga não reconhecia (A12): o shell as executa do mesmo jeito.
const SUBAGENT_DENIED_FORMS = [
  '(git push)',
  '{ git push; }',
  'true & git push',
  'env git push',
  'command git push',
  'exec git push',
  'nohup git push',
  'time git push',
  'xargs git push',
  '"git" push',
  "'git' push",
  'g\\it push',
  'git --git-dir .git push',
  'git -c alias.p=push p',
  'git config alias.p push',
  'git pull',
  'git cherry-pick x',
  'git revert x',
  'git am x',
  'git worktree add ../x',
  'git config core.hooksPath x',
  'git remote add x y',
  'git fetch',
  'git add .',
  'git init',
  '/usr/bin/git commit -m x',
];

const SUBAGENT_ALLOWED_FORMS = [
  'git status',
  'git diff',
  'git log --oneline -5',
  'git show HEAD',
  'git ls-files',
  'git ls-tree HEAD',
  'git rev-parse HEAD',
  'git rev-list -n1 HEAD',
  'git merge-base HEAD main',
  'git blame src/x.ts',
  'git grep foo',
  'git cat-file -p HEAD',
  'git describe --always',
  'git shortlog -s',
  'git --version',
  'git -C . status',
  'git --no-pager log',
  'npm test',
  'ls',
  'echo commit push reset',
  'cat src/git-push-notes.ts',
  'sh -c "git status"',
  'git log --grep push --oneline',
  'env FOO=1 npm test',
];

describe('AI-11 os subagentes não escapam da guarda pela grafia do git (A12)', () => {
  beforeAll(loadCheck);

  it.each(SUBAGENT_DENIED_FORMS)('AI-11 nega "%s" aos três subagentes', (command) => {
    for (const agentType of SUBAGENTS) {
      const verdict = check(bash(agentType, command));
      expect(verdict.allow, `${agentType}: ${command}`).toBe(false);
      expect(verdict.reason, `${agentType}: ${command}`).toBeTruthy();
    }
  });

  // Controle negativo: o que só lê o estado do git, e o que nem é git, segue liberado.
  it.each(SUBAGENT_ALLOWED_FORMS)('AI-11 libera "%s" aos três subagentes', (command) => {
    for (const agentType of SUBAGENTS) {
      expect(check(bash(agentType, command)).allow, `${agentType}: ${command}`).toBe(true);
    }
  });

  // Controle negativo: a negação é só dos subagentes; a sessão principal usa as mesmas formas, que não são push perigoso.
  it.each(SUBAGENT_DENIED_FORMS.filter((command) => !command.includes('--git-dir') && !command.includes('alias.p=push p')))(
    'AI-11 a sessão principal passa com "%s"',
    (command) => {
      expect(check(bash(undefined, command)).allow, command).toBe(true);
    },
  );

  it.each(['git pull', 'git fetch', 'git add .', 'git worktree add ../x', 'git config core.hooksPath x'])(
    'AI-11 nega "%s" ao subagente em qualquer posição',
    (command) => {
      for (const [label, positioned] of positions(command)) {
        expect(check(bash('implementer', positioned)).allow, `${label}: ${positioned}`).toBe(false);
      }
    },
  );
});

const MAIN_PUSH_ALLOWED = [
  'git push',
  'git push origin',
  'git push origin HEAD',
  'git push -u origin HEAD',
  'git push --set-upstream origin HEAD',
  'git push -u origin chore/ai-factory-v2',
  'git push origin feat/x',
];

const MAIN_PUSH_DENIED = [
  'git push origin --delete chore/x',
  'git push -d origin chore/x',
  'git push origin -d chore/x',
  'git push origin :chore/x',
  'git push origin HEAD -f',
  'git push -uf origin HEAD',
  'git push --force-with-lease',
  'git push --forc origin HEAD',
  'git push --delet origin x',
  'git push --mirro',
  'git push --prune origin',
  'git push --mirror',
  'git push --all',
  'git push --tags',
  'git push --no-verify origin HEAD',
  'git push origin +HEAD',
  'git push origin HEAD:main',
  'git push origin main',
  'git -c core.hooksPath=/dev/null push',
  'git -C . push origin HEAD',
  'sh -c "git push --force"',
  'npm test && git push -f',
];

describe('AI-11 o git push da sessão principal só passa na forma estreita (A2)', () => {
  beforeAll(loadCheck);

  it.each(MAIN_PUSH_ALLOWED)('AI-11 a sessão principal pode "%s"', (command) => {
    expect(check(bash(undefined, command)).allow, command).toBe(true);
  });

  it.each(MAIN_PUSH_ALLOWED)('AI-11 a sessão principal pode "%s" depois de ; e de &&', (command) => {
    expect(check(bash(undefined, `npm test && ${command}`)).allow, command).toBe(true);
    expect(check(bash(undefined, `echo a; ${command}`)).allow, command).toBe(true);
  });

  it.each(MAIN_PUSH_DENIED)('AI-11 a sessão principal não pode "%s"', (command) => {
    const verdict = check(bash(undefined, command));

    expect(verdict.allow, command).toBe(false);
    expect(verdict.reason, command).toBeTruthy();
  });

  it.each(MAIN_PUSH_DENIED)('AI-11 o implementer também não pode "%s"', (command) => {
    expect(check(bash('implementer', command)).allow, command).toBe(false);
  });

  // O mesmo push perigoso, escrito de outros jeitos: a regra não depende da grafia.
  it.each([
    'env git push -f',
    'command git push --force',
    '"git" push --force',
    "'git' push --delete origin x",
    'g\\it push -f',
    '(git push -f)',
    'true & git push -f',
    '{ git push --mirror; }',
    '/usr/bin/git push origin +HEAD',
    'xargs git push --all',
  ])('AI-11 a sessão principal não pode o push perigoso escrito como "%s"', (command) => {
    expect(check(bash(undefined, command)).allow, command).toBe(false);
  });

  it.each(['git push origin HEAD -f', 'git push origin --delete x', 'git push origin main'])(
    'AI-11 a sessão principal não pode "%s" em nenhuma posição',
    (command) => {
      for (const [label, positioned] of positions(command)) {
        expect(check(bash(undefined, positioned)).allow, `${label}: ${positioned}`).toBe(false);
      }
    },
  );

  // Controle negativo: negar o push perigoso não pode tirar da sessão principal o resto.
  it.each([
    'git commit -m "feat: x"',
    'git reset --hard',
    'git status',
    'sh -c "git checkout main"',
    'git pull',
    'git fetch',
    'git config core.hooksPath .githooks',
    'git checkout main',
    'git branch -D x',
  ])('AI-11 a sessão principal segue livre para "%s"', (command) => {
    expect(check(bash(undefined, command)).allow, command).toBe(true);
  });
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

  it.each(['(git push)', 'env git push', '"git" push', 'git -c alias.p=push p', 'git --git-dir .git push'])(
    'AI-11 o implementer com %s é recusado',
    (command) => {
      expect(isDenied(run(payload('implementer', command)))).toBe(true);
    },
  );

  it.each(['git push origin --delete chore/x', 'git push -d origin chore/x', 'git push origin HEAD -f', 'git push --mirro'])(
    'AI-11 a sessão principal com %s é recusada com código 2 e o motivo no stderr',
    (command) => {
      const result = run(payload(undefined, command));

      expect(result.code).toBe(2);
      expect(result.stderr).not.toBe('');
    },
  );

  it.each(['git push', 'git push -u origin HEAD', 'git push origin chore/ai-factory-v2'])(
    'AI-11 controle: a sessão principal com %s passa, sem saída',
    (command) => {
      const result = run(payload(undefined, command));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe('');
    },
  );

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
