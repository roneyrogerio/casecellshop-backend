// Configura este clone para o fluxo de IA (AI-09, AI-14), uma vez por clone e
// por pessoa: grava no git config --local com que conta os agentes agem no
// GitHub e ajusta o push a essa escolha. No modo bot, quando o token falta ou é
// recusado, pede o token novo ao próprio chaveiro do sistema, que o lê sem eco:
// ele nunca passa pela linha de comando nem por este processo. Pode rodar de
// novo sem efeito colateral, e é assim que se troca um token vencido.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { collectFacts, diagnose, report, tokenLogin } from './check-env.ts';
import { configureGitBot, installCommitHook, removeGitBot } from './lib/git-bot.ts';
import { defaultKeychainService, type Identity, readToken, writeIdentity } from './lib/identity.ts';

export const USAGE = [
  'Uso:',
  '  npm run setup:local -- --identity bot --login <conta-de-máquina> [--keychain <item-do-chaveiro>]',
  '      Os agentes agem como uma conta de máquina separada da sua; você aprova os PRs deles.',
  '      O token fica no chaveiro, no item casecellshop-<conta>, a menos que --keychain diga outro.',
  '  npm run setup:local -- --identity self',
  '      Os agentes usam a credencial do GitHub que o git desta máquina já tem. Os PRs saem no seu',
  '      nome, e o GitHub não deixa o autor aprová-los.',
].join('\n');

// Regra de nome de usuário do GitHub: letras, números e hífens simples, sem
// hífen nas pontas, até 39 caracteres.
const GITHUB_LOGIN = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function parseSetupArgs(argv: string[]): { identity: Identity } | { error: string } {
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    const match = /^--(identity|login|keychain)(?:=(.*))?$/.exec(arg);
    if (!match) return { error: `Argumento desconhecido: ${arg}\n\n${USAGE}` };
    const value = match[2] ?? argv[(i += 1)];
    if (value === undefined || value === '' || value.startsWith('--')) return { error: `--${match[1]} sem valor.\n\n${USAGE}` };
    options.set(match[1] ?? '', value);
  }
  const mode = options.get('identity');
  const login = options.get('login');
  const keychain = options.get('keychain');
  if (mode === 'self') {
    if (login !== undefined || keychain !== undefined) return { error: `--login e --keychain só valem no modo bot.\n\n${USAGE}` };
    return { identity: { mode: 'self' } };
  }
  if (mode !== 'bot') return { error: `Escolha a identidade.\n\n${USAGE}` };
  if (!login || !GITHUB_LOGIN.test(login)) return { error: `Informe um login válido do GitHub em --login.\n\n${USAGE}` };
  return { identity: { mode: 'bot', login, keychainService: keychain ?? defaultKeychainService(login) } };
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

async function setupBot(root: string, identity: Extract<Identity, { mode: 'bot' }>): Promise<boolean> {
  const login = await tokenLogin(readToken(identity, root));
  if (login !== identity.login) {
    console.log(login ? `O token guardado é de ${login}, não de ${identity.login}.` : `Não há token válido de ${identity.login} no chaveiro.`);
    if (!storeTokenInteractively(identity)) {
      console.error('O chaveiro não guardou o token. Rode o comando de novo.');
      return false;
    }
    const stored = await tokenLogin(readToken(identity, root));
    if (stored !== identity.login) {
      console.error(stored ? `O token novo é de ${stored}, não de ${identity.login}.` : 'O GitHub recusou o token novo (ou não houve rede para conferir).');
      return false;
    }
  }
  configureGitBot(root);
  return true;
}

async function main(): Promise<number> {
  const parsed = parseSetupArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(parsed.error);
    return 1;
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const { identity } = parsed;
  writeIdentity(root, identity);
  if (identity.mode === 'bot') {
    if (!(await setupBot(root, identity))) return 1;
  } else {
    removeGitBot(root);
  }
  installCommitHook(root);
  // O diagnóstico é informativo: o que falta além da identidade (Docker, Node)
  // não desfaz a configuração feita aqui.
  console.log(report(diagnose(await collectFacts(root))));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
