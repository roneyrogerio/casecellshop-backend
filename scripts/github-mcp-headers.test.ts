import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, git } from '../test/helpers/git-sandbox.ts';
import { isolatedEnv, makeScriptsSandbox, runScript, setFakeCredential } from '../test/helpers/identity-sandbox.ts';

interface HeadersModule {
  GITHUB_TOOLS: readonly string[];
  buildHeaders(token: string): Record<string, string>;
  headersFor(env: { remote: boolean }, token: string | undefined): Record<string, string> | null;
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

describe('AI-08 headersFor decide o que o headersHelper imprime', () => {
  it('AI-08 na nuvem devolve o objeto vazio, mesmo com token', () => {
    expect(mod.headersFor({ remote: true }, 'tok-123')).toEqual({});
    expect(mod.headersFor({ remote: true }, undefined)).toEqual({});
  });

  it('AI-08 na máquina, com token, devolve buildHeaders(token)', () => {
    expect(mod.headersFor({ remote: false }, 'tok-123')).toEqual(mod.buildHeaders('tok-123'));
  });

  it('AI-08 na máquina, sem token, devolve null: o CLI falha sem imprimir cabeçalho', () => {
    expect(mod.headersFor({ remote: false }, undefined)).toBeNull();
    expect(mod.headersFor({ remote: false }, '')).toBeNull();
  });
});

// O CLI de verdade, numa cópia dos scripts em um repositório temporário: nunca no clone real, nunca no chaveiro.
describe('AI-08 o headersHelper (CLI) age como a identidade configurada no clone', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('AI-08 sem identidade configurada falha sem imprimir cabeçalho', () => {
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'github-mcp-headers.ts', []);

    expect(result.status).not.toBe(0);
    // Mede o tamanho, sem imprimir a saída: se um token real vazasse, a mensagem de falha não o mostraria.
    expect(result.stdout.length).toBe(0);
  }, 30_000);

  it('AI-08 no modo self, com a credencial do git guardada, imprime o cabeçalho com esse token', () => {
    const dir = makeScriptsSandbox();
    setFakeCredential(dir, 'tok-self');
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    const result = runScript(dir, 'github-mcp-headers.ts', []);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      Authorization: 'Bearer tok-self',
      'X-MCP-Tools': EXPECTED_TOOLS.join(','),
      'X-MCP-Lockdown': 'true',
    });
  }, 30_000);

  it('AI-08 no modo self, sem credencial guardada, falha sem imprimir cabeçalho', () => {
    const dir = makeScriptsSandbox();
    git(dir, 'config', '--local', 'credential.helper', '');
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    const result = runScript(dir, 'github-mcp-headers.ts', []);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  }, 30_000);

  it('AI-08 na nuvem devolve {} mesmo sem identidade', () => {
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'github-mcp-headers.ts', [], { env: isolatedEnv({ CLAUDE_CODE_REMOTE: 'true' }) });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  }, 30_000);
});
