import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, git, initRepo, makeTempDir } from '../test/helpers/git-sandbox.ts';

// O hook fica em .githooks/ (AI-08): `**/*.test.ts` não entra em pastas com ponto, então o teste mora em scripts/.
const root = join(import.meta.dirname, '..');
const hook = join(root, '.githooks', 'pre-push');

afterEach(cleanupTempDirs);

// Depois de aceitar a URL, o hook roda `npm run verify` (AI-17). Dentro do Vitest isso rodaria a verificação de
// verdade, então todo teste que chama o hook põe um `npm` falso no começo do PATH: ele grava os argumentos e o
// diretório em que rodou e sai com o código escolhido. O `npm` real nunca roda.
interface FakeNpm {
  bin: string;
  calls(): { args: string; cwd: string }[];
}

function makeFakeNpm(exitCode: number): FakeNpm {
  const dir = makeTempDir('prepush-npm-');
  const bin = join(dir, 'bin');
  const log = join(dir, 'npm.log');
  mkdirSync(bin);
  const fake = join(bin, 'npm');
  writeFileSync(fake, `#!/bin/sh\n{ echo "$*"; pwd; } >> '${log}'\nexit ${exitCode}\n`);
  chmodSync(fake, 0o755);
  return {
    bin,
    calls: () => {
      if (!existsSync(log)) return [];
      const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
      const calls: { args: string; cwd: string }[] = [];
      for (let index = 0; index + 1 < lines.length; index += 2) {
        calls.push({ args: lines[index] ?? '', cwd: realpathSync(lines[index + 1] ?? '') });
      }
      return calls;
    },
  };
}

function isolatedEnv(npm: FakeNpm): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${npm.bin}:${process.env.PATH ?? ''}` };
}

const REFS = 'refs/heads/x 1111111111111111111111111111111111111111 refs/heads/x 0000000000000000000000000000000000000000\n';

// Como o git chama: $1 é o nome do remoto, $2 a URL já reescrita pelo insteadOf, e as refs entram pela entrada padrão.
// O hook roda dentro de um repositório de teste (a raiz dele é o que o `npm run verify` deve receber como cwd).
function runHook(url: string, options: { npmExit?: number; subdir?: string } = {}) {
  const project = makeTempDir('prepush-run-');
  initRepo(project);
  const npm = makeFakeNpm(options.npmExit ?? 0);
  const cwd = options.subdir === undefined ? project : join(project, options.subdir);
  mkdirSync(cwd, { recursive: true });
  const result = spawnSync(hook, ['origin', url], { input: REFS, encoding: 'utf8', cwd, env: isolatedEnv(npm) });
  return { code: result.status, stderr: result.stderr, error: result.error, npm, project };
}

describe('AI-08 o .githooks/pre-push é versionado e executável', () => {
  it('AI-08 o arquivo existe e tem o bit de execução', () => {
    expect(existsSync(hook)).toBe(true);
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('AI-08 o git ls-files -s registra o modo 100755', () => {
    const result = spawnSync('git', ['ls-files', '-s', '--', '.githooks/pre-push'], { cwd: root, encoding: 'utf8' });

    expect(result.stdout.startsWith('100755 ')).toBe(true);
  });

  it('AI-08 é um script sh', () => {
    const result = spawnSync('head', ['-n', '1', hook], { encoding: 'utf8' });

    expect(result.stdout).toMatch(/^#!\/bin\/sh|^#!\/usr\/bin\/env sh/);
  });
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
  ])('AI-08 recusa a URL "%s" com código diferente de 0 e o motivo no stderr', (url) => {
    const result = runHook(url);

    expect(result.error).toBeUndefined();
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });

  // Controle negativo: a URL HTTPS do GitHub passa.
  it.each(['https://github.com/roneyrogerio/casecellshop-backend.git', 'https://github.com/a/b'])(
    'AI-08 deixa passar a URL "%s" com código 0',
    (url) => {
      const result = runHook(url);

      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
    },
  );

  it('AI-08 sem argumentos recusa', () => {
    const result = spawnSync(hook, [], { input: '', encoding: 'utf8', env: isolatedEnv(makeFakeNpm(0)) });

    expect(result.status).not.toBe(0);
  });
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
    return spawnSync('git', args, { cwd: project, encoding: 'utf8', env: isolatedEnv(makeFakeNpm(0)) });
  }

  function branchesIn(bare: string): string {
    return git(bare, 'for-each-ref', '--format=%(refname)');
  }

  it('AI-08 com o hook, o push cuja URL reescrita é um caminho local é recusado e o bare continua sem a branch', () => {
    const { project, bare } = setup();

    const result = push(project, bare, join(root, '.githooks'));

    expect(result.status).not.toBe(0);
    expect(branchesIn(bare)).toBe('');
  });

  // Controle negativo: sem o hook, o mesmo push chega ao bare. Prova que é o hook que recusa.
  it('AI-08 controle: sem o hook, o mesmo push chega ao bare', () => {
    const { project, bare } = setup();

    const result = push(project, bare, null);

    expect(result.status, result.stderr).toBe(0);
    expect(branchesIn(bare)).toContain('refs/heads/feature');
  });
});

describe('AI-17 o pre-push roda o npm run verify na raiz do repositório, depois de aceitar a URL', () => {
  const ACCEPTED = 'https://github.com/roneyrogerio/casecellshop-backend.git';

  it('AI-17 com a URL aceita e o verify passando, sai com 0 e chama exatamente "npm run verify" uma vez, na raiz', () => {
    const result = runHook(ACCEPTED);

    expect(result.code).toBe(0);
    expect(result.npm.calls()).toEqual([{ args: 'run verify', cwd: result.project }]);
  });

  it('AI-17 chamado de uma subpasta, roda o verify na raiz do repositório, e não na subpasta', () => {
    const result = runHook(ACCEPTED, { subdir: 'src/checkout' });

    expect(result.code).toBe(0);
    expect(result.npm.calls()).toEqual([{ args: 'run verify', cwd: result.project }]);
  });

  it('AI-17 com o verify falhando, o push é recusado (código diferente de 0)', () => {
    const result = runHook(ACCEPTED, { npmExit: 1 });

    expect(result.error).toBeUndefined();
    expect(result.code).not.toBe(0);
    expect(result.npm.calls()).toEqual([{ args: 'run verify', cwd: result.project }]);
  });

  it('AI-17 o código do verify que falhou com outro valor também recusa o push', () => {
    const result = runHook(ACCEPTED, { npmExit: 7 });

    expect(result.code).not.toBe(0);
    expect(result.npm.calls()).toHaveLength(1);
  });

  // Controle negativo: o verify só roda depois da URL; a URL recusada nunca chega ao npm.
  it.each(['git@github.com:a/b.git', 'ssh://git@github.com/a/b.git', '/tmp/x.git', 'https://github.com.evil.com/a/b.git', ''])(
    'AI-17 com a URL "%s" recusada, o npm nunca é chamado',
    (url) => {
      const result = runHook(url);

      expect(result.code).not.toBe(0);
      expect(result.npm.calls()).toEqual([]);
    },
  );

  it('AI-17 a URL recusada com o verify que passaria continua recusada (o verify não a salva)', () => {
    const result = runHook('git@github.com:a/b.git', { npmExit: 0 });

    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toBe('');
  });
});
