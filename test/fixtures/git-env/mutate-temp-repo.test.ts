import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  makeTempDir,
} from '../../helpers/git-sandbox.ts';

// Amostra de test/repo/git-env-isolation.test.ts: faz o que os testes de repositório fazem (grava configuração, cria
// branch, faz commit num repositório temporário). Sozinha ela passa sempre; o que importa é o que sobra no
// repositório para onde as variáveis GIT_* herdadas apontam, e quem confere isso é o teste que a roda como filha.
afterEach(cleanupTempDirs);

describe('AI-17 amostra: um teste que muda a configuração, as branches e o HEAD de um repositório temporário', () => {
  it('AI-17 amostra: grava config, cria branch e faz commit no repositório temporário', () => {
    const dir = makeTempDir('git-env-sample-');
    git(dir, 'init', '-q');

    git(dir, 'config', '--local', 'casecellshop.identity', 'self');
    git(dir, 'config', '--local', 'alias.p', 'push');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'amostra');
    git(dir, 'branch', 'amostra-branch');

    expect(git(dir, 'config', '--local', 'casecellshop.identity').trim()).toBe(
      'self',
    );
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'amostra-branch').trim()).toBe(
      'amostra-branch',
    );
  });
});
