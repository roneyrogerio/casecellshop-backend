import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function gitVariables(): string[] {
  return Object.keys(process.env)
    .filter((name) => name.startsWith('GIT_'))
    .sort();
}

describe('AI-17 o setup dos testes tira do ambiente toda variável GIT_', () => {
  it('AI-17 depois do setup, nenhuma variável GIT_ resta em process.env, e as outras continuam', async () => {
    vi.stubEnv('GIT_DIR', '/nao/existe/.git');
    vi.stubEnv('GIT_WORK_TREE', '/nao/existe');
    vi.stubEnv('GIT_INDEX_FILE', '/nao/existe/.git/index');
    vi.stubEnv('GIT_COMMON_DIR', '/nao/existe/.git');
    vi.stubEnv('GIT_PREFIX', '');
    vi.stubEnv('GIT_AUTHOR_NAME', 'alguem');
    vi.stubEnv('GITHUB_FAKE_VARIABLE', 'fica');
    vi.stubEnv('NOT_GIT_FAKE_VARIABLE', 'fica');
    // Controle: as variáveis estavam mesmo no ambiente antes do setup.
    expect(gitVariables()).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME',
        'GIT_COMMON_DIR',
        'GIT_DIR',
        'GIT_INDEX_FILE',
        'GIT_PREFIX',
        'GIT_WORK_TREE',
      ]),
    );

    vi.resetModules();
    await import('./git-env-setup.ts');

    expect(gitVariables()).toEqual([]);
    expect(process.env.GITHUB_FAKE_VARIABLE).toBe('fica');
    expect(process.env.NOT_GIT_FAKE_VARIABLE).toBe('fica');
  });
});
