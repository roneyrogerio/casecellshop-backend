import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  initRepo,
  makeTempDir,
} from '../helpers/git-sandbox.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// O hook fica em .githooks/ (AI-08) e não tem arquivo de origem ao lado: o teste mora em test/repo/,
// onde ficam os testes de configuração do repositório.
const hook = join(root, '.githooks', 'pre-push');

afterEach(cleanupTempDirs);

// Depois de aceitar a URL, o hook roda `npm run verify` (AI-17). Dentro do Vitest isso rodaria a verificação de
// verdade, então todo teste que chama o hook põe um `npm` falso no começo do PATH: ele grava os argumentos e o
// diretório em que rodou e sai com o código escolhido. O `npm` real nunca roda.
interface FakeNpm {
  bin: string;
  calls(): { args: string; cwd: string }[];
  // Nomes das variáveis GIT_* que o `npm` falso recebeu na última chamada (AI-17).
  gitVariables(): string[];
}

function makeFakeNpm(exitCode: number): FakeNpm {
  const dir = makeTempDir('prepush-npm-');
  const bin = join(dir, 'bin');
  const log = join(dir, 'npm.log');
  const envLog = join(dir, 'npm-git-env.log');
  mkdirSync(bin);
  const fake = join(bin, 'npm');
  writeFileSync(
    fake,
    `#!/bin/sh\n{ echo "$*"; pwd; } >> '${log}'\nenv | grep '^GIT_' | cut -d= -f1 | sort > '${envLog}'\nexit ${exitCode}\n`,
  );
  chmodSync(fake, 0o755);
  return {
    bin,
    gitVariables: () =>
      existsSync(envLog)
        ? readFileSync(envLog, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : [],
    calls: () => {
      if (!existsSync(log)) return [];
      const lines = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '');
      const calls: { args: string; cwd: string }[] = [];
      for (let index = 0; index + 1 < lines.length; index += 2) {
        calls.push({
          args: lines[index] ?? '',
          cwd: realpathSync(lines[index + 1] ?? ''),
        });
      }
      return calls;
    },
  };
}

function isolatedEnv(npm: FakeNpm): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${npm.bin}:${process.env.PATH ?? ''}` };
}

const REFS =
  'refs/heads/x 1111111111111111111111111111111111111111 refs/heads/x 0000000000000000000000000000000000000000\n';

// Como o git chama: $1 é o nome do remoto, $2 a URL já reescrita pelo insteadOf, e as refs entram pela entrada padrão.
// O hook roda dentro de um repositório de teste (a raiz dele é o que o `npm run verify` deve receber como cwd).
function runHook(
  url: string,
  options: { npmExit?: number; subdir?: string; gitHookEnv?: boolean } = {},
) {
  const project = makeTempDir('prepush-run-');
  initRepo(project);
  const npm = makeFakeNpm(options.npmExit ?? 0);
  const cwd =
    options.subdir === undefined ? project : join(project, options.subdir);
  mkdirSync(cwd, { recursive: true });
  const env = {
    ...isolatedEnv(npm),
    ...(options.gitHookEnv === true ? gitHookEnv(project) : {}),
  };
  const result = runCommand(hook, ['origin', url], {
    input: REFS,
    cwd,
    env,
  });
  return {
    code: result.status,
    stderr: result.stderr,
    error: result.error,
    npm,
    project,
    env,
  };
}

// O que o git exporta para um hook: o repositório e a árvore de trabalho de quem fez o push (numa worktree, também o
// diretório comum e o índice dela).
function gitHookEnv(project: string): Record<string, string> {
  return {
    GIT_DIR: join(project, '.git'),
    GIT_WORK_TREE: project,
    GIT_INDEX_FILE: join(project, '.git', 'index'),
    GIT_COMMON_DIR: join(project, '.git'),
    GIT_PREFIX: '',
  };
}

describe('AI-08 o .githooks/pre-push é versionado e executável', () => {
  it('AI-08 o arquivo existe e tem o bit de execução', () => {
    expect(existsSync(hook)).toBe(true);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('AI-08 o git ls-files -s registra o modo 100755', () => {
    const result = runCommand(
      'git',
      ['ls-files', '-s', '--', '.githooks/pre-push'],
      { cwd: root },
    );

    expect(result.stdout.startsWith('100755 ')).toBe(true);
  }, 60_000);

  it('AI-08 é um script sh', () => {
    const result = runCommand('head', ['-n', '1', hook]);

    expect(result.stdout).toMatch(/^#!\/bin\/sh|^#!\/usr\/bin\/env sh/);
  }, 60_000);
});

describe('AI-08 o pre-push só deixa passar a URL que começa por https://github.com/', () => {
  it.each([
    'git@github.com:a/b.git',
    'ssh://git@github.com/a/b.git',
    '/tmp/x.git',
    'https://gitlab.com/a/b.git',
    'http://github.com/a/b.git',
    'https://github.com.evil.com/a/b.git',
    'https://github.com:evil@evil.com/a/b.git',
    'HTTPS://github.com/a/b.git',
    ' https://github.com/a/b.git',
    '',
  ])(
    'AI-08 recusa a URL "%s" com código diferente de 0 e o motivo no stderr',
    (url) => {
      const result = runHook(url);

      expect(result.error).toBeUndefined();
      expect(result.code).not.toBe(0);
      expect(result.stderr).not.toBe('');
    },
    60_000,
  );

  // Controle negativo: a URL HTTPS do GitHub passa.
  it.each([
    'https://github.com/roneyrogerio/casecellshop-backend.git',
    'https://github.com/a/b',
  ])(
    'AI-08 deixa passar a URL "%s" com código 0',
    (url) => {
      const result = runHook(url);

      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
    },
    60_000,
  );

  it('AI-08 sem argumentos recusa', () => {
    const result = runCommand(hook, [], {
      input: '',
      env: isolatedEnv(makeFakeNpm(0)),
    });

    expect(result.status).not.toBe(0);
  }, 60_000);
});

describe('AI-08 o pre-push recusa o push de verdade, depois de o insteadOf reescrever a URL', () => {
  function setup() {
    const project = makeTempDir('prepush-proj-');
    initRepo(project);
    const bare = makeTempDir('prepush-bare-');
    git(bare, 'init', '-q', '--bare');
    git(project, 'remote', 'add', 'origin', 'https://github.com/a/b.git');
    return { project, bare };
  }

  function push(project: string, bare: string, hooksPath: string | null) {
    const args = ['-c', `url.${bare}.insteadOf=https://github.com/a/b.git`];
    if (hooksPath !== null) args.push('-c', `core.hooksPath=${hooksPath}`);
    args.push('push', 'origin', 'HEAD:refs/heads/feature');
    return runCommand('git', args, {
      cwd: project,
      env: isolatedEnv(makeFakeNpm(0)),
    });
  }

  function branchesIn(bare: string): string {
    return git(bare, 'for-each-ref', '--format=%(refname)');
  }

  it('AI-08 com o hook, o push cuja URL reescrita é um caminho local é recusado e o bare continua sem a branch', () => {
    const { project, bare } = setup();

    const result = push(project, bare, join(root, '.githooks'));

    expect(result.status).not.toBe(0);
    expect(branchesIn(bare)).toBe('');
  }, 60_000);

  // Controle negativo: sem o hook, o mesmo push chega ao bare. Prova que é o hook que recusa.
  it('AI-08 controle: sem o hook, o mesmo push chega ao bare', () => {
    const { project, bare } = setup();

    const result = push(project, bare, null);

    expect(result.status, result.stderr).toBe(0);
    expect(branchesIn(bare)).toContain('refs/heads/feature');
  }, 60_000);
});

describe('AI-17 o pre-push roda o npm run verify na raiz do repositório, depois de aceitar a URL', () => {
  const ACCEPTED = 'https://github.com/roneyrogerio/casecellshop-backend.git';

  it('AI-17 com a URL aceita e o verify passando, sai com 0 e chama exatamente "npm run verify" uma vez, na raiz', () => {
    const result = runHook(ACCEPTED);

    expect(result.code).toBe(0);
    expect(result.npm.calls()).toEqual([
      { args: 'run verify', cwd: result.project },
    ]);
  }, 60_000);

  it('AI-17 chamado de uma subpasta, roda o verify na raiz do repositório, e não na subpasta', () => {
    const result = runHook(ACCEPTED, { subdir: 'src/checkout' });

    expect(result.code).toBe(0);
    expect(result.npm.calls()).toEqual([
      { args: 'run verify', cwd: result.project },
    ]);
  }, 60_000);

  it('AI-17 com o verify falhando, o push é recusado (código diferente de 0)', () => {
    const result = runHook(ACCEPTED, { npmExit: 1 });

    expect(result.error).toBeUndefined();
    expect(result.code).not.toBe(0);
    expect(result.npm.calls()).toEqual([
      { args: 'run verify', cwd: result.project },
    ]);
  }, 60_000);

  it('AI-17 o código do verify que falhou com outro valor também recusa o push', () => {
    const result = runHook(ACCEPTED, { npmExit: 7 });

    expect(result.code).not.toBe(0);
    expect(result.npm.calls()).toHaveLength(1);
  }, 60_000);

  // Controle negativo: o verify só roda depois da URL; a URL recusada nunca chega ao npm.
  it.each([
    'git@github.com:a/b.git',
    'ssh://git@github.com/a/b.git',
    '/tmp/x.git',
    'https://github.com.evil.com/a/b.git',
    '',
  ])(
    'AI-17 com a URL "%s" recusada, o npm nunca é chamado',
    (url) => {
      const result = runHook(url);

      expect(result.code).not.toBe(0);
      expect(result.npm.calls()).toEqual([]);
    },
    60_000,
  );

  it('AI-17 a URL recusada com o verify que passaria continua recusada (o verify não a salva)', () => {
    const result = runHook('git@github.com:a/b.git', { npmExit: 0 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
  }, 60_000);
});

// O git exporta GIT_DIR e companhia para o hook. Se o `npm run verify` as herdar, os testes unitários que montam um
// repositório temporário passam a operar no repositório de verdade (config, branches, HEAD), então o hook as tira
// antes de chamar o npm.
describe('AI-17 o pre-push roda o npm run verify sem nenhuma variável GIT_* no ambiente', () => {
  const ACCEPTED = 'https://github.com/roneyrogerio/casecellshop-backend.git';
  const EXPORTED = [
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_WORK_TREE',
  ];

  // Controle positivo: o mesmo ambiente, entregue a um processo qualquer pelo mesmo caminho, traz as variáveis. Sem
  // isto, "nenhuma variável chegou ao npm" valeria também para um teste que nunca as exportou.
  it('AI-17 controle: o ambiente em que o hook roda traz as variáveis GIT_* exportadas', () => {
    const project = makeTempDir('prepush-control-');
    const env = { ...process.env, ...gitHookEnv(project) };

    const result = runCommand(
      'sh',
      ['-c', "env | grep '^GIT_' | cut -d= -f1 | sort"],
      { env },
    );

    expect(result.stdout.split('\n')).toEqual(expect.arrayContaining(EXPORTED));
  }, 60_000);

  it('AI-17 com GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR e GIT_PREFIX exportados, o npm run verify não recebe nenhuma variável GIT_*', () => {
    const result = runHook(ACCEPTED, { gitHookEnv: true });

    expect(Object.keys(result.env)).toEqual(expect.arrayContaining(EXPORTED));
    expect(result.code).toBe(0);
    expect(result.npm.calls()).toEqual([
      { args: 'run verify', cwd: result.project },
    ]);
    expect(result.npm.gitVariables()).toEqual([]);
  }, 60_000);

  it('AI-17 mesmo as variáveis GIT_* que não são de caminho (GIT_AUTHOR_NAME, GIT_SSH_COMMAND) não chegam ao npm run verify', () => {
    const project = makeTempDir('prepush-extra-');
    initRepo(project);
    const npm = makeFakeNpm(0);

    const result = runCommand(hook, ['origin', ACCEPTED], {
      input: REFS,
      cwd: project,
      env: {
        ...isolatedEnv(npm),
        GIT_AUTHOR_NAME: 'alguem',
        GIT_SSH_COMMAND: 'ssh -i /nao/existe',
      },
    });

    expect(result.status).toBe(0);
    expect(npm.calls()).toHaveLength(1);
    expect(npm.gitVariables()).toEqual([]);
  }, 60_000);
});
