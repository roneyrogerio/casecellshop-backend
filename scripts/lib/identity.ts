// Identidade com que os agentes agem no GitHub (AI-14), escolhida em cada clone
// no git config --local e nunca fixa no código: cada pessoa usa a conta de
// máquina dela (modo bot) ou a própria credencial (modo self). O git config
// foi escolhido porque o git, o credential helper, o headersHelper e os hooks
// o leem do mesmo lugar em qualquer shell. O token nunca é impresso, e só vai
// para um arquivo no disco por escolha explícita (TokenStore): quem precisa
// dele chama readToken a cada uso.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };

// Onde o token do modo bot fica: o chaveiro do sistema (o Chaveiro no macOS, o
// Secret Service no Linux) ou, só por escolha explícita, um arquivo fora do
// repositório, para máquina sem chaveiro (servidor, contêiner, WSL).
export type TokenStore = 'system' | 'file';

type Env = Record<string, string | undefined>;

const KEYS = {
  identity: 'casecellshop.identity',
  botLogin: 'casecellshop.botLogin',
  keychainService: 'casecellshop.keychainService',
  tokenStore: 'casecellshop.tokenStore',
} as const;

function readLocal(root: string, key: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'config', '--local', '--get', key], { encoding: 'utf8' });
  const value = result.status === 0 ? result.stdout.trim() : '';
  return value || undefined;
}

function git(root: string, ...args: string[]): void {
  spawnSync('git', ['-C', root, 'config', '--local', ...args], { encoding: 'utf8' });
}

export function defaultKeychainService(login: string): string {
  return `casecellshop-${login}`;
}

export function readIdentity(root: string): Identity | undefined {
  const mode = readLocal(root, KEYS.identity);
  if (mode === 'self') return { mode: 'self' };
  if (mode !== 'bot') return undefined;
  const login = readLocal(root, KEYS.botLogin);
  const keychainService = readLocal(root, KEYS.keychainService);
  return login && keychainService ? { mode: 'bot', login, keychainService } : undefined;
}

export function writeIdentity(root: string, identity: Identity): void {
  git(root, KEYS.identity, identity.mode);
  if (identity.mode === 'bot') {
    git(root, KEYS.botLogin, identity.login);
    git(root, KEYS.keychainService, identity.keychainService);
    return;
  }
  // No modo self, uma conta de máquina deixada para trás seria lida por engano
  // se alguém voltasse ao bot sem passar pelo setup.
  git(root, '--unset-all', KEYS.botLogin);
  git(root, '--unset-all', KEYS.keychainService);
}

export function readTokenStore(root: string): TokenStore {
  return readLocal(root, KEYS.tokenStore) === 'file' ? 'file' : 'system';
}

export function writeTokenStore(root: string, store: TokenStore): void {
  if (store === 'file') git(root, KEYS.tokenStore, 'file');
  else git(root, '--unset-all', KEYS.tokenStore);
}

// Mesmo lugar que o gh e o Git Credential Manager usam para configuração por
// usuário (XDG), fora do repositório. O nome perde separadores e "..", para
// um item estranho não sair da pasta.
export function tokenFilePath(service: string, env: Env = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'casecellshop', service.replaceAll('..', '_').replaceAll(/[/\\]/g, '_'));
}

// Permissão 600, inclusive ao regravar um arquivo que já existia mais aberto:
// o writeFileSync só aplica o mode na criação.
export function writeTokenFile(service: string, token: string, env: Env = process.env): string {
  const path = tokenFilePath(service, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function readTokenFile(service: string, env: Env): string | undefined {
  try {
    return readFileSync(tokenFilePath(service, env), 'utf8');
  } catch {
    return undefined;
  }
}

type Run = (cmd: string, args: string[]) => { status: number | null; stderr: string; error?: { code?: string } };

const defaultRun: Run = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  // Sem a chave quando não houve erro: com exactOptionalPropertyTypes, `error`
  // opcional não aceita `undefined` explícito.
  return {
    status: result.status,
    stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error as { code?: string } } : {}),
  };
};

// No Linux, o Secret Service só existe numa sessão com D-Bus e um provedor
// (GNOME Keyring, KWallet); em servidor, contêiner e WSL ele falta. Uma busca
// que não acha nada sai com 1 sem erro de D-Bus, e isso conta como chaveiro ok.
export function keychainStatus(deps: { platform?: NodeJS.Platform; run?: Run } = {}): 'ok' | 'missing-tool' | 'no-service' {
  if ((deps.platform ?? process.platform) !== 'linux') return 'ok';
  const probe = (deps.run ?? defaultRun)('secret-tool', ['search', 'service', 'casecellshop-probe']);
  if (probe.error?.code === 'ENOENT') return 'missing-tool';
  if (/d-?bus|org\.freedesktop\.secrets/i.test(probe.stderr)) return 'no-service';
  return 'ok';
}

// O que dizer quando o chaveiro do Linux não está disponível: o pacote que
// falta, ou as saídas quando não há Secret Service (servidor, contêiner, WSL).
export function keychainHelp(status: 'missing-tool' | 'no-service'): string {
  if (status === 'missing-tool') {
    return 'Falta o secret-tool, que fala com o chaveiro do Linux (Secret Service). Instale o pacote libsecret-tools (Debian e Ubuntu: sudo apt install libsecret-tools; Fedora: libsecret; Arch: libsecret) e rode o setup de novo.';
  }
  return 'Não há chaveiro do sistema respondendo (Secret Service, como o GNOME Keyring), o que é comum em servidor, contêiner e WSL. Saídas: npm run setup:local -- --identity self, com a credencial do git da máquina (no WSL, o Git Credential Manager do Git for Windows); ou --token-store file, que guarda o token num arquivo com permissão 600, que não é cifrado.';
}

function systemKeychain(service: string): string | undefined {
  const lookup =
    process.platform === 'darwin'
      ? spawnSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8' })
      : spawnSync('secret-tool', ['lookup', 'service', service], { encoding: 'utf8' });
  return lookup.status === 0 ? lookup.stdout : undefined;
}

// A credencial que o git da máquina já guarda, pelos helpers dela. Nunca
// pergunta: no terminal do VS Code, o askpass abriria uma janela, e um hook
// travado esperando entrada pararia a sessão.
function machineCredential(root: string): string | undefined {
  const result = spawnSync(
    'git',
    ['-C', root, '-c', 'credential.interactive=false', '-c', 'core.askPass=', 'credential', 'fill'],
    {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
    },
  );
  if (result.status !== 0) return undefined;
  const line = (result.stdout ?? '').split('\n').find((entry) => entry.startsWith('password='));
  return line?.slice('password='.length);
}

export function readToken(
  identity: Identity | undefined,
  root: string,
  deps: { keychain?: (service: string) => string | undefined; env?: Env } = {},
): string | undefined {
  if (!identity) return undefined;
  let raw: string | undefined;
  if (identity.mode === 'self') raw = machineCredential(root);
  else if (readTokenStore(root) === 'file') raw = readTokenFile(identity.keychainService, deps.env ?? process.env);
  else raw = (deps.keychain ?? systemKeychain)(identity.keychainService);
  const token = raw?.trim();
  return token || undefined;
}
