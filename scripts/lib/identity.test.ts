import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, git, makeTempDir } from '../../test/helpers/git-sandbox.ts';
import { isolatedEnv, localConfig, makeRepo, setFakeCredential } from '../../test/helpers/identity-sandbox.ts';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };
type TokenStore = 'system' | 'file';
type Env = Record<string, string | undefined>;
type KeychainStatus = 'ok' | 'missing-tool' | 'no-service';
interface RunResult {
  status: number | null;
  stderr: string;
  error?: { code?: string };
}

interface IdentityModule {
  readTokenStore: (root: string) => TokenStore;
  writeTokenStore: (root: string, store: TokenStore) => void;
  tokenFilePath: (service: string, env?: Env) => string;
  writeTokenFile: (service: string, token: string, env?: Env) => string;
  keychainStatus: (deps?: {
    platform?: NodeJS.Platform;
    run?: (cmd: string, args: string[]) => RunResult;
  }) => KeychainStatus;
  readIdentity: (root: string) => Identity | undefined;
  writeIdentity: (root: string, identity: Identity) => void;
  defaultKeychainService: (login: string) => string;
  readToken: (
    identity: Identity | undefined,
    root: string,
    deps?: { keychain?: (service: string) => string | undefined; env?: Env },
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

describe('AI-14 readTokenStore e writeTokenStore, no --local', () => {
  it('AI-14 sem a chave o armazenamento é o do sistema', () => {
    expect(mod.readTokenStore(makeRepo())).toBe('system');
  });

  it('AI-14 casecellshop.tokenStore=file lê file', () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.tokenStore', 'file');

    expect(mod.readTokenStore(dir)).toBe('file');
  });

  it.each(['system', 'arquivo', 'FILE', ''])('AI-14 o valor %j da chave vale como o do sistema', (value) => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.tokenStore', value);

    expect(mod.readTokenStore(dir)).toBe('system');
  });

  it('AI-14 a chave só no global não vale: continua o do sistema', () => {
    const dir = makeRepo();
    git(dir, 'config', '--file', process.env.GIT_CONFIG_GLOBAL ?? '', 'casecellshop.tokenStore', 'file');

    expect(mod.readTokenStore(dir)).toBe('system');
  });

  it('AI-14 writeTokenStore file grava a chave no --local e readTokenStore devolve file', () => {
    const dir = makeRepo();

    mod.writeTokenStore(dir, 'file');

    expect(localConfig(dir, 'casecellshop.tokenStore')).toBe('file');
    expect(mod.readTokenStore(dir)).toBe('file');
  });

  it('AI-14 writeTokenStore system remove a chave', () => {
    const dir = makeRepo();
    mod.writeTokenStore(dir, 'file');

    mod.writeTokenStore(dir, 'system');

    expect(localConfig(dir, 'casecellshop.tokenStore')).toBeUndefined();
    expect(mod.readTokenStore(dir)).toBe('system');
  });

  it('AI-14 writeTokenStore system, com a chave ausente, não falha', () => {
    const dir = makeRepo();

    expect(() => {
      mod.writeTokenStore(dir, 'system');
    }).not.toThrow();
    expect(localConfig(dir, 'casecellshop.tokenStore')).toBeUndefined();
  });
});

describe('AI-14 tokenFilePath', () => {
  it('AI-14 com XDG_CONFIG_HOME o arquivo fica em $XDG_CONFIG_HOME/casecellshop/<item>', () => {
    const xdg = makeTempDir('xdg-');

    expect(mod.tokenFilePath('item-x', { XDG_CONFIG_HOME: xdg, HOME: '/nao/usar' })).toBe(
      join(xdg, 'casecellshop', 'item-x'),
    );
  });

  it('AI-14 sem XDG_CONFIG_HOME o arquivo fica em ~/.config/casecellshop/<item>', () => {
    const home = makeTempDir('home-');

    expect(mod.tokenFilePath('item-x', { HOME: home })).toBe(join(home, '.config', 'casecellshop', 'item-x'));
  });

  it('AI-14 XDG_CONFIG_HOME vazio vale como ausente', () => {
    const home = makeTempDir('home-');

    expect(mod.tokenFilePath('item-x', { XDG_CONFIG_HOME: '', HOME: home })).toBe(
      join(home, '.config', 'casecellshop', 'item-x'),
    );
  });

  it.each(['../x', '..', '../../etc/passwd', 'a/b', 'a\\b', '..\\x'])(
    'AI-14 o item %j não sai da pasta casecellshop',
    (service) => {
      const xdg = makeTempDir('xdg-');

      const path = mod.tokenFilePath(service, { XDG_CONFIG_HOME: xdg });

      expect(dirname(path)).toBe(join(xdg, 'casecellshop'));
      const name = path.slice(dirname(path).length + 1);
      expect(name).not.toBe('');
      expect(name).not.toMatch(/[/\\]/);
      expect(name).not.toContain('..');
    },
  );

  it('AI-14 itens diferentes e comuns dão arquivos diferentes (controle)', () => {
    const env = { XDG_CONFIG_HOME: makeTempDir('xdg-') };

    expect(mod.tokenFilePath('casecellshop-a', env)).not.toBe(mod.tokenFilePath('casecellshop-b', env));
    expect(mod.tokenFilePath('casecellshop-a', env)).toBe(join(env.XDG_CONFIG_HOME, 'casecellshop', 'casecellshop-a'));
  });
});

describe('AI-14 writeTokenFile', () => {
  it('AI-14 cria a pasta, grava o token sem quebra de linha a mais e devolve o caminho', () => {
    const xdg = makeTempDir('xdg-');
    const env = { XDG_CONFIG_HOME: join(xdg, 'ainda-nao-existe') };

    const path = mod.writeTokenFile('item-x', 'ghp_segredo', env);

    expect(path).toBe(mod.tokenFilePath('item-x', env));
    expect(readFileSync(path, 'utf8')).toBe('ghp_segredo');
  });

  // Condição de ambiente: o Windows não tem bits de permissão POSIX, então o modo 600 não é verificável lá.
  it.skipIf(process.platform === 'win32')('AI-14 o arquivo fica com permissão 600', () => {
    const env = { XDG_CONFIG_HOME: makeTempDir('xdg-') };

    const path = mod.writeTokenFile('item-x', 'ghp_segredo', env);

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  // Condição de ambiente: o Windows não tem bits de permissão POSIX, então o modo 600 não é verificável lá.
  it.skipIf(process.platform === 'win32')('AI-14 regravar um arquivo que estava com permissão aberta o deixa em 600', () => {
    const env = { XDG_CONFIG_HOME: makeTempDir('xdg-') };
    const path = mod.tokenFilePath('item-x', env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'velho', { mode: 0o644 });

    mod.writeTokenFile('item-x', 'novo', env);

    expect(readFileSync(path, 'utf8')).toBe('novo');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('AI-14 readToken com o token em arquivo', () => {
  function fileRepo(): { dir: string; env: Env } {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.tokenStore', 'file');
    return { dir, env: { XDG_CONFIG_HOME: makeTempDir('xdg-') } };
  }

  it('AI-14 tokenStore file lê o arquivo do item e não consulta o chaveiro', () => {
    const { dir, env } = fileRepo();
    mod.writeTokenFile(BOT.keychainService, 'tok-arquivo', env);
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'do-chaveiro');

    expect(mod.readToken(BOT, dir, { keychain, env })).toBe('tok-arquivo');
    expect(keychain).not.toHaveBeenCalled();
  });

  it('AI-14 tokenStore file apara o conteúdo do arquivo', () => {
    const { dir, env } = fileRepo();
    const path = mod.tokenFilePath(BOT.keychainService, env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '  tok-arquivo\n');

    expect(mod.readToken(BOT, dir, { keychain: () => 'do-chaveiro', env })).toBe('tok-arquivo');
  });

  it('AI-14 tokenStore file com arquivo ausente devolve undefined, sem cair no chaveiro', () => {
    const { dir, env } = fileRepo();
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'do-chaveiro');

    expect(mod.readToken(BOT, dir, { keychain, env })).toBeUndefined();
    expect(keychain).not.toHaveBeenCalled();
  });

  it('AI-14 tokenStore file com arquivo vazio devolve undefined', () => {
    const { dir, env } = fileRepo();
    const path = mod.tokenFilePath(BOT.keychainService, env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '\n');

    expect(mod.readToken(BOT, dir, { keychain: () => 'do-chaveiro', env })).toBeUndefined();
  });

  // Controle negativo: com o armazenamento do sistema, o arquivo existente é ignorado e vale o chaveiro.
  it('AI-14 tokenStore system ignora o arquivo e usa o chaveiro', () => {
    const dir = makeRepo();
    const env = { XDG_CONFIG_HOME: makeTempDir('xdg-') };
    mod.writeTokenFile(BOT.keychainService, 'tok-arquivo', env);
    const keychain = vi.fn<(service: string) => string | undefined>(() => 'do-chaveiro');

    expect(mod.readToken(BOT, dir, { keychain, env })).toBe('do-chaveiro');
    expect(keychain).toHaveBeenCalledWith('casecellshop-minha-conta');
  });

  it('AI-14 modo self não lê o arquivo mesmo com tokenStore file', () => {
    const { dir, env } = fileRepo();
    mod.writeTokenFile(BOT.keychainService, 'tok-arquivo', env);
    setFakeCredential(dir, 'tok-self');

    expect(mod.readToken({ mode: 'self' }, dir, { env })).toBe('tok-self');
  });
});

describe('AI-14 keychainStatus', () => {
  const run = (result: RunResult) => vi.fn<(cmd: string, args: string[]) => RunResult>(() => result);

  it('AI-14 no macOS o Chaveiro vale e nada é executado', () => {
    const runner = run({ status: 1, stderr: 'qualquer coisa' });

    expect(mod.keychainStatus({ platform: 'darwin', run: runner })).toBe('ok');
    expect(runner).not.toHaveBeenCalled();
  });

  it('AI-14 no Linux sem o secret-tool (ENOENT) devolve missing-tool', () => {
    const runner = run({ status: null, stderr: '', error: { code: 'ENOENT' } });

    expect(mod.keychainStatus({ platform: 'linux', run: runner })).toBe('missing-tool');
    expect(runner.mock.calls[0]?.[0]).toBe('secret-tool');
  });

  it.each([
    'Cannot autolaunch D-Bus without X11 $DISPLAY',
    'The name org.freedesktop.secrets was not provided by any .service files',
  ])('AI-14 no Linux, com o secret-tool dizendo %j, devolve no-service', (stderr) => {
    expect(mod.keychainStatus({ platform: 'linux', run: run({ status: 1, stderr }) })).toBe('no-service');
  });

  it('AI-14 no Linux, com o secret-tool respondendo status 0, devolve ok', () => {
    expect(mod.keychainStatus({ platform: 'linux', run: run({ status: 0, stderr: '' }) })).toBe('ok');
  });

  it('AI-14 no Linux, status 1 sem erro de D-Bus (nada encontrado) devolve ok', () => {
    expect(mod.keychainStatus({ platform: 'linux', run: run({ status: 1, stderr: '' }) })).toBe('ok');
  });
});

// O ambiente de teste acima já define GIT_TERMINAL_PROMPT=0, o que esconderia a regressão: aqui ele fica de fora.
// No terminal do VS Code, o GIT_ASKPASS vem definido, e o git chama o askpass antes de olhar o GIT_TERMINAL_PROMPT.
// Só os controles do próprio readToken (credential.interactive=false, core.askPass vazio, GIT_ASKPASS vazio) o impedem.
describe('AI-14 modo self nunca pergunta, sem a proteção do ambiente de teste', () => {
  const secret = 'senha-do-askpass';

  // Script que grava o marcador e imprime uma senha: se o git o chamar, o marcador aparece.
  function askpassScript(): { script: string; marker: string } {
    const dir = makeTempDir('askpass-');
    const marker = join(dir, 'askpass-chamado');
    const script = join(dir, 'askpass.sh');
    writeFileSync(script, `#!/bin/sh\necho chamado > "${marker}"\necho ${secret}\n`);
    chmodSync(script, 0o755);
    return { script, marker };
  }

  // Repositório sem nenhum helper que responda: o único jeito de o git obter a senha é perguntar.
  function bareRepo(): string {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'credential.helper', '');
    return dir;
  }

  beforeEach(() => {
    // Desfaz o GIT_TERMINAL_PROMPT=0 do beforeEach de cima e reaplica só o isolamento do git global e do system.
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(isolatedEnv())) {
      if (key.startsWith('GIT_CONFIG_') || key === 'HOME') vi.stubEnv(key, value);
    }
    vi.stubEnv('GIT_TERMINAL_PROMPT', undefined);
  });

  // Condição de ambiente: o askpass é um script sh executável, que o Windows não roda.
  it.skipIf(process.platform === 'win32')(
    'AI-14 modo self com GIT_ASKPASS definido e sem GIT_TERMINAL_PROMPT devolve undefined e não chama o askpass',
    () => {
      const { script, marker } = askpassScript();
      vi.stubEnv('GIT_ASKPASS', script);
      const dir = bareRepo();

      expect(process.env.GIT_TERMINAL_PROMPT).toBeUndefined();
      expect(mod.readToken({ mode: 'self' }, dir)).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    },
    15_000,
  );

  // Controle negativo: o mesmo credential fill do git, sem as proteções, chama o askpass. Prova que o teste acima pegaria a regressão.
  // Condição de ambiente: o askpass é um script sh executável, que o Windows não roda.
  it.skipIf(process.platform === 'win32')(
    'AI-14 controle: credential fill sem as proteções chama o askpass e obtém a senha',
    () => {
      const { script, marker } = askpassScript();
      const dir = bareRepo();
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== 'GIT_TERMINAL_PROMPT') env[key] = value;
      }
      env.GIT_ASKPASS = script;

      const result = spawnSync('git', ['credential', 'fill'], {
        cwd: dir,
        encoding: 'utf8',
        env,
        input: 'protocol=https\nhost=github.com\n\n',
        timeout: 10_000,
      });

      expect(existsSync(marker)).toBe(true);
      expect(result.stdout).toContain(`password=${secret}`);
    },
    15_000,
  );
});
