import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface GuardInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface Deps {
  reviewBodies(): string[];
}

interface Verdict {
  allow: boolean;
  reason?: string;
}

let check: (input: GuardInput, deps: Deps) => Verdict;

// Import dinâmico: o hook é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
beforeAll(async () => {
  const hookPath = join(import.meta.dirname, 'github-guard.mjs');
  const module = (await import(pathToFileURL(hookPath).href)) as {
    check: typeof check;
  };
  check = module.check;
});

const REPORT = '## Revisão\n\nTudo certo, sem achados.\n';

function deps(...bodies: string[]): Deps {
  return { reviewBodies: () => bodies };
}

function pr(toolInput: Record<string, unknown>): GuardInput {
  return {
    tool_name: 'mcp__github__create_pull_request',
    tool_input: toolInput,
  };
}

function comment(body: unknown): GuardInput {
  return {
    tool_name: 'mcp__github__add_issue_comment',
    tool_input: { issue_number: 3, body },
  };
}

describe('AI-08 github-guard: criação de PR', () => {
  it('AI-08 permite criar PR em rascunho', () => {
    expect(check(pr({ title: 't', draft: true }), deps()).allow).toBe(true);
  });

  it('AI-08 recusa criar PR com draft false, com motivo', () => {
    const verdict = check(pr({ title: 't', draft: false }), deps());

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('AI-08 recusa criar PR sem o campo draft', () => {
    expect(check(pr({ title: 't' }), deps()).allow).toBe(false);
  });

  it.each(['true', 1, null])('AI-08 recusa draft que não é o booleano true (%j)', (draft) => {
    expect(check(pr({ title: 't', draft }), deps()).allow).toBe(false);
  });
});

describe('AI-08 github-guard: comentário de revisão', () => {
  it('AI-08 permite o comentário idêntico a um relatório salvo', () => {
    expect(check(comment(REPORT), deps('## Revisão\n\noutro\n', REPORT)).allow).toBe(true);
  });

  it('AI-08 permite o relatório idêntico com espaços ou linhas em branco antes do título', () => {
    expect(check(comment(`  \n${REPORT}`), deps(REPORT)).allow).toBe(true);
  });

  it('AI-08 recusa comentário de revisão alterado em relação ao relatório salvo, com motivo', () => {
    const verdict = check(comment(`${REPORT}Aprovado!\n`), deps(REPORT));

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('AI-08 recusa comentário de revisão quando não há nenhum relatório salvo', () => {
    expect(check(comment(REPORT), deps()).allow).toBe(false);
  });

  it('AI-08 recusa comentário de revisão com espaços iniciais que não bate com nenhum relatório', () => {
    expect(check(comment(`   ${REPORT}x`), deps(REPORT)).allow).toBe(false);
  });

  it('AI-08 comentário comum é recusado, com motivo, mesmo sem relatório salvo', () => {
    const verdict = check(comment('Corrigido no commit abc123.'), deps());

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('AI-08 comentário comum é recusado também quando há relatórios salvos', () => {
    expect(check(comment('Corrigido no commit abc123.'), deps(REPORT)).allow).toBe(false);
  });

  it('AI-08 comentário que só cita "## Revisão" no meio do texto é recusado', () => {
    expect(check(comment('Veja a seção ## Revisão abaixo.'), deps(REPORT)).allow).toBe(false);
  });

  it.each([undefined, null, '', '   \n', 42])('AI-08 comentário com corpo %j é recusado', (body) => {
    expect(check(comment(body), deps(REPORT)).allow).toBe(false);
  });

  it('AI-08 comentário com o relatório mais uma quebra de linha no fim é recusado (só o espaço inicial é ignorado)', () => {
    expect(check(comment(`${REPORT}\n`), deps(REPORT)).allow).toBe(false);
  });

  it('AI-08 comentário que é só um trecho do relatório salvo é recusado', () => {
    expect(check(comment('## Revisão'), deps(REPORT)).allow).toBe(false);
  });

  // Controle negativo: a regra é a identidade com o arquivo, e não o título "## Revisão".
  it('AI-08 permite o comentário idêntico a um relatório salvo que não começa com "## Revisão"', () => {
    expect(check(comment('Relatório sem o título padrão.\n'), deps('Relatório sem o título padrão.\n')).allow).toBe(true);
  });
});

describe('AI-08 github-guard: outras ferramentas', () => {
  it.each(['mcp__github__get_me', 'mcp__github__update_pull_request', 'Bash', 'Read'])('AI-08 %s passa', (toolName) => {
    expect(check({ tool_name: toolName, tool_input: { draft: false, body: REPORT } }, deps()).allow).toBe(true);
  });
});

describe('AI-08 github-guard como processo', () => {
  const hook = join(import.meta.dirname, 'github-guard.mjs');

  function run(raw: string) {
    const result = spawnSync(process.execPath, [hook], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: join(import.meta.dirname, '..', '..') },
    });
    return { code: result.status, stderr: result.stderr };
  }

  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"tool_name": "mcp__github__add_issue_comment", "tool_input": {'],
  ])('AI-08 entrada ilegível recusa com código 2 (%s)', (_label, raw) => {
    const result = run(raw);

    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
  });

  it('AI-08 controle: JSON legível de uma ferramenta sem relação sai com código 0', () => {
    expect(run(JSON.stringify({ tool_name: 'mcp__github__get_me', tool_input: {} })).code).toBe(0);
  });

  it('AI-08 controle: criar PR em rascunho sai com código 0 e fora de rascunho sai com 2', () => {
    const tool = 'mcp__github__create_pull_request';

    expect(run(JSON.stringify({ tool_name: tool, tool_input: { draft: true } })).code).toBe(0);
    expect(run(JSON.stringify({ tool_name: tool, tool_input: { draft: false } })).code).toBe(2);
  });
});
