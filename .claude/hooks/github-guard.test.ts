import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, commitEmpty, git, initRepo, makeTempDir, writeFileIn } from '../../test/helpers/git-sandbox.ts';

afterEach(cleanupTempDirs);

interface GuardInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

interface GitState {
  head: string;
  upstream: string | null;
}

interface Deps {
  reviewBodies(): string[];
  git(): GitState | null;
  securityReviewed(sha: string): boolean;
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

// Dublê neutro: o git responde com HEAD igual ao upstream, mas nenhuma revisão de segurança está registrada.
// Os testes do AI-16 trocam o que importa com `makeDeps`, que também conta as consultas.
function deps(...bodies: string[]): Deps {
  return {
    reviewBodies: () => bodies,
    git: () => ({ head: HEAD_SHA, upstream: HEAD_SHA }),
    securityReviewed: () => false,
  };
}

const HEAD_SHA = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
const OTHER_SHA = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';

interface FakeOptions {
  git?: GitState | null;
  registered?: string[];
}

// `calls` mostra o que o hook consultou, para provar que um caso fora da regra nem olha o git.
function makeDeps(options: FakeOptions = {}) {
  const calls = { git: 0, reviewed: [] as string[], bodies: 0 };
  const state = options.git === undefined ? { head: HEAD_SHA, upstream: HEAD_SHA } : options.git;
  const registered = options.registered ?? [];
  const fake: Deps = {
    reviewBodies: () => {
      calls.bodies += 1;
      return [];
    },
    git: () => {
      calls.git += 1;
      return state;
    },
    securityReviewed: (sha) => {
      calls.reviewed.push(sha);
      return registered.includes(sha);
    },
  };
  return { deps: fake, calls };
}

function undraft(toolInput: Record<string, unknown> = {}): GuardInput {
  return { tool_name: 'mcp__github__update_pull_request', tool_input: { pullNumber: 3, ...toolInput } };
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
  it.each(['mcp__github__get_me', 'mcp__github__pull_request_read', 'Bash', 'Read'])('AI-08 %s passa', (toolName) => {
    expect(check({ tool_name: toolName, tool_input: { draft: false, body: REPORT } }, deps()).allow).toBe(true);
  });
});

describe('AI-16 github-guard: tirar o PR do rascunho', () => {
  it('AI-16 permite draft false quando o HEAD é igual ao upstream e a revisão de segurança está registrada nele', () => {
    const { deps: fake, calls } = makeDeps({ registered: [HEAD_SHA] });

    const verdict = check(undraft({ draft: false }), fake);

    expect(verdict.allow).toBe(true);
    expect(calls.reviewed).toContain(HEAD_SHA);
  });

  it.each([
    ['sem upstream', null],
    ['com o upstream em outro commit', OTHER_SHA],
  ])('AI-16 recusa draft false %s, e o motivo manda fazer push', (_label, upstream) => {
    const { deps: fake } = makeDeps({ git: { head: HEAD_SHA, upstream }, registered: [HEAD_SHA, OTHER_SHA] });

    const verdict = check(undraft({ draft: false }), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toMatch(/push/i);
  });

  it('AI-16 recusa draft false sem registro do HEAD, e o motivo cita /security-review e o SHA', () => {
    const { deps: fake } = makeDeps({ registered: [] });

    const verdict = check(undraft({ draft: false }), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('/security-review');
    expect(verdict.reason).toContain(HEAD_SHA);
  });

  // O registro é do HEAD que o dono vai ler: o de outro commit não vale.
  it('AI-16 recusa draft false quando só outro SHA tem registro', () => {
    const { deps: fake } = makeDeps({ registered: [OTHER_SHA] });

    const verdict = check(undraft({ draft: false }), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('/security-review');
  });

  it('AI-16 recusa draft false quando o git não responde', () => {
    const { deps: fake } = makeDeps({ git: null, registered: [HEAD_SHA] });

    const verdict = check(undraft({ draft: false }), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  // Controle negativo: o que não tira o PR do rascunho passa sem olhar o git nem o registro.
  it.each([
    ['sem o campo draft', { title: 'novo título' }],
    ['com draft true', { draft: true }],
  ])('AI-16 update_pull_request %s passa sem consultar o git nem o registro', (_label, toolInput) => {
    const { deps: fake, calls } = makeDeps({ git: null });

    const verdict = check(undraft(toolInput), fake);

    expect(verdict.allow).toBe(true);
    expect(calls.git).toBe(0);
    expect(calls.reviewed).toEqual([]);
  });

  it('AI-16 o nome da ferramenta só precisa terminar em __update_pull_request', () => {
    const { deps: fake } = makeDeps({ registered: [] });

    const verdict = check(
      { tool_name: 'mcp__outro_servidor__update_pull_request', tool_input: { draft: false } },
      fake,
    );

    expect(verdict.allow).toBe(false);
  });

  it('AI-16 controle: a ferramenta update_pull_request_branch não cai nessa regra', () => {
    const { deps: fake, calls } = makeDeps({ git: null });

    const verdict = check(
      { tool_name: 'mcp__github__update_pull_request_branch', tool_input: { draft: false } },
      fake,
    );

    expect(verdict.allow).toBe(true);
    expect(calls.git).toBe(0);
  });
});

describe('AI-16 github-guard: comentário do relatório de segurança', () => {
  const SECURITY = '## Revisão de segurança\n\nNenhum achado bloqueante.\n';

  it('AI-16 permite o comentário que começa com "## Revisão de segurança" quando o HEAD tem registro', () => {
    const { deps: fake, calls } = makeDeps({ registered: [HEAD_SHA] });

    const verdict = check(comment(SECURITY), fake);

    expect(verdict.allow).toBe(true);
    expect(calls.reviewed).toContain(HEAD_SHA);
  });

  it('AI-16 permite o mesmo comentário com espaço ou linhas em branco antes do título', () => {
    const { deps: fake } = makeDeps({ registered: [HEAD_SHA] });

    expect(check(comment(`  \n${SECURITY}`), fake).allow).toBe(true);
  });

  it('AI-16 recusa o comentário de segurança sem registro do HEAD, com motivo que cita /security-review', () => {
    const { deps: fake } = makeDeps({ registered: [] });

    const verdict = check(comment(SECURITY), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain('/security-review');
  });

  it('AI-16 recusa o comentário de segurança quando só outro SHA tem registro', () => {
    const { deps: fake } = makeDeps({ registered: [OTHER_SHA] });

    expect(check(comment(SECURITY), fake).allow).toBe(false);
  });

  it('AI-16 recusa o comentário de segurança quando o git não responde', () => {
    const { deps: fake } = makeDeps({ git: null, registered: [HEAD_SHA] });

    const verdict = check(comment(SECURITY), fake);

    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it('AI-16 o comentário de segurança vale mesmo com o upstream atrás do HEAD (só o registro do HEAD conta)', () => {
    const { deps: fake } = makeDeps({ git: { head: HEAD_SHA, upstream: null }, registered: [HEAD_SHA] });

    expect(check(comment(SECURITY), fake).allow).toBe(true);
  });

  // Controles negativos: o registro não abre a porta para qualquer comentário.
  it.each([
    ['comentário comum', 'Corrigido no commit abc123.'],
    ['título só no meio do texto', 'Veja a seção ## Revisão de segurança abaixo.'],
    ['título sem acento', '## Revisao de seguranca\n\nok\n'],
    ['título de outro relatório', '## Revisão\n\nok\n'],
    ['corpo vazio', ''],
    ['corpo que não é texto', 42],
    ['corpo ausente', undefined],
  ])('AI-16 com o HEAD registrado, o comentário %s continua recusado', (_label, body) => {
    const { deps: fake } = makeDeps({ registered: [HEAD_SHA] });

    expect(check(comment(body), fake).allow).toBe(false);
  });

  it('AI-16 o comentário do relatório do reviewer idêntico ao arquivo salvo segue valendo sem registro de segurança', () => {
    const { deps: fake } = makeDeps({ registered: [] });
    const withBodies: Deps = { ...fake, reviewBodies: () => [REPORT] };

    expect(check(comment(REPORT), withBodies).allow).toBe(true);
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

// AI-16 com git de verdade: o hook lê o HEAD, o upstream e o registro do projeto em que roda.
describe('AI-16 github-guard como processo, com um repositório git de verdade', () => {
  const hook = join(import.meta.dirname, 'github-guard.mjs');

  function runIn(project: string, input: unknown) {
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      cwd: project,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
    });
    return { code: result.status, stderr: result.stderr };
  }

  // Repositório com um commit, remoto bare e a branch main publicada com -u (o upstream existe e é o HEAD).
  function setup() {
    const project = makeTempDir('ai16-guard-');
    initRepo(project);
    const bare = makeTempDir('ai16-bare-');
    git(bare, 'init', '-q', '--bare');
    git(project, 'remote', 'add', 'origin', bare);
    git(project, 'push', '-q', '-u', 'origin', 'main');
    return { project, head: git(project, 'rev-parse', 'HEAD').trim() };
  }

  function register(project: string, sha: string): void {
    writeFileIn(project, `.claude/state/security-review/${sha}`, '');
  }

  const READY = { tool_name: 'mcp__github__update_pull_request', tool_input: { pullNumber: 3, draft: false } };

  it('AI-16 tirar do rascunho com o HEAD publicado e registrado sai com código 0', () => {
    const { project, head } = setup();
    register(project, head);

    expect(runIn(project, READY).code).toBe(0);
  });

  it('AI-16 controle: sem registro do HEAD sai com código 2 e o stderr cita /security-review e o SHA', () => {
    const { project, head } = setup();

    const result = runIn(project, READY);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('/security-review');
    expect(result.stderr).toContain(head);
  });

  it('AI-16 controle: com um commit local ainda não publicado sai com código 2 e o stderr manda fazer push', () => {
    const { project, head } = setup();
    register(project, head);
    commitEmpty(project);
    register(project, git(project, 'rev-parse', 'HEAD').trim());

    const result = runIn(project, READY);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/push/i);
  });

  it('AI-16 controle: numa branch sem upstream sai com código 2', () => {
    const { project } = setup();
    git(project, 'checkout', '-q', '-b', 'sem-upstream');
    register(project, git(project, 'rev-parse', 'HEAD').trim());

    expect(runIn(project, READY).code).toBe(2);
  });

  it('AI-16 controle: fora de um repositório git sai com código 2', () => {
    const project = makeTempDir('ai16-sem-git-');

    expect(runIn(project, READY).code).toBe(2);
  });

  it('AI-16 controle: update_pull_request em rascunho sai com 0 mesmo fora de um repositório git', () => {
    const project = makeTempDir('ai16-sem-git-');

    expect(runIn(project, { tool_name: READY.tool_name, tool_input: { pullNumber: 3, draft: true } }).code).toBe(0);
  });

  it('AI-16 o comentário "## Revisão de segurança" sai com 0 só quando o HEAD tem registro', () => {
    const { project, head } = setup();
    const input = {
      tool_name: 'mcp__github__add_issue_comment',
      tool_input: { issue_number: 3, body: '## Revisão de segurança\n\nsem achados\n' },
    };

    expect(runIn(project, input).code).toBe(2);
    register(project, head);
    expect(runIn(project, input).code).toBe(0);
  });
});
