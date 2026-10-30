// Configura a máquina para o fluxo agir como o bot (AI-09), uma vez por clone.
// Não grava o token em lugar nenhum: o git e o MCP chamam helpers que o leem do
// chaveiro a cada uso. Pode rodar de novo sem efeito colateral.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_KEYCHAIN_SERVICE, BOT_LOGIN, readBotToken } from './lib/bot-token.ts';
import { collectFacts, diagnose, report } from './check-env.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args: string[]) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });

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

// Credential helper só neste repositório. O valor vazio antes zera os helpers do
// sistema e do usuário (como o osxkeychain), para o push nunca cair na conta do dono.
git('config', '--local', '--unset-all', 'credential.helper');
git('config', '--local', '--add', 'credential.helper', '');
git('config', '--local', '--add', 'credential.helper', `!node "${join(root, 'scripts', 'git-credential-bot.ts')}"`);

// MCP no escopo local: fica no ~/.claude.json só para este clone, não vai para a
// nuvem (que tem o próprio GitHub) e guarda só o comando do helper, nunca o token.
spawnSync('claude', ['mcp', 'remove', '--scope', 'local', 'github'], { stdio: 'ignore' });
const server = {
  type: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  headersHelper: `node "${join(root, 'scripts', 'github-mcp-headers.ts')}"`,
};
const added = spawnSync('claude', ['mcp', 'add-json', '--scope', 'local', 'github', JSON.stringify(server)], {
  cwd: root,
  encoding: 'utf8',
});
if (added.status !== 0) {
  console.error(`Não consegui registrar o MCP: ${added.stderr.trim()}`);
  process.exit(1);
}

const results = diagnose(await collectFacts(root));
console.log(report(results));
process.exit(results.every((result) => result.ok) ? 0 : 1);
