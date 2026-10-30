import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs, git, initRepo, makeTempDir } from '../test/helpers/git-sandbox.ts';

// O hook fica em .githooks/ (AI-08): `**/*.test.ts` não entra em pastas com ponto, então o teste mora em scripts/.
const root = join(import.meta.dirname, '..');
const hook = join(root, '.githooks', 'pre-push');

afterEach(cleanupTempDirs);

// Como o git chama: $1 é o nome do remoto, $2 a URL já reescrita pelo insteadOf, e as refs entram pela entrada padrão.
function runHook(url: string) {
  const result = spawnSync(hook, ['origin', url], {
    input: 'refs/heads/x 1111111111111111111111111111111111111111 refs/heads/x 0000000000000000000000000000000000000000\n',
    encoding: 'utf8',
  });
  return { code: result.status, stderr: result.stderr, error: result.error };
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
    const result = spawnSync(hook, [], { input: '', encoding: 'utf8' });

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
    return spawnSync('git', args, { cwd: project, encoding: 'utf8' });
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
