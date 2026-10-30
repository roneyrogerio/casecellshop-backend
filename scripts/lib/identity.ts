// Identidade com que os agentes agem no GitHub (AI-14), escolhida em cada clone
// no git config --local e nunca fixa no código: cada pessoa usa a conta de
// máquina dela (modo bot) ou a própria credencial (modo self). O git config
// foi escolhido porque o git, o credential helper, o headersHelper e os hooks
// o leem do mesmo lugar em qualquer shell. O token nunca é impresso nem gravado
// em disco: quem precisa dele chama readToken a cada uso.
import { spawnSync } from 'node:child_process';

export type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };

const KEYS = {
  identity: 'casecellshop.identity',
  botLogin: 'casecellshop.botLogin',
  keychainService: 'casecellshop.keychainService',
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
  deps: { keychain?: (service: string) => string | undefined } = {},
): string | undefined {
  if (!identity) return undefined;
  const raw = identity.mode === 'bot' ? (deps.keychain ?? systemKeychain)(identity.keychainService) : machineCredential(root);
  const token = raw?.trim();
  return token || undefined;
}
