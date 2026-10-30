import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, git, makeTempDir } from '../../test/helpers/git-sandbox.ts';
import { isolatedEnv, localConfig, makeRepo, setFakeCredential } from '../../test/helpers/identity-sandbox.ts';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };

interface IdentityModule {
  readIdentity: (root: string) => Identity | undefined;
  writeIdentity: (root: string, identity: Identity) => void;
  defaultKeychainService: (login: string) => string;
  readToken: (
    identity: Identity | undefined,
    root: string,
    deps?: { keychain?: (service: string) => string | undefined },
  ) => string | undefined;
}

let mod: IdentityModule;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  mod = (await import(pathToFileURL(join(import.meta.dirname, 'identity.ts')).href)) as IdentityModule;
});

const BOT: Identity = { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' };

// O git que o módulo chama herda o ambiente do processo: isola o global e o system da máquina.
beforeEach(() => {
  for (const [key, value] of Object.entries(isolatedEnv())) {
    if (key.startsWith('GIT_CONFIG_') || key === 'HOME') vi.stubEnv(key, value);
  }
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

describe('AI-14 readIdentity lê só o git config --local', () => {
  it('AI-14 modo bot completo devolve login e item do chaveiro', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'minha-conta');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-x');

    expect(mod.readIdentity(dir)).toEqual({ mode: 'bot', login: 'minha-conta', keychainService: 'item-x' });
  });

  it('AI-14 modo self devolve só o modo', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    expect(mod.readIdentity(dir)).toEqual({ mode: 'self' });
  });

  it('AI-14 sem nenhuma chave devolve undefined', () => {
    expect(mod.readIdentity(makeRepo())).toBeUndefined();
  });

  it('AI-14 modo desconhecido devolve undefined', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'admin');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'minha-conta');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-x');

    expect(mod.readIdentity(dir)).toBeUndefined();
  });

  it('AI-14 modo bot sem botLogin devolve undefined', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-x');

    expect(mod.readIdentity(dir)).toBeUndefined();
  });

  it('AI-14 modo bot sem keychainService devolve undefined', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'minha-conta');

    expect(mod.readIdentity(dir)).toBeUndefined();
  });

  it('AI-14 fora de um repositório git devolve undefined', () => {
    const dir = makeTempDir('sem-repo-');
    vi.stubEnv('GIT_CEILING_DIRECTORIES', join(dir, '..'));

    expect(mod.readIdentity(dir)).toBeUndefined();
  });

  it('AI-14 uma chave só no global não vale', () => {
    const dir = makeRepo();
    const globalFile = process.env.GIT_CONFIG_GLOBAL ?? '';
    git(dir, 'config', '--file', globalFile, 'casecellshop.identity', 'self');

    expect(mod.readIdentity(dir)).toBeUndefined();
  });

  it('AI-14 uma chave só em -c (ambiente) não vale', () => {
    const dir = makeRepo();
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'casecellshop.identity');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'self');

    expect(mod.readIdentity(dir)).toBeUndefined();
  });
});

describe('AI-14 writeIdentity grava no --local', () => {
  it('AI-14 bot: grava as três chaves e readIdentity devolve o mesmo objeto', () => {
    const dir = makeRepo();

    mod.writeIdentity(dir, BOT);

    expect(localConfig(dir, 'casecellshop.identity')).toBe('bot');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBe('minha-conta');
    expect(localConfig(dir, 'casecellshop.keychainService')).toBe('casecellshop-minha-conta');
    expect(mod.readIdentity(dir)).toEqual(BOT);
  });

  it('AI-14 self: grava o modo e readIdentity devolve o mesmo objeto', () => {
    const dir = makeRepo();

    mod.writeIdentity(dir, { mode: 'self' });

    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
    expect(mod.readIdentity(dir)).toEqual({ mode: 'self' });
  });

  it('AI-14 trocar de bot para self remove botLogin e keychainService', () => {
    const dir = makeRepo();
    mod.writeIdentity(dir, BOT);

    mod.writeIdentity(dir, { mode: 'self' });

    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBeUndefined();
    expect(localConfig(dir, 'casecellshop.keychainService')).toBeUndefined();
  });

  it('AI-14 self em repositório sem as chaves do bot não falha', () => {
    const dir = makeRepo();

    expect(() => {
      mod.writeIdentity(dir, { mode: 'self' });
    }).not.toThrow();
  });

  it('AI-14 trocar de conta bot sobrescreve a anterior', () => {
    const dir = makeRepo();
    mod.writeIdentity(dir, BOT);
    const other: Identity = { mode: 'bot', login: 'outra', keychainService: 'item-y' };

    mod.writeIdentity(dir, other);

    expect(mod.readIdentity(dir)).toEqual(other);
  });
});

describe('AI-14 defaultKeychainService', () => {
  it('AI-14 o item padrão do chaveiro é casecellshop-<conta>', () => {
    expect(mod.defaultKeychainService('minha-conta')).toBe('casecellshop-minha-conta');
    expect(mod.defaultKeychainService('outra')).toBe('casecellshop-outra');
  });
});

describe('AI-14 readToken', () => {
  it('AI-14 sem identidade devolve undefined e não consulta o chaveiro', () => {
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'segredo');

    expect(mod.readToken(undefined, makeRepo(), { keychain })).toBeUndefined();
    expect(keychain).not.toHaveBeenCalled();
  });

  it('AI-14 modo bot lê o item do chaveiro configurado', () => {
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'tok-bot');

    expect(mod.readToken(BOT, makeRepo(), { keychain })).toBe('tok-bot');
    expect(keychain).toHaveBeenCalledWith('casecellshop-minha-conta');
  });

  it('AI-14 modo bot apara o valor do chaveiro', () => {
    expect(mod.readToken(BOT, makeRepo(), { keychain: () => '  tok-bot\n' })).toBe('tok-bot');
  });

  it.each(['', '   ', '\n'])('AI-14 modo bot com valor vazio (%j) devolve undefined', (value) => {
    expect(mod.readToken(BOT, makeRepo(), { keychain: () => value })).toBeUndefined();
  });

  it('AI-14 modo bot com item ausente no chaveiro devolve undefined', () => {
    expect(mod.readToken(BOT, makeRepo(), { keychain: () => undefined })).toBeUndefined();
  });

  it('AI-14 modo self lê a credencial do git e nunca consulta o chaveiro', () => {
    const dir = makeRepo();
    setFakeCredential(dir, 'tok-self');
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'do-chaveiro');

    expect(mod.readToken({ mode: 'self' }, dir, { keychain })).toBe('tok-self');
    expect(keychain).not.toHaveBeenCalled();
  });

  it('AI-14 modo self lê a credencial do repositório indicado, não de outro', () => {
    const first = makeRepo();
    const second = makeRepo();
    setFakeCredential(first, 'tok-primeiro');
    setFakeCredential(second, 'tok-segundo');

    expect(mod.readToken({ mode: 'self' }, second)).toBe('tok-segundo');
    expect(mod.readToken({ mode: 'self' }, first)).toBe('tok-primeiro');
  });

  // Controle negativo: sem nenhum helper que responda, o git não pode ficar esperando entrada nem inventar token.
  it('AI-14 modo self sem credencial guardada devolve undefined, sem travar', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'credential.helper', '');

    expect(mod.readToken({ mode: 'self' }, dir)).toBeUndefined();
  }, 10_000);
});
