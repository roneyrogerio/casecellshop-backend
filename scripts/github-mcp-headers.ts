// headersHelper do servidor MCP oficial do GitHub (AI-08). O Claude Code roda
// este comando a cada conexão e usa a saída como cabeçalhos: o token da
// identidade configurada no clone (AI-14) sai só para a conexão, e o próprio servidor do GitHub passa a expor só
// as ferramentas da lista. Merge, aprovação e escrita de arquivo não existem
// para o agente pelo MCP. O token ainda é legível por quem roda código nesta
// máquina (R11): a contenção do chaveiro não é desta peça.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readIdentity, readToken } from './lib/identity.ts';

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
    // Filtra conteúdo de issues de quem não tem push, porta comum de injeção de
    // prompt de terceiros. O próprio GitHub o chama de filtro de melhor esforço,
    // e não de fronteira de segurança.
    'X-MCP-Lockdown': 'true',
  };
}

// O .mcp.json já fixa a lista de ferramentas e o lockdown; o helper só soma o
// token. Na nuvem não há chaveiro, e o token não pode vir de variável de
// ambiente (o Claude Code as tira do helper): devolve {} e a autenticação fica
// com o ambiente da nuvem. Na máquina, sem token, devolve null e o CLI falha
// sem imprimir nada, para a conexão nunca cair em outra credencial.
export function headersFor(
  env: { remote: boolean },
  token: string | undefined,
): Record<string, string> | null {
  if (env.remote) return {};
  return token ? buildHeaders(token) : null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const remote = process.env.CLAUDE_CODE_REMOTE === 'true';
  const root = fileURLToPath(new URL('..', import.meta.url));
  const headers = headersFor(
    { remote },
    remote ? undefined : readToken(readIdentity(root), root),
  );
  if (!headers) {
    process.stderr.write(
      'Sem identidade configurada ou sem token: veja o diagnóstico de início de sessão (npm run check:env).\n',
    );
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(headers));
}
