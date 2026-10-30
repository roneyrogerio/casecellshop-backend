import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface GithubServer {
  type?: unknown;
  url?: unknown;
  headers?: Record<string, unknown>;
  headersHelper?: unknown;
}

interface McpConfig {
  mcpServers?: { github?: GithubServer };
}

let tools: readonly string[];

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(import.meta.dirname, 'github-mcp-headers.ts')).href)) as {
    GITHUB_TOOLS: readonly string[];
  };
  tools = mod.GITHUB_TOOLS;
});

function loadConfig(): McpConfig {
  return JSON.parse(readFileSync(join(import.meta.dirname, '..', '.mcp.json'), 'utf8')) as McpConfig;
}

// Devolve os problemas do servidor github do .mcp.json (AI-08); lista vazia é conformidade.
function problems(config: McpConfig, expectedTools: readonly string[]): string[] {
  const server = config.mcpServers?.github;
  if (!server) return ['servidor github ausente'];
  const found: string[] = [];
  const headers = server.headers ?? {};
  if (server.type !== 'http') found.push('type deve ser http');
  if (server.url !== 'https://api.githubcopilot.com/mcp/') found.push('url fora do MCP oficial do GitHub');
  if (headers['X-MCP-Tools'] !== expectedTools.join(',')) found.push('X-MCP-Tools fora da lista fechada');
  if (headers['X-MCP-Lockdown'] !== 'true') found.push('X-MCP-Lockdown deve ser true');
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')) {
    found.push('Authorization não pode ficar no arquivo');
  }
  if (typeof server.headersHelper !== 'string' || !server.headersHelper.includes('scripts/github-mcp-headers.ts')) {
    found.push('headersHelper deve chamar scripts/github-mcp-headers.ts');
  }
  return found;
}

describe('AI-08 .mcp.json versionado declara o servidor github', () => {
  it('AI-08 o servidor github usa o MCP oficial, a lista fechada, o lockdown e o headersHelper, sem token no arquivo', () => {
    expect(problems(loadConfig(), tools)).toEqual([]);
  });

  it('AI-08 o arquivo declara type http e a url do MCP oficial do GitHub', () => {
    const server = loadConfig().mcpServers?.github;

    expect(server?.type).toBe('http');
    expect(server?.url).toBe('https://api.githubcopilot.com/mcp/');
  });

  it('AI-08 X-MCP-Tools é exatamente GITHUB_TOOLS e o lockdown está ligado', () => {
    const headers = loadConfig().mcpServers?.github?.headers;

    expect(headers?.['X-MCP-Tools']).toBe(tools.join(','));
    expect(headers?.['X-MCP-Lockdown']).toBe('true');
  });

  it('AI-08 nenhum Authorization nos headers: o token nunca fica no arquivo', () => {
    const headers = loadConfig().mcpServers?.github?.headers ?? {};

    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization');
  });

  it('AI-08 o headersHelper aponta para scripts/github-mcp-headers.ts', () => {
    const helper = loadConfig().mcpServers?.github?.headersHelper;

    expect(typeof helper).toBe('string');
    expect(helper as string).toContain('scripts/github-mcp-headers.ts');
  });

  // Controle negativo: a conferência precisa reprovar quem abre uma ferramenta a mais.
  it('AI-08 controle negativo: merge_pull_request acrescentado ao X-MCP-Tools reprova a conferência', () => {
    const config = loadConfig();
    const server = config.mcpServers?.github ?? {};
    const tampered: McpConfig = {
      mcpServers: {
        github: {
          ...server,
          headers: { ...server.headers, 'X-MCP-Tools': [...tools, 'merge_pull_request'].join(',') },
        },
      },
    };

    expect(problems(tampered, tools).length).toBeGreaterThan(0);
  });
});
