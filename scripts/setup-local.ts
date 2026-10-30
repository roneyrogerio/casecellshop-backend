// Configura a máquina para o fluxo agir como o bot (AI-09), uma vez por clone.
// Não grava o token em lugar nenhum: o git e o MCP chamam helpers que o leem do
// chaveiro a cada uso. Pode rodar de novo sem efeito colateral.
import { fileURLToPath } from 'node:url';
import { BOT_KEYCHAIN_SERVICE, BOT_LOGIN, readBotToken } from './lib/bot-token.ts';
import { collectFacts, diagnose, report } from './check-env.ts';
import { configureGitBot } from './lib/git-bot.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

if (!readBotToken()) {
  const add =
    process.platform === 'darwin'
      ? `security add-generic-password -s ${BOT_KEYCHAIN_SERVICE} -a ${BOT_LOGIN} -w`
      : `secret-tool store --label="${BOT_LOGIN}" service ${BOT_KEYCHAIN_SERVICE}`;
  console.error(`O token do ${BOT_LOGIN} não está no chaveiro. Peça ao mantenedor o token clássico do bot`);
  console.error(`(escopos repo e workflow), guarde-o com o comando abaixo (ele pede o valor sem ecoar) e rode de novo:`);
  console.error(`  ${add}`);
  process.exit(1);
}

// O push sai como o bot. O MCP do GitHub não precisa de registro: o .mcp.json
// versionado o declara, e o Claude Code o carrega ao abrir a pasta.
configureGitBot(root);

const results = diagnose(await collectFacts(root));
console.log(report(results));
process.exit(results.every((result) => result.ok) ? 0 : 1);
