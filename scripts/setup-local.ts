// Configura este clone para o fluxo de IA (AI-09, AI-14), uma vez por clone e
// por pessoa: grava no git config --local com que conta os agentes agem no
// GitHub e ajusta o push a essa escolha. Sem argumentos, reaproveita a escolha
// já feita ou, na primeira vez, pergunta no terminal, como o gh auth login. No modo bot, quando o token falta ou é
// recusado, pede o token novo ao próprio chaveiro do sistema, que o lê sem eco:
// ele nunca passa pela linha de comando nem por este processo. Pode rodar de
// novo sem efeito colateral, e é assim que se troca um token vencido.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFacts, diagnose, report, tokenLogin } from './check-env.ts';
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

// O chaveiro do sistema pergunta o token direto no terminal, sem eco. Apaga o
// item antigo antes, para não ficarem dois itens com o mesmo serviço.
function storeTokenInteractively(identity: Extract<Identity, { mode: 'bot' }>): boolean {
  console.log(`Cole o token clássico de ${identity.login} (escopos repo e workflow) quando o chaveiro pedir.`);
  if (process.platform === 'darwin') {
    spawnSync('security', ['delete-generic-password', '-s', identity.keychainService], { stdio: 'ignore' });
    const added = spawnSync('security', ['add-generic-password', '-s', identity.keychainService, '-a', identity.login, '-w'], { stdio: 'inherit' });
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

async function setupBot(root: string, identity: Extract<Identity, { mode: 'bot' }>, store: TokenStore): Promise<boolean> {
  const login = await tokenLogin(readToken(identity, root));
  if (login !== identity.login) {
    console.log(login ? `O token guardado é de ${login}, não de ${identity.login}.` : `Não há token válido de ${identity.login} guardado.`);
    if (store === 'system') {
      const status = keychainStatus();
      if (status !== 'ok') {
        console.error(keychainHelp(status));
        return false;
      }
    }
    const stored = store === 'file' ? await storeTokenInFile(identity) : storeTokenInteractively(identity);
    if (!stored) {
      console.error(store === 'file' ? 'O token não foi gravado. Rode o comando de novo.' : 'O chaveiro não guardou o token. Rode o comando de novo.');
      return false;
    }
    const confirmed = await tokenLogin(readToken(identity, root));
    if (confirmed !== identity.login) {
      console.error(confirmed ? `O token novo é de ${confirmed}, não de ${identity.login}.` : 'O GitHub recusou o token novo (ou não houve rede para conferir).');
      return false;
    }
  }
  configureGitBot(root);
  return true;
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
  writeIdentity(root, identity);
  if (identity.mode === 'bot') {
    // Sem --token-store, vale o que já estava gravado no clone.
    const requested: TokenStore | undefined = 'tokenStore' in parsed ? (parsed as { tokenStore?: TokenStore }).tokenStore : undefined;
    const store = requested ?? readTokenStore(root);
    writeTokenStore(root, store);
    if (store === 'file') console.log(`O token fica em ${tokenFilePath(identity.keychainService)}.`);
    if (!(await setupBot(root, identity, store))) return 1;
  } else {
    writeTokenStore(root, 'system');
    removeGitBot(root);
  }
  installCommitHook(root);
  // O diagnóstico é informativo: o que falta além da identidade (Docker, Node)
  // não desfaz a configuração feita aqui.
  console.log(report(diagnose(await collectFacts(root))));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
