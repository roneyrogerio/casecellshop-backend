// headersHelper do servidor MCP oficial do GitHub (AI-08). O Claude Code roda
// este comando a cada conexão e usa a saída como cabeçalhos: o token do bot sai
// do chaveiro só para a conexão, e o próprio servidor do GitHub passa a expor só
// as ferramentas da lista. Merge, aprovação e escrita de arquivo não existem
// para o agente, nem por engano nem por injeção de prompt.
import { pathToFileURL } from 'node:url';
import { readBotToken } from './lib/bot-token.ts';

export const GITHUB_TOOLS = [
  'get_me',
  'pull_request_read',
  'list_pull_requests',
  'create_pull_request',
  'update_pull_request',
  'add_issue_comment',
  'actions_list',
  'actions_get',
  'get_job_logs',
] as const;

export function buildHeaders(token: string): Record<string, string> {
  if (!token) throw new Error('Token do bot vazio: rode npm run setup:local.');
  return {
    Authorization: `Bearer ${token}`,
    'X-MCP-Tools': GITHUB_TOOLS.join(','),
    // Esconde o conteúdo público de issues de quem não tem push, que é a porta
    // de entrada de injeção de prompt vinda de terceiros.
    'X-MCP-Lockdown': 'true',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const token = readBotToken();
  if (!token) {
    // Sem cabeçalho, o servidor recusa a conexão: nunca cai para outra credencial.
    process.stderr.write('Token do bot não encontrado no chaveiro: rode npm run setup:local.\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(buildHeaders(token)));
}
