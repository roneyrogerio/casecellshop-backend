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

  it('AI-08 comentário comum passa, mesmo sem relatório salvo', () => {
    expect(check(comment('Corrigido no commit abc123.'), deps()).allow).toBe(true);
  });

  it('AI-08 comentário que só cita "## Revisão" no meio do texto passa', () => {
    expect(check(comment('Veja a seção ## Revisão abaixo.'), deps()).allow).toBe(true);
  });
});

describe('AI-08 github-guard: outras ferramentas', () => {
  it.each(['mcp__github__get_me', 'mcp__github__update_pull_request', 'Bash', 'Read'])('AI-08 %s passa', (toolName) => {
    expect(check({ tool_name: toolName, tool_input: { draft: false, body: REPORT } }, deps()).allow).toBe(true);
  });
});
