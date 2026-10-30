// Configura este clone para o fluxo de IA (AI-09, AI-14), uma vez por clone e
// por pessoa: grava no git config --local com que conta os agentes agem no
// GitHub e ajusta o push a essa escolha. Sem argumentos, reaproveita a escolha
// já feita ou, na primeira vez, pergunta no terminal, como o gh auth login. No modo bot, quando o token falta ou é
// recusado, pede o token novo ao próprio chaveiro do sistema, que o lê sem eco:
// ele nunca passa pela linha de comando nem por este processo. Pode rodar de
// novo sem efeito colateral, e é assim que se troca um token vencido.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkToken, collectFacts, diagnose, report, type TokenCheck } from './check-env.ts';
import { configureGitBot, installCommitHook, removeGitBot } from './lib/git-bot.ts';
import {
  defaultKeychainService,
  type Identity,
  keychainHelp,
  keychainStatus,
  readIdentity,
  readToken,
  readTokenStore,
  type TokenStore,
  tokenFilePath,
  writeIdentity,
  writeTokenFile,
  writeTokenStore,
} from './lib/identity.ts';

// O setup e o diagnóstico mostram a mesma ajuda quando falta o chaveiro.
export { keychainHelp };

export const USAGE = [
  'Uso:',
  '  npm run setup:local',
  '      Na primeira vez, pergunta no terminal; depois, reaproveita a escolha (para trocar o token, por exemplo).',
  '  npm run setup:local -- --identity bot --login <conta-de-máquina> [--keychain <item>] [--token-store file]',
  '      Os agentes agem como uma conta de máquina separada da sua; você aprova os PRs deles.',
  '      O token fica no chaveiro do sistema (Chaveiro no macOS, Secret Service no Linux), no item',
  '      casecellshop-<conta>, a menos que --keychain diga outro. Sem chaveiro (servidor, contêiner, WSL),',
  '      --token-store file o guarda num arquivo em ~/.config/casecellshop/, com permissão 600 e sem cifra.',
  '  npm run setup:local -- --identity self',
  '      Os agentes usam a credencial do GitHub que o git desta máquina já tem. Os PRs saem no seu',
  '      nome, e o GitHub não deixa o autor aprová-los.',
].join('\n');

// Regra de nome de usuário do GitHub: letras, números e hífens simples, sem
// hífen nas pontas, até 39 caracteres.
const GITHUB_LOGIN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

type Parsed = { identity: Identity; tokenStore?: TokenStore } | { error: string };

export function parseSetupArgs(argv: string[]): Parsed {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const match = /^--(identity|login|keychain|token-store)(?:=(.*))?$/.exec(arg);
    if (!match) return { error: `Argumento desconhecido: ${arg}\n\n${USAGE}` };
    const value = match[2] ?? argv[(i += 1)];
    if (value === undefined || value === '' || value.startsWith('--')) return { error: `--${match[1]} sem valor.\n\n${USAGE}` };
    options.set(match[1] ?? '', value);
  }
  const mode = options.get('identity');
  const login = options.get('login');
  const keychain = options.get('keychain');
  const store = options.get('token-store');
  if (mode === 'self') {
    if (login !== undefined || keychain !== undefined || store !== undefined) {
      return { error: `--login, --keychain e --token-store só valem no modo bot.\n\n${USAGE}` };
    }
    return { identity: { mode: 'self' } };
  }
  if (mode !== 'bot') return { error: `Escolha a identidade.\n\n${USAGE}` };
  if (!login || !GITHUB_LOGIN.test(login)) return { error: `Informe um login válido do GitHub em --login.\n\n${USAGE}` };
  if (store !== undefined && store !== 'file' && store !== 'system') return { error: `--token-store aceita file ou system.\n\n${USAGE}` };
  const identity: Identity = { mode: 'bot', login, keychainService: keychain ?? defaultKeychainService(login) };
  return store === undefined ? { identity } : { identity, tokenStore: store };
}

export function resolveIdentity(argv: string[], configured: Identity | undefined, interactive: boolean): Parsed | { ask: true } {
  if (argv.length > 0) return parseSetupArgs(argv);
  if (configured) return { identity: configured };
  return interactive ? { ask: true } : { error: `Este clone ainda não tem identidade configurada.\n\n${USAGE}` };
}

// Uma pergunta pode trazer opções: no terminal, elas viram um menu com setas;
// sem elas, um campo de texto. A lógica fica aqui, fora do terminal, para ser
// testada com respostas prontas.
export type Ask = (question: string, options?: { choices: { value: string; name: string; description?: string }[] }) => Promise<string>;

const MODE_CHOICES = [
  { value: '1', name: 'Uma conta de máquina, separada da sua (recomendado)', description: 'Os agentes abrem os PRs com essa conta, e você os aprova com a sua.' },
  { value: '2', name: 'A sua própria conta', description: 'Os PRs saem no seu nome, e o GitHub não deixa o autor aprová-los.' },
];

export async function promptIdentity(ask: Ask): Promise<{ identity: Identity } | { error: string }> {
  const mode = (await ask('Com que conta os agentes vão agir no GitHub?', { choices: MODE_CHOICES })).trim().toLowerCase();
  if (mode === '2' || mode === 'self') return { identity: { mode: 'self' } };
  if (mode !== '' && mode !== '1' && mode !== 'bot') return { error: `Resposta não reconhecida: ${mode}. Responda 1 ou 2.` };
  const login = (await ask('Login da conta de máquina no GitHub:')).trim();
  if (!GITHUB_LOGIN.test(login)) return { error: `Login inválido no GitHub: "${login}".` };
  const fallback = defaultKeychainService(login);
  const keychain = (await ask(`Item do chaveiro onde o token fica (Enter para ${fallback}):`)).trim();
  return { identity: { mode: 'bot', login, keychainService: keychain || fallback } };
}

// O @inquirer só carrega quando há terminal para perguntar: os testes rodam o
// setup sem node_modules, e o caminho sem perguntas não precisa dele.
async function askInTerminal(): Promise<{ identity: Identity } | { error: string }> {
  const [{ default: select }, { default: input }] = await Promise.all([import('@inquirer/select'), import('@inquirer/input')]);
  try {
    return await promptIdentity((message, options) => (options ? select({ message, choices: options.choices }) : input({ message })));
  } catch (error) {
    // Ctrl+C no meio das perguntas: sai sem gravar nada.
    if (error instanceof Error && error.name === 'ExitPromptError') return { error: 'Configuração cancelada; nada foi gravado.' };
    throw error;
  }
}

// O chaveiro do sistema pergunta o token direto no terminal, sem eco. No
// update, o -U atualiza o item no lugar: se a pessoa cancelar o prompt, o token
// antigo continua lá. Só o replace (token de outra conta, depois de confirmado)
// apaga o item antes, porque a conta gravada nele é outra.
function storeTokenInteractively(identity: Extract<Identity, { mode: 'bot' }>, mode: 'update' | 'replace'): boolean {
  console.log(`Cole o token clássico de ${identity.login} (escopos repo e workflow) quando o chaveiro pedir.`);
  if (process.platform === 'darwin') {
    if (mode === 'replace') spawnSync('security', ['delete-generic-password', '-s', identity.keychainService], { stdio: 'ignore' });
    const added = spawnSync('security', ['add-generic-password', '-U', '-s', identity.keychainService, '-a', identity.login, '-w'], { stdio: 'inherit' });
    return added.status === 0;
  }
  const stored = spawnSync('secret-tool', ['store', `--label=${identity.login}`, 'service', identity.keychainService], { stdio: 'inherit' });
  return stored.status === 0;
}

// No modo arquivo, o token passa por este processo (não há chaveiro que o
// peça); o campo esconde o que é digitado, e o arquivo nasce com permissão 600.
async function storeTokenInFile(identity: Extract<Identity, { mode: 'bot' }>): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Para gravar o token em arquivo, rode o setup num terminal interativo.');
    return false;
  }
  const { default: input } = await import('@inquirer/input');
  const token = (await input({ message: `Token clássico de ${identity.login} (escopos repo e workflow):`, transformer: (value) => '*'.repeat(value.length) })).trim();
  if (!token) return false;
  const path = writeTokenFile(identity.keychainService, token);
  console.log(`Token gravado em ${path}, com permissão 600. O arquivo não é cifrado: proteja a máquina e o disco.`);
  return true;
}

export interface SetupBotDeps {
  readToken: () => string | undefined;
  checkToken: (token: string | undefined) => Promise<TokenCheck>;
  keychainStatus: () => 'ok' | 'missing-tool' | 'no-service';
  storeToken: (mode: 'update' | 'replace') => Promise<boolean>;
  confirm: (message: string) => Promise<boolean>;
  interactive: boolean;
  installHelper: () => void;
  log: (message: string) => void;
}

// Quatro caminhos, conforme o que o GitHub diz do token guardado: válido da
// conta, segue sem tocar nele; ausente ou recusado, pede o novo; de outra
// conta, só troca com confirmação; sem conferência, não mexe em nada. O helper
// do projeto só entra depois de um token aceito.
export async function setupBot(
  _root: string,
  identity: Extract<Identity, { mode: 'bot' }>,
  store: TokenStore,
  deps: SetupBotDeps,
): Promise<boolean> {
  const current = await deps.checkToken(deps.readToken());
  if (current.result === 'unreachable') {
    deps.log('Não deu para conferir o token no GitHub (sem rede, GitHub fora do ar ou limite de taxa). Nada foi alterado no chaveiro; rode o setup de novo quando a rede voltar.');
    return false;
  }
  if (current.result === 'valid' && current.login === identity.login) {
    deps.installHelper();
    return true;
  }
  let mode: 'update' | 'replace' = 'update';
  if (current.result === 'valid') {
    const question = `O token guardado em ${identity.keychainService} é de ${current.login}, não de ${identity.login}.`;
    if (!deps.interactive) {
      deps.log(`${question} Nada foi alterado. Se o item é de outro uso, escolha outro com --keychain.`);
      return false;
    }
    if (!(await deps.confirm(`${question} Trocar pelo token de ${identity.login}?`))) {
      deps.log('Nada foi alterado.');
      return false;
    }
    mode = 'replace';
  } else {
    deps.log(current.result === 'refused' ? `O token guardado de ${identity.login} foi recusado pelo GitHub (vencido ou revogado).` : `Não há token de ${identity.login} guardado.`);
  }
  if (store === 'system') {
    const status = deps.keychainStatus();
    if (status !== 'ok') {
      deps.log(keychainHelp(status));
      return false;
    }
  }
  if (!(await deps.storeToken(mode))) {
    deps.log(store === 'file' ? 'O token não foi gravado. Rode o comando de novo.' : 'O chaveiro não guardou o token. Rode o comando de novo.');
    return false;
  }
  const confirmed = await deps.checkToken(deps.readToken());
  if (confirmed.result !== 'valid' || confirmed.login !== identity.login) {
    deps.log(confirmed.result === 'valid' ? `O token novo é de ${confirmed.login}, não de ${identity.login}.` : 'O GitHub não aceitou o token novo (ou não deu para conferir).');
    return false;
  }
  deps.installHelper();
  return true;
}

const IDENTITY_KEYS = ['casecellshop.identity', 'casecellshop.botLogin', 'casecellshop.keychainService', 'casecellshop.tokenStore'];

function localValue(root: string, key: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'config', '--local', '--get', key], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// A identidade nova precisa estar gravada enquanto o setup roda (o token é lido
// pelo item que ela aponta), mas, se o setup falhar, o clone não pode ficar
// apontando para um item recusado ou de outra conta: o git config volta a ser
// exatamente o de antes, inclusive nas chaves que não existiam.
export async function configureIdentity(
  root: string,
  identity: Identity,
  store: TokenStore,
  deps: { setupBot: () => Promise<boolean> },
): Promise<boolean> {
  const before = new Map(IDENTITY_KEYS.map((key) => [key, localValue(root, key)]));
  writeIdentity(root, identity);
  writeTokenStore(root, store);
  let ok = false;
  try {
    ok = await deps.setupBot();
    return ok;
  } finally {
    // Também numa exceção (Ctrl+C num prompt, erro ao gravar o token): o clone
    // nunca fica apontando para a identidade que não se confirmou.
    if (!ok) {
      for (const [key, value] of before) {
        spawnSync('git', ['-C', root, 'config', '--local', ...(value === undefined ? ['--unset-all', key] : [key, value])], { encoding: 'utf8' });
      }
    }
  }
}

async function confirmInTerminal(message: string): Promise<boolean> {
  const { default: select } = await import('@inquirer/select');
  const answer = await select({ message, choices: [{ value: 'nao', name: 'Não, manter o token guardado' }, { value: 'sim', name: 'Sim, trocar' }] });
  return answer === 'sim';
}

async function main(): Promise<number> {
  // Na nuvem, o GitHub é a conta conectada ao ambiente, pelo proxy da nuvem,
  // e não há chaveiro: não há o que configurar no clone.
  if (process.env.CLAUDE_CODE_REMOTE === 'true') {
    console.log('Na sessão do Claude Code na nuvem, o GitHub é a conta conectada ao ambiente (GitHub App do Claude ou /web-setup). O setup:local não se aplica aqui, e nada foi gravado.');
    return 0;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const resolved = resolveIdentity(process.argv.slice(2), readIdentity(root), Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const parsed = 'ask' in resolved ? await askInTerminal() : resolved;
  if ('error' in parsed) {
    console.error(parsed.error);
    return 1;
  }
  const { identity } = parsed;
  console.log(identity.mode === 'bot' ? `Identidade: conta de máquina ${identity.login} (chaveiro: ${identity.keychainService}).` : 'Identidade: a credencial do GitHub desta máquina.');
  // Sem --token-store, vale o que já estava gravado no clone.
  const requested: TokenStore | undefined = 'tokenStore' in parsed ? (parsed as { tokenStore?: TokenStore }).tokenStore : undefined;
  const store: TokenStore = identity.mode === 'bot' ? (requested ?? readTokenStore(root)) : 'system';
  if (identity.mode === 'bot' && store === 'file') console.log(`O token fica em ${tokenFilePath(identity.keychainService)}.`);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ok = await configureIdentity(root, identity, store, {
    setupBot:
      identity.mode === 'bot'
        ? () =>
            setupBot(root, identity, store, {
              readToken: () => readToken(identity, root),
              checkToken: (token) => checkToken(token),
              keychainStatus: () => keychainStatus(),
              storeToken: (mode) => (store === 'file' ? storeTokenInFile(identity) : Promise.resolve(storeTokenInteractively(identity, mode))),
              confirm: confirmInTerminal,
              interactive,
              installHelper: () => configureGitBot(root),
              log: (message) => console.log(message),
            })
        : () => {
            removeGitBot(root);
            return Promise.resolve(true);
          },
  });
  if (!ok) {
    console.log('A configuração anterior deste clone foi mantida.');
    return 1;
  }
  installCommitHook(root);
  // O diagnóstico é informativo: o que falta além da identidade (Docker, Node)
  // não desfaz a configuração feita aqui.
  console.log(report(diagnose(await collectFacts(root))));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
