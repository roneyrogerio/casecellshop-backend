import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface HeadersModule {
  GITHUB_TOOLS: readonly string[];
  buildHeaders(token: string): Record<string, string>;
}

let mod: HeadersModule;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  mod = (await import(pathToFileURL(join(import.meta.dirname, 'github-mcp-headers.ts')).href)) as HeadersModule;
});

const EXPECTED_TOOLS = [
  'get_me',
  'pull_request_read',
  'list_pull_requests',
  'create_pull_request',
  'update_pull_request',
  'add_issue_comment',
  'actions_list',
  'actions_get',
  'get_job_logs',
];

describe('AI-08 cabeçalhos do MCP do GitHub (headersHelper)', () => {
  it('AI-08 a lista fechada tem exatamente as nove ferramentas do fluxo, sem o prefixo mcp__github__', () => {
    expect([...mod.GITHUB_TOOLS].sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(mod.GITHUB_TOOLS.some((tool) => tool.startsWith('mcp__'))).toBe(false);
  });

  it.each([
    'merge_pull_request',
    'pull_request_review_write',
    'update_pull_request_branch',
    'create_or_update_file',
    'push_files',
    'delete_file',
    'issue_write',
    'actions_run_trigger',
  ])('AI-08 a lista não oferece %s', (tool) => {
    expect(mod.GITHUB_TOOLS).not.toContain(tool);
  });

  it('AI-08 buildHeaders devolve Authorization Bearer, a lista em X-MCP-Tools e o lockdown ligado', () => {
    expect(mod.buildHeaders('tok-123')).toEqual({
      Authorization: 'Bearer tok-123',
      'X-MCP-Tools': mod.GITHUB_TOOLS.join(','),
      'X-MCP-Lockdown': 'true',
    });
  });

  it('AI-08 o token entra no Authorization sem alteração (controle negativo: outro token, outro cabeçalho)', () => {
    const first = mod.buildHeaders('aaa');
    const second = mod.buildHeaders('bbb');

    expect(first.Authorization).toBe('Bearer aaa');
    expect(second.Authorization).toBe('Bearer bbb');
    expect(first['X-MCP-Tools']).toBe(second['X-MCP-Tools']);
  });

  it('AI-08 buildHeaders com token vazio lança erro, sem devolver cabeçalho', () => {
    expect(() => mod.buildHeaders('')).toThrow(/./);
  });
});
