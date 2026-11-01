import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

interface CheckResult {
  ok: boolean;
  output: string;
}

interface Deps {
  // O `cwd` é onde a checagem roda: a worktree do agente (AI-27).
  runCheck(name: string, cwd?: string): Promise<CheckResult>;
  readCount(key: string): number;
  writeCount(key: string, n: number): void;
  // Os arquivos mudados na worktree do agente (ou na pasta principal, para quem não tem worktree).
  changedFiles(): string[];
  scriptsChanged(): boolean;
  gitChanges(): string[];
  // AI-28: o que mudou na pasta principal durante a execução do agente.
  mainChanges(): string[];
}

interface StopInput {
  agent_type?: string;
  agent_id: string;
  session_id: string;
  stop_hook_active?: boolean;
  cwd?: string;
}

interface Decision {
  action: 'allow' | 'block' | 'exception';
  message?: string;
}

let decide: (input: StopInput, deps: Deps) => Promise<Decision>;

// Import dinâmico: o hook é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
beforeAll(async () => {
  const hookPath = join(import.meta.dirname, 'subagent-stop.mjs');
  const module = (await import(pathToFileURL(hookPath).href)) as { decide: typeof decide };
  decide = module.decide;
});

// Dublê das dependências: `failing` mapeia o nome da checagem à saída que ela imprime ao falhar.
// `changed` são os caminhos que o `git status --porcelain` mostraria; `scriptsChanged` diz se o bloco `scripts` do package.json mudou.
function makeDeps(
  failing: Record<string, string> = {},
  counts: Record<string, number> = {},
  git: { changed?: string[]; scriptsChanged?: boolean; gitChanges?: string[]; mainChanges?: string[] } = {},
) {
  const ran: string[] = [];
  const ranIn: [string, string | undefined][] = [];
  const reads: string[] = [];
  const writes: [string, number][] = [];
  const deps: Deps = {
    runCheck: (name, cwd) => {
      ran.push(name);
      ranIn.push([name, cwd]);
      const output = failing[name];
      return Promise.resolve(output === undefined ? { ok: true, output: `SAIDA-OK-${name}` } : { ok: false, output });
    },
    readCount: (key) => {
      reads.push(key);
      return counts[key] ?? 0;
    },
    writeCount: (key, n) => {
      writes.push([key, n]);
      counts[key] = n;
    },
    changedFiles: () => git.changed ?? [],
    scriptsChanged: () => git.scriptsChanged ?? false,
    // O que mudou no HEAD, nos refs, nas worktrees e no .git/config desde o início do agente (AI-12).
    gitChanges: () => git.gitChanges ?? [],
    // O que mudou na pasta principal durante a execução do agente (AI-28, AI-29).
    mainChanges: () => git.mainChanges ?? [],
  };
  return { deps, ran, ranIn, reads, writes, counts };
}

function stop(agentType: string | undefined, extra: Partial<StopInput> = {}): StopInput {
  return {
    ...(agentType ? { agent_type: agentType } : {}),
    agent_id: 'ag-1',
    session_id: 'sess-1',
    ...extra,
  };
}

const KEY = 'sess-1:ag-1';

describe('AI-03 hook de parada devolve o agente ao trabalho enquanto a verificação falhar', () => {
  it('AI-03 o implementer roda lint, typecheck e test:changed', async () => {
    const { deps, ran } = makeDeps();

    await decide(stop('implementer'), deps);

    expect([...ran].sort()).toEqual(['lint', 'test:changed', 'typecheck']);
  });

  it('AI-03 o test-writer roda só lint e typecheck', async () => {
    const { deps, ran } = makeDeps();

    await decide(stop('test-writer'), deps);

    expect([...ran].sort()).toEqual(['lint', 'typecheck']);
  });

  it.each(['reviewer', 'general-purpose', 'Explore'])(
    'AI-03 o agente %s não roda checagem e é liberado',
    async (agentType) => {
      const { deps, ran } = makeDeps({ lint: 'erro', typecheck: 'erro', 'test:changed': 'erro' });

      const decision = await decide(stop(agentType), deps);

      expect(decision.action).toBe('allow');
      expect(ran).toEqual([]);
    },
  );

  it('AI-03 uma parada sem agent_type não roda checagem e é liberada', async () => {
    const { deps, ran } = makeDeps({ lint: 'erro' });

    const decision = await decide(stop(undefined), deps);

    expect(decision.action).toBe('allow');
    expect(ran).toEqual([]);
  });

  it.each(['implementer', 'test-writer'])(
    'AI-03 o %s com todas as checagens ok é liberado e zera o contador',
    async (agentType) => {
      const { deps, writes } = makeDeps({}, { [KEY]: 2 });

      const decision = await decide(stop(agentType), deps);

      expect(decision.action).toBe('allow');
      expect(writes).toContainEqual([KEY, 0]);
    },
  );

  it.each([0, 1, 2])(
    'AI-03 o implementer com lint falhando e contador em %i é devolvido ao trabalho e o contador sobe',
    async (count) => {
      const { deps, writes } = makeDeps({ lint: 'src/x.ts: no-unused-vars' }, { [KEY]: count });

      const decision = await decide(stop('implementer'), deps);

      expect(decision.action).toBe('block');
      expect(decision.message).toContain('lint');
      expect(decision.message).toContain('src/x.ts: no-unused-vars');
      expect(writes).toContainEqual([KEY, count + 1]);
    },
  );

  it('AI-03 a mensagem cita o nome e a saída de cada checagem que falhou, e só dessas', async () => {
    const { deps } = makeDeps({ typecheck: 'TS2322 tipo errado', 'test:changed': 'FAIL src/a.test.ts' });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('typecheck');
    expect(decision.message).toContain('TS2322 tipo errado');
    expect(decision.message).toContain('test:changed');
    expect(decision.message).toContain('FAIL src/a.test.ts');
    expect(decision.message).not.toContain('SAIDA-OK-lint');
  });

  it('AI-03 o implementer é devolvido quando só test:changed falha', async () => {
    const { deps } = makeDeps({ 'test:changed': 'FAIL src/a.test.ts' });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('test:changed');
  });

  it('AI-03 o test-writer é devolvido enquanto o typecheck falhar', async () => {
    const { deps, writes } = makeDeps({ typecheck: 'TS2307 módulo não encontrado' });

    const decision = await decide(stop('test-writer'), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('typecheck');
    expect(decision.message).toContain('TS2307 módulo não encontrado');
    expect(writes).toContainEqual([KEY, 1]);
  });

  it.each([3, 4, 10])(
    'AI-03 com a falha persistindo e contador em %i o agente é liberado como exceção, sem incrementar',
    async (count) => {
      const { deps, counts } = makeDeps({ lint: 'erro de lint' }, { [KEY]: count });

      const decision = await decide(stop('implementer'), deps);

      expect(decision.action).toBe('exception');
      expect(decision.message).toContain('exceção');
      expect(decision.message).toContain('sessão principal');
      expect(counts[KEY]).toBe(count);
    },
  );

  it('AI-03 na quarta parada do mesmo agente ele é liberado como exceção', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' });

    const actions: string[] = [];
    for (let stops = 0; stops < 4; stops += 1) actions.push((await decide(stop('implementer'), deps)).action);

    expect(actions).toEqual(['block', 'block', 'block', 'exception']);
  });

  it('AI-03 uma checagem que volta a passar zera o contador e a contagem recomeça', async () => {
    const failing: Record<string, string> = { lint: 'erro de lint' };
    const { deps, counts } = makeDeps(failing);

    await decide(stop('implementer'), deps);
    await decide(stop('implementer'), deps);
    expect(counts[KEY]).toBe(2);

    delete failing.lint;
    expect((await decide(stop('implementer'), deps)).action).toBe('allow');
    expect(counts[KEY]).toBe(0);

    failing.lint = 'erro de lint';
    expect((await decide(stop('implementer'), deps)).action).toBe('block');
    expect(counts[KEY]).toBe(1);
  });

  it('AI-03 o contador é por session_id:agent_id', async () => {
    const { deps, reads, writes } = makeDeps({ lint: 'erro' }, { 'sess-1:ag-1': 3 });

    const exhausted = await decide(stop('implementer'), deps);
    const other = await decide(stop('implementer', { agent_id: 'ag-2' }), deps);
    const otherSession = await decide(stop('implementer', { session_id: 'sess-2' }), deps);

    expect(exhausted.action).toBe('exception');
    expect(other.action).toBe('block');
    expect(otherSession.action).toBe('block');
    expect(reads).toEqual(expect.arrayContaining(['sess-1:ag-1', 'sess-1:ag-2', 'sess-2:ag-1']));
    expect(writes).toContainEqual(['sess-1:ag-2', 1]);
    expect(writes).toContainEqual(['sess-2:ag-1', 1]);
  });

  it('AI-03 stop_hook_active verdadeiro não muda a decisão de devolver', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' }, { [KEY]: 1 });

    const decision = await decide(stop('implementer', { stop_hook_active: true }), deps);

    expect(decision.action).toBe('block');
  });

  it('AI-03 stop_hook_active verdadeiro não muda a decisão de exceção', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' }, { [KEY]: 3 });

    const decision = await decide(stop('implementer', { stop_hook_active: true }), deps);

    expect(decision.action).toBe('exception');
  });

  it('AI-03 stop_hook_active verdadeiro ainda roda as checagens e libera quando passam', async () => {
    const { deps, ran } = makeDeps();

    const decision = await decide(stop('implementer', { stop_hook_active: true }), deps);

    expect(decision.action).toBe('allow');
    expect(ran).toHaveLength(3);
  });
});

const IMPLEMENTER_FORBIDDEN_CHANGES = [
  'src/novo.test.ts',
  'src/checkout/reserve.test.ts',
  'scripts/check-env.test.ts',
  'test/integration/checkout/foo.test.ts',
  'test/helpers/clock.ts',
  'test/fixtures/dados.json',
  '.github/workflows/ci.yml',
  'scripts/check-env.ts',
  '.claude/settings.json',
  '.specs/features/casecellshop/spec.md',
  'src/contract/health.ts',
  'openapi.yaml',
  'tsconfig.json',
  'src/tsconfig.json',
  '.oxlintrc.json',
  'vitest.config.ts',
  'commitlint.config.mjs',
  '.npmrc',
  '.gitignore',
  '.mcp.json',
  'CLAUDE.md',
  'src/x/AGENTS.md',
  '.githooks/pre-push',
  '.githooks/commit-msg',
  '.githooks/post-commit',
  '.git/config',
  '.git/hooks/pre-commit',
];

describe('AI-03 o implementer é devolvido quando o git status mostra arquivo fora do papel dele', () => {
  it.each(IMPLEMENTER_FORBIDDEN_CHANGES)(
    'AI-03 o implementer com %s alterado é devolvido, com o caminho na mensagem, mesmo com as checagens ok',
    async (file) => {
      const { deps, writes } = makeDeps({}, {}, { changed: ['src/checkout/reserve.ts', file] });

      const decision = await decide(stop('implementer'), deps);

      expect(decision.action).toBe('block');
      expect(decision.message).toContain(file);
      expect(writes).toContainEqual([KEY, 1]);
    },
  );

  // Controle negativo: o que o implementer pode escrever não o devolve.
  it('AI-03 o implementer que só alterou src/, migrations/ e package.json é liberado', async () => {
    const { deps, writes } = makeDeps(
      {},
      { [KEY]: 2 },
      { changed: ['src/checkout/reserve.ts', 'migrations/store/001_x.ts', 'package.json'] },
    );

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('allow');
    expect(writes).toContainEqual([KEY, 0]);
  });

  it('AI-03 o implementer com o npm passando e só src/ alterado é liberado', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/app.ts'] });

    expect((await decide(stop('implementer'), deps)).action).toBe('allow');
  });

  it('AI-03 o implementer sem arquivo alterado é liberado', async () => {
    const { deps } = makeDeps({}, {}, { changed: [] });

    expect((await decide(stop('implementer'), deps)).action).toBe('allow');
  });

  it('AI-03 a devolução por arquivo fora do papel conta no mesmo contador, com teto de 3', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/a.test.ts'] });

    const actions: string[] = [];
    for (let stops = 0; stops < 4; stops += 1) actions.push((await decide(stop('implementer'), deps)).action);

    expect(actions).toEqual(['block', 'block', 'block', 'exception']);
  });

  it('AI-03 a devolução por arquivo fora do papel soma com a de lint no mesmo contador', async () => {
    const failing: Record<string, string> = { lint: 'erro' };
    const { deps, counts } = makeDeps(failing, {}, { changed: ['src/a.test.ts'] });

    await decide(stop('implementer'), deps);
    expect(counts[KEY]).toBe(1);
    delete failing.lint;
    await decide(stop('implementer'), deps);
    expect(counts[KEY]).toBe(2);
  });

  it('AI-03 a mensagem cita o lint e o arquivo fora do papel quando os dois acontecem', async () => {
    const { deps } = makeDeps({ lint: 'src/x.ts: no-unused-vars' }, {}, { changed: ['test/helpers/clock.ts'] });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('src/x.ts: no-unused-vars');
    expect(decision.message).toContain('test/helpers/clock.ts');
  });

  it('AI-03 depois do teto, o arquivo fora do papel vira exceção e aparece na mensagem', async () => {
    const { deps } = makeDeps({}, { [KEY]: 3 }, { changed: ['test/helpers/clock.ts'] });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('exception');
    expect(decision.message).toContain('test/helpers/clock.ts');
  });

  it('AI-03 outros agentes não são devolvidos por arquivo alterado', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/a.test.ts', '.github/workflows/ci.yml'], scriptsChanged: true });

    expect((await decide(stop('reviewer'), deps)).action).toBe('allow');
    expect((await decide(stop('general-purpose'), deps)).action).toBe('allow');
    expect((await decide(stop(undefined), deps)).action).toBe('allow');
  });
});

describe('AI-03 o implementer é devolvido quando muda o bloco scripts do package.json', () => {
  it('AI-03 com o bloco scripts alterado é devolvido, com a menção a scripts, mesmo com as checagens ok', async () => {
    const { deps, writes } = makeDeps({}, {}, { changed: ['package.json'], scriptsChanged: true });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('scripts');
    expect(writes).toContainEqual([KEY, 1]);
  });

  it('AI-03 com package.json alterado mas o bloco scripts igual (outra dependência) é liberado', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['package.json'], scriptsChanged: false });

    expect((await decide(stop('implementer'), deps)).action).toBe('allow');
  });

  it('AI-03 a devolução por scripts respeita o teto de 3', async () => {
    const { deps } = makeDeps({}, {}, { scriptsChanged: true });

    const actions: string[] = [];
    for (let stops = 0; stops < 4; stops += 1) actions.push((await decide(stop('implementer'), deps)).action);

    expect(actions).toEqual(['block', 'block', 'block', 'exception']);
  });
});

describe('AI-03 o test-writer é devolvido quando altera arquivo fora dos testes', () => {
  it.each(['src/app.ts', 'src/contract/health.ts', 'package.json', '.specs/features/casecellshop/spec.md', 'openapi.yaml'])(
    'AI-03 o test-writer com %s alterado é devolvido, com o caminho na mensagem',
    async (file) => {
      const { deps, writes } = makeDeps({}, {}, { changed: ['src/x.test.ts', file] });

      const decision = await decide(stop('test-writer'), deps);

      expect(decision.action).toBe('block');
      expect(decision.message).toContain(file);
      expect(writes).toContainEqual([KEY, 1]);
    },
  );

  it('AI-03 o test-writer que alterou código de produção é devolvido e a mensagem cita o caminho', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/app.ts'] });

    const decision = await decide(stop('test-writer', { agent_id: 'a1', session_id: 's1' }), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('src/app.ts');
  });

  it('AI-03 o test-writer que só alterou test/helpers/ e *.test.ts em src/ é liberado', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['test/helpers/clock.ts', 'src/app.test.ts'] });

    expect((await decide(stop('test-writer'), deps)).action).toBe('allow');
  });

  it('AI-03 o test-writer que só alterou *.test.ts e test/ é liberado', async () => {
    const { deps } = makeDeps(
      {},
      {},
      {
        changed: [
          'src/checkout/reserve.test.ts',
          'scripts/x.test.ts',
          '.claude/hooks/y.test.ts',
          'test/integration/checkout/a.test.ts',
          'test/helpers/clock.ts',
          'test/fixtures/dados.json',
        ],
      },
    );

    expect((await decide(stop('test-writer'), deps)).action).toBe('allow');
  });

  it('AI-03 a devolução do test-writer por arquivo fora dos testes respeita o teto de 3', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/app.ts'] });

    const actions: string[] = [];
    for (let stops = 0; stops < 4; stops += 1) actions.push((await decide(stop('test-writer'), deps)).action);

    expect(actions).toEqual(['block', 'block', 'block', 'exception']);
  });

  it('AI-03 o test-writer não é devolvido por scripts alterados quando o único arquivo é de teste', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/x.test.ts'], scriptsChanged: false });

    expect((await decide(stop('test-writer'), deps)).action).toBe('allow');
  });
});

const GIT_CHANGES = ['HEAD: de aaa111 para bbb222', 'refs: refs/heads/feature/x adicionado'];

describe('AI-12 o hook de parada deixa terminar e registra a exceção quando o estado do git mudou', () => {
  it.each(['implementer', 'test-writer', 'reviewer'])(
    'AI-12 o %s com o estado do git alterado vira exceção já na primeira parada, com cada mudança na mensagem',
    async (agentType) => {
      const { deps, writes } = makeDeps({}, {}, { gitChanges: GIT_CHANGES });

      const decision = await decide(stop(agentType), deps);

      expect(decision.action).toBe('exception');
      expect(decision.message).toContain('estado do git');
      for (const change of GIT_CHANGES) expect(decision.message).toContain(change);
      expect(writes.filter(([, n]) => n > 0)).toEqual([]);
    },
  );

  it('AI-12 o implementer com o estado do git alterado não é devolvido, mesmo com o lint falhando', async () => {
    const { deps } = makeDeps({ lint: 'src/x.ts: no-unused-vars' }, {}, { gitChanges: GIT_CHANGES });

    const decision = await decide(stop('implementer'), deps);

    expect(decision.action).toBe('exception');
    expect(decision.message).toContain('refs/heads/feature/x');
  });

  it('AI-12 o reviewer com uma única mudança também vira exceção, e ela aparece na mensagem', async () => {
    const { deps } = makeDeps({}, {}, { gitChanges: ['config: .git/config alterado'] });

    const decision = await decide(stop('reviewer'), deps);

    expect(decision.action).toBe('exception');
    expect(decision.message).toContain('config: .git/config alterado');
  });

  // Controle negativo: sem mudança, o comportamento anterior continua.
  it.each(['implementer', 'test-writer', 'reviewer'])(
    'AI-12 o %s sem mudança no estado do git e com as checagens ok é liberado',
    async (agentType) => {
      const { deps } = makeDeps({}, {}, { gitChanges: [] });

      const decision = await decide(stop(agentType), deps);

      expect(decision.action).toBe('allow');
      expect(decision.message ?? '').not.toContain('estado do git');
    },
  );

  it('AI-12 o implementer sem mudança no estado do git e com o lint falhando continua sendo devolvido', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' }, {}, { gitChanges: [] });

    expect((await decide(stop('implementer'), deps)).action).toBe('block');
  });
});

const WORKTREE = '/tmp/worktrees/agent-1';

describe('AI-27 na parada de um agente em worktree, as checagens rodam dentro dela', () => {
  it.each([
    ['implementer', ['lint', 'test:changed', 'typecheck']],
    ['test-writer', ['lint', 'typecheck']],
  ])('AI-27 o %s roda cada checagem no cwd da worktree', async (agentType, expected) => {
    const { deps, ranIn } = makeDeps();

    await decide(stop(agentType, { cwd: WORKTREE }), deps);

    expect(ranIn.map(([name]) => name).sort()).toEqual(expected);
    for (const [, cwd] of ranIn) expect(cwd).toBe(WORKTREE);
  });

  // Controle negativo: o cwd vem da entrada de cada parada, e não de um valor fixo.
  it('AI-27 duas worktrees diferentes rodam as checagens cada uma na sua pasta', async () => {
    const { deps, ranIn } = makeDeps();

    await decide(stop('implementer', { cwd: '/wt/um', agent_id: 'a' }), deps);
    await decide(stop('implementer', { cwd: '/wt/dois', agent_id: 'b' }), deps);

    expect(new Set(ranIn.slice(0, 3).map(([, cwd]) => cwd))).toEqual(new Set(['/wt/um']));
    expect(new Set(ranIn.slice(3).map(([, cwd]) => cwd))).toEqual(new Set(['/wt/dois']));
  });

  it('AI-27 o implementer com arquivo fora do papel nos arquivos mudados da worktree é devolvido', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/ok.ts', 'test/helpers/clock.ts'] });

    const decision = await decide(stop('implementer', { cwd: WORKTREE }), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('test/helpers/clock.ts');
  });

  it('AI-27 o test-writer com código nos arquivos mudados da worktree é devolvido', async () => {
    const { deps } = makeDeps({}, {}, { changed: ['src/x.test.ts', 'src/app.ts'] });

    const decision = await decide(stop('test-writer', { cwd: WORKTREE }), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('src/app.ts');
  });

  it.each([
    ['implementer', ['src/app.ts', 'migrations/store/001_x.ts']],
    ['test-writer', ['src/x.test.ts', 'test/helpers/clock.ts']],
  ])('AI-27 o %s que só mudou arquivos do papel dele na worktree é liberado', async (agentType, changed) => {
    const { deps } = makeDeps({}, {}, { changed });

    expect((await decide(stop(agentType, { cwd: WORKTREE }), deps)).action).toBe('allow');
  });

  it('AI-27 a checagem vermelha na worktree devolve o agente com a saída dela', async () => {
    const { deps } = makeDeps({ lint: 'wt/src/x.ts: no-unused-vars' });

    const decision = await decide(stop('implementer', { cwd: WORKTREE }), deps);

    expect(decision.action).toBe('block');
    expect(decision.message).toContain('wt/src/x.ts: no-unused-vars');
  });
});

describe('AI-28 e AI-29 o que muda na pasta principal durante a execução do agente vira exceção', () => {
  const MAIN_CHANGES = ['src/escrito-fora.ts', 'docs/outro.md'];

  it.each(['implementer', 'test-writer', 'reviewer'])(
    'AI-28 o %s com mudança na pasta principal vira exceção, com cada caminho na mensagem',
    async (agentType) => {
      const { deps } = makeDeps({}, {}, { mainChanges: MAIN_CHANGES });

      const decision = await decide(stop(agentType, { cwd: WORKTREE }), deps);

      expect(decision.action).toBe('exception');
      for (const file of MAIN_CHANGES) expect(decision.message).toContain(file);
    },
  );

  it('AI-28 a exceção vale já na primeira parada, mesmo com o lint falhando', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' }, {}, { mainChanges: MAIN_CHANGES });

    const decision = await decide(stop('implementer', { cwd: WORKTREE }), deps);

    expect(decision.action).toBe('exception');
    expect(decision.message).toContain('src/escrito-fora.ts');
  });

  it('AI-29 o reviewer com uma única mudança na pasta principal vira exceção', async () => {
    const { deps } = makeDeps({}, {}, { mainChanges: ['README.md'] });

    const decision = await decide(stop('reviewer'), deps);

    expect(decision.action).toBe('exception');
    expect(decision.message).toContain('README.md');
  });

  // Controle negativo: sem mudança na pasta principal, o comportamento anterior continua.
  it.each(['implementer', 'test-writer', 'reviewer'])(
    'AI-28 o %s sem mudança na pasta principal e com as checagens ok é liberado',
    async (agentType) => {
      const { deps } = makeDeps({}, {}, { mainChanges: [] });

      expect((await decide(stop(agentType, { cwd: WORKTREE }), deps)).action).toBe('allow');
    },
  );

  it('AI-28 o implementer sem mudança na pasta principal e com o lint falhando continua sendo devolvido', async () => {
    const { deps } = makeDeps({ lint: 'erro de lint' }, {}, { mainChanges: [] });

    expect((await decide(stop('implementer', { cwd: WORKTREE }), deps)).action).toBe('block');
  });
});

describe('AI-30 um erro interno do hook de parada devolve o agente ao trabalho com a mensagem do erro', () => {
  const BOOM = 'quebrou-por-dentro-7f3a';

  type DepName = 'changedFiles' | 'scriptsChanged' | 'gitChanges' | 'mainChanges' | 'runCheck' | 'readCount' | 'writeCount';

  // Cada dependência que lança, no papel que a usa: o readCount só roda com uma checagem vermelha e o writeCount, com todas ok.
  const BREAKABLE: [string, DepName, Record<string, string>][] = [
    ['implementer', 'runCheck', {}],
    ['implementer', 'changedFiles', {}],
    ['implementer', 'scriptsChanged', {}],
    ['implementer', 'gitChanges', {}],
    ['implementer', 'mainChanges', {}],
    ['implementer', 'readCount', { lint: 'erro' }],
    ['implementer', 'writeCount', {}],
    ['test-writer', 'runCheck', {}],
    ['test-writer', 'changedFiles', {}],
    ['test-writer', 'mainChanges', {}],
    ['reviewer', 'gitChanges', {}],
    ['reviewer', 'mainChanges', {}],
  ];

  function breaking(name: DepName, failing: Record<string, string>, mode: 'throw' | 'reject') {
    const { deps } = makeDeps(failing);
    const fired: string[] = [];
    const explode = () => {
      fired.push(name);
      throw new Error(BOOM);
    };
    (deps as unknown as Record<string, unknown>)[name] =
      mode === 'reject' ? () => Promise.reject(new Error(BOOM)).finally(() => fired.push(name)) : explode;
    return { deps, fired };
  }

  it.each(BREAKABLE)('AI-30 o %s com %s lançando é devolvido com o erro, e não liberado', async (agentType, name, failing) => {
    const { deps, fired } = breaking(name, failing, 'throw');

    const decision = await decide(stop(agentType), deps);

    expect(fired).toContain(name);
    expect(decision.action).toBe('block');
    expect(decision.message).toContain(BOOM);
  });

  it.each(['implementer', 'test-writer'])('AI-30 o %s com a checagem rejeitando a promessa é devolvido com o erro', async (agentType) => {
    const { deps, fired } = breaking('runCheck', {}, 'reject');

    const decision = await decide(stop(agentType, { cwd: WORKTREE }), deps);

    expect(fired).toContain('runCheck');
    expect(decision.action).toBe('block');
    expect(decision.message).toContain(BOOM);
  });

  // Controle negativo: sem erro interno, as mesmas entradas seguem sendo liberadas.
  it.each(['implementer', 'test-writer', 'reviewer'])('AI-30 controle: o %s sem erro interno é liberado', async (agentType) => {
    const { deps } = makeDeps();

    expect((await decide(stop(agentType), deps)).action).toBe('allow');
  });
});

// Processo de verdade, só onde o teste prova a fiação ou depende de git e de arquivos de verdade: o hook é um
// script, e o que o Claude Code vê é o código de saída, o stderr e os arquivos. A decisão (devolver, liberar,
// exceção) está nos testes acima, dentro do processo, com dependências falsas.
const hookFile = join(import.meta.dirname, 'subagent-stop.mjs');

interface Sandbox {
  project: string;
  bin: string;
  tmp: string;
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Um `npm` falso no PATH: sai com o código dado e imprime a frase dada.
function makeSandbox(npm: { exit: number; print: string }): Sandbox {
  const base = mkdtempSync(join(tmpdir(), 'ai03-'));
  sandboxes.push(base);
  const bin = join(base, 'bin');
  const project = join(base, 'project');
  const tmp = join(base, 'tmp');
  for (const dir of [bin, project, tmp]) mkdirSync(dir, { recursive: true });
  const fake = join(bin, 'npm');
  writeFileSync(fake, `#!/bin/sh\necho "${npm.print}"\nexit ${npm.exit}\n`);
  chmodSync(fake, 0o755);
  return { project, bin, tmp };
}

function hookEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
    // O contador de devoluções fica em os.tmpdir(): isolado, para uma execução não afetar a outra.
    TMPDIR: sandbox.tmp,
    CLAUDE_PROJECT_DIR: sandbox.project,
  };
}

// Só a parada, sem o retrato do início do agente (AI-12): o caso do retrato ausente.
function runStopOnly(sandbox: Sandbox, input: unknown, raw?: string) {
  const result = spawnSync(process.execPath, [hookFile], {
    input: raw ?? JSON.stringify(input),
    encoding: 'utf8',
    cwd: sandbox.project,
    env: hookEnv(sandbox),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const startFile = join(import.meta.dirname, 'subagent-start.mjs');

// O Claude Code dispara o SubagentStart antes do agente trabalhar e o SubagentStop depois: os testes de processo
// fazem o mesmo, para que o retrato do git (AI-12) exista e o resultado dependa só do que o teste mudou.
function runStart(sandbox: Sandbox, input: unknown) {
  const result = spawnSync(process.execPath, [startFile], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    cwd: sandbox.project,
    env: hookEnv(sandbox),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runHook(sandbox: Sandbox, input: unknown, raw?: string) {
  if (raw === undefined) runStart(sandbox, { ...(input as object), cwd: sandbox.project });
  return runStopOnly(sandbox, input, raw);
}

function gitIn(cwd: string, ...args: string[]): void {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

function git(sandbox: Sandbox, ...args: string[]): void {
  gitIn(sandbox.project, ...args);
}

function writeIn(sandbox: Sandbox, relative: string, content: string): void {
  const file = join(sandbox.project, relative);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content);
}

const IMPLEMENTER_STOP = { agent_type: 'implementer', agent_id: 'a1', session_id: 's1' };

// Repositório com um commit inicial que já tem src/ e test/ e um package.json com scripts. Montado uma vez por
// arquivo (init, add e commit são cinco processos do git) e copiado para cada teste: o teste que muda refs, config ou
// worktree altera a própria cópia, então nenhum teste enxerga o que outro fez.
let templateBase: string;
let templateRepo: string;

beforeAll(() => {
  templateBase = mkdtempSync(join(tmpdir(), 'ai03-template-'));
  templateRepo = join(templateBase, 'repo');
  mkdirSync(join(templateRepo, 'src'), { recursive: true });
  mkdirSync(join(templateRepo, 'test', 'helpers'), { recursive: true });
  gitIn(templateRepo, 'init', '-q');
  writeFileSync(
    join(templateRepo, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { lint: 'oxlint' }, dependencies: {} }, null, 2),
  );
  writeFileSync(join(templateRepo, 'src', 'app.ts'), 'export {};\n');
  writeFileSync(join(templateRepo, 'test', 'helpers', 'clock.ts'), 'export {};\n');
  gitIn(templateRepo, 'add', '-A');
  gitIn(templateRepo, 'commit', '-q', '-m', 'base');
});

afterAll(() => {
  rmSync(templateBase, { recursive: true, force: true });
});

function makeRepo(sandbox: Sandbox): void {
  cpSync(templateRepo, sandbox.project, { recursive: true });
}

describe('AI-03 o hook de parada como processo', () => {
  it('AI-03 o implementer com o npm falhando sai com código 2 e o stderr traz a saída da falha', () => {
    const sandbox = makeSandbox({ exit: 1, print: 'LINT FALHOU' });

    const result = runHook(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('LINT FALHOU');
  });

  it('AI-03 o implementer com o npm passando e fora de um repositório git sai com código 0', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });

    const result = runHook(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('AI-03 o implementer que alterou um teste rastreado sai com código 2 e o stderr cita o caminho, com o npm passando', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...IMPLEMENTER_STOP, cwd: sandbox.project });
    writeIn(sandbox, 'test/helpers/clock.ts', 'export const a = 1;\n');

    const result = runStopOnly(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test/helpers/clock.ts');
  });

  // O git status esconde os arquivos de uma pasta nova atrás do nome da pasta, a menos que liste todos.
  it('AI-03 o implementer que criou um teste dentro de uma pasta nova sai com código 2 e o stderr cita o arquivo', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...IMPLEMENTER_STOP, cwd: sandbox.project });
    writeIn(sandbox, 'test/integration/checkout/novo.test.ts', 'export {};\n');

    const result = runStopOnly(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('test/integration/checkout/novo.test.ts');
  });

  it('AI-03 o implementer que mudou o bloco scripts do package.json sai com código 2', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    writeIn(sandbox, 'package.json', JSON.stringify({ name: 'x', scripts: { lint: 'true' }, dependencies: {} }, null, 2));

    const result = runHook(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('scripts');
  });

  it('AI-03 o implementer que mudou só as dependências do package.json sai com código 0', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    writeIn(
      sandbox,
      'package.json',
      JSON.stringify({ name: 'x', scripts: { lint: 'oxlint' }, dependencies: { zod: '4.6.7' } }, null, 2),
    );

    expect(runHook(sandbox, IMPLEMENTER_STOP).code).toBe(0);
  });

  it('AI-03 a entrada ilegível sai com código 2 e o stderr avisa', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });

    for (const raw of ['isto não é json', '', '{"agent_type": "implementer", "agent_id": ']) {
      const result = runStopOnly(sandbox, undefined, raw);

      expect(result.code).toBe(2);
      expect(result.stderr).not.toBe('');
    }
  });
});

describe('AI-03 o hook de parada grava o relatório do reviewer', () => {
  const REPORT = '## Revisão 2\ntexto';

  it('AI-03 ao fim do reviewer, grava .claude/reviews/<agent_id>.md com exatamente a mensagem final e sai com 0', () => {
    const sandbox = makeSandbox({ exit: 1, print: 'não devia rodar' });

    const result = runHook(sandbox, {
      agent_type: 'reviewer',
      agent_id: 'r1',
      session_id: 's1',
      last_assistant_message: REPORT,
    });

    expect(result.code).toBe(0);
    expect(readFileSync(join(sandbox.project, '.claude', 'reviews', 'r1.md'), 'utf8')).toBe(REPORT);
  });

  it('AI-03 a mensagem do reviewer é gravada sem alteração, com acentos, linhas em branco e quebra final', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    const exact = '## Revisão 3\n\n- achado: não corrigido (rodada 2)\n\n```ts\nconst a = `x`;\n```\n';

    runHook(sandbox, { agent_type: 'reviewer', agent_id: 'r9', session_id: 's1', last_assistant_message: exact });

    expect(readFileSync(join(sandbox.project, '.claude', 'reviews', 'r9.md'), 'utf8')).toBe(exact);
  });

  it('AI-03 um agent_id com barras não escreve fora de .claude/reviews/', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });

    const result = runHook(sandbox, {
      agent_type: 'reviewer',
      agent_id: '../../evil',
      session_id: 's1',
      last_assistant_message: REPORT,
    });

    expect(result.code).toBe(0);
    expect(existsSync(join(sandbox.project, 'evil.md'))).toBe(false);
    expect(existsSync(join(sandbox.project, '..', 'evil.md'))).toBe(false);
    const saved = readdirSync(join(sandbox.project, '.claude', 'reviews'));
    expect(saved).toHaveLength(1);
    expect(readFileSync(join(sandbox.project, '.claude', 'reviews', saved[0] ?? ''), 'utf8')).toBe(REPORT);
  });

  it('AI-03 controle: o implementer, o test-writer e o agente sem tipo não gravam relatório', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });

    for (const agentType of ['implementer', 'test-writer', undefined]) {
      runHook(sandbox, {
        ...(agentType ? { agent_type: agentType } : {}),
        agent_id: 'x1',
        session_id: 's1',
        last_assistant_message: REPORT,
      });
    }

    expect(existsSync(join(sandbox.project, '.claude', 'reviews'))).toBe(false);
  });

  it('AI-03 o reviewer sem last_assistant_message sai com 0 e não grava arquivo', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });

    const result = runHook(sandbox, { agent_type: 'reviewer', agent_id: 'r2', session_id: 's1' });

    expect(result.code).toBe(0);
    expect(existsSync(join(sandbox.project, '.claude', 'reviews', 'r2.md'))).toBe(false);
  });
});

const postToolFile = join(import.meta.dirname, 'post-tool.mjs');

// O revisor em segundo plano entrega o relatório pela ferramenta SubagentHandback; o PostToolUse grava e,
// depois, a parada dele traz só o texto de encerramento (AI-15).
function runHandback(sandbox: Sandbox, agentId: string, message: string) {
  const result = spawnSync(process.execPath, [postToolFile], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      cwd: sandbox.project,
      agent_type: 'reviewer',
      agent_id: agentId,
      tool_name: 'SubagentHandback',
      tool_input: { message },
    }),
    encoding: 'utf8',
    cwd: sandbox.project,
    env: hookEnv(sandbox),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function reviewerStop(agentId: string, lastMessage: string) {
  return { agent_type: 'reviewer', agent_id: agentId, session_id: 's1', last_assistant_message: lastMessage };
}

function savedReport(sandbox: Sandbox, agentId: string): string {
  return readFileSync(join(sandbox.project, '.claude', 'reviews', `${agentId}.md`), 'utf8');
}

describe('AI-15 o hook de parada não sobrescreve o relatório entregue pelo SubagentHandback', () => {
  it('AI-15 depois do SubagentHandback com "A", a parada do mesmo reviewer com "B" deixa o relatório em "A"', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runStart(sandbox, { ...reviewerStop('R1', ''), cwd: sandbox.project });
    expect(runHandback(sandbox, 'R1', 'A').code).toBe(0);

    const result = runStopOnly(sandbox, reviewerStop('R1', 'B'));

    expect(result.code).toBe(0);
    expect(savedReport(sandbox, 'R1')).toBe('A');
  });

  it('AI-15 numa retomada sem SubagentHandback, a segunda parada de R1 com "C" volta a gravar a mensagem final', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runStart(sandbox, { ...reviewerStop('R1', ''), cwd: sandbox.project });
    runHandback(sandbox, 'R1', 'A');
    runStopOnly(sandbox, reviewerStop('R1', 'B'));
    expect(savedReport(sandbox, 'R1')).toBe('A');

    // A retomada dispara o SubagentStart de novo e o revisor encerra sem entregar nada pela ferramenta.
    const result = runHook(sandbox, reviewerStop('R1', 'C'));

    expect(result.code).toBe(0);
    expect(savedReport(sandbox, 'R1')).toBe('C');
  });

  it('AI-15 a segunda parada de R1 com "C" também grava quando o SubagentStart da retomada não rodou', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runStart(sandbox, { ...reviewerStop('R1', ''), cwd: sandbox.project });
    runHandback(sandbox, 'R1', 'A');
    runStopOnly(sandbox, reviewerStop('R1', 'B'));

    runStopOnly(sandbox, reviewerStop('R1', 'C'));

    expect(savedReport(sandbox, 'R1')).toBe('C');
  });

  it('AI-15 uma nova entrega pelo SubagentHandback depois da retomada vale de novo contra a parada seguinte', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runStart(sandbox, { ...reviewerStop('R1', ''), cwd: sandbox.project });
    runHandback(sandbox, 'R1', 'A');
    runStopOnly(sandbox, reviewerStop('R1', 'B'));
    runStopOnly(sandbox, reviewerStop('R1', 'C'));

    runHandback(sandbox, 'R1', 'D');
    runStopOnly(sandbox, reviewerStop('R1', 'E'));

    expect(savedReport(sandbox, 'R1')).toBe('D');
  });

  it('AI-15 a parada de R1 sem texto final, depois do SubagentHandback, também deixa o relatório intacto', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runStart(sandbox, { ...reviewerStop('R1', ''), cwd: sandbox.project });
    runHandback(sandbox, 'R1', 'A');

    const result = runStopOnly(sandbox, { agent_type: 'reviewer', agent_id: 'R1', session_id: 's1' });

    expect(result.code).toBe(0);
    expect(savedReport(sandbox, 'R1')).toBe('A');
  });

  // Controle negativo: o SubagentHandback de um revisor não protege o relatório de outro.
  it('AI-15 controle: o SubagentHandback de R1 não impede a parada de R2 de gravar a mensagem final dele', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    runHandback(sandbox, 'R1', 'A');

    runHook(sandbox, reviewerStop('R2', 'B'));

    expect(savedReport(sandbox, 'R2')).toBe('B');
    expect(savedReport(sandbox, 'R1')).toBe('A');
  });

  // Controle negativo: o revisor em primeiro plano não usa a ferramenta, e a mensagem final continua sendo o relatório.
  it('AI-15 controle: o revisor em primeiro plano, sem SubagentHandback, tem a mensagem final gravada', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });

    const result = runHook(sandbox, reviewerStop('R3', '## Revisão 1\ntexto\n'));

    expect(result.code).toBe(0);
    expect(savedReport(sandbox, 'R3')).toBe('## Revisão 1\ntexto\n');
  });

  it('AI-15 controle: duas paradas seguidas do revisor em primeiro plano gravam sempre a última mensagem', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });

    runHook(sandbox, reviewerStop('R3', 'primeira'));
    runHook(sandbox, reviewerStop('R3', 'segunda'));

    expect(savedReport(sandbox, 'R3')).toBe('segunda');
  });
});

// AI-12 com git de verdade: o retrato do SubagentStart contra o estado na parada, sem depender de como o comando foi escrito.
function exceptionLog(sandbox: Sandbox): string | undefined {
  const file = join(sandbox.project, '.claude', 'state', 'stop-exceptions.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

function systemMessageOf(stdout: string): string | undefined {
  if (stdout.trim() === '') return undefined;
  return (JSON.parse(stdout) as { systemMessage?: string }).systemMessage;
}

async function snapshotPath(sandbox: Sandbox, sessionId: string, agentId: string): Promise<string> {
  const module = (await import(pathToFileURL(join(import.meta.dirname, 'git-snapshot.mjs')).href)) as {
    snapshotFile(session: string, agent: string): string;
  };
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = sandbox.tmp;
  try {
    return module.snapshotFile(sessionId, agentId);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

const REVIEWER = { agent_type: 'reviewer', agent_id: 'r1', session_id: 's1', last_assistant_message: '## Revisão\ntexto' };

describe('AI-12 o hook de parada como processo compara o retrato do git', () => {
  it('AI-12 o reviewer que commitou entre o início e a parada termina com código 0, avisa e registra o estado do git', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });
    git(sandbox, 'commit', '-q', '--allow-empty', '-m', 'escondido');

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(systemMessageOf(result.stdout)).toContain('estado do git');
    expect(systemMessageOf(result.stdout)).toContain('HEAD');
    expect(exceptionLog(sandbox)).toContain('estado do git');
    expect(readFileSync(join(sandbox.project, '.claude', 'reviews', 'r1.md'), 'utf8')).toBe(REVIEWER.last_assistant_message);
  });

  // Controle negativo: sem mudança, nenhum aviso e nenhum registro.
  it('AI-12 controle: o reviewer sem mudança no git termina sem systemMessage e sem registro', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(systemMessageOf(result.stdout)).toBeUndefined();
    expect(exceptionLog(sandbox)).toBeUndefined();
    expect(readFileSync(join(sandbox.project, '.claude', 'reviews', 'r1.md'), 'utf8')).toBe(REVIEWER.last_assistant_message);
  });

  it('AI-12 o reviewer sem retrato (o início não rodou) vira exceção com retrato do git ausente', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(systemMessageOf(result.stdout)).toContain('retrato do git ausente');
    expect(exceptionLog(sandbox)).toContain('retrato do git ausente');
  });

  it('AI-12 o reviewer com o retrato ilegível vira exceção com retrato do git ausente', async () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });
    writeFileSync(await snapshotPath(sandbox, 's1', 'r1'), 'isto não é json');

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain('retrato do git ausente');
  });

  it.each([
    ['uma branch nova', ['branch', 'nova'], 'refs/heads/nova'],
    ['uma tag', ['tag', 'v1'], 'refs/tags/v1'],
    // Um ref local que nenhuma outra worktree usa continua atribuído ao agente (AI-33); o ref remoto saiu da comparação.
    ['um ref local solto (refs/heads/solta)', ['update-ref', 'refs/heads/solta', 'HEAD'], 'refs/heads/solta'],
    ['uma worktree', ['worktree', 'add', '-q', '../wt-ai12', '-b', 'wt-branch'], 'worktrees'],
    ['uma alteração no .git/config', ['config', 'alias.p', 'push'], 'config'],
  ])('AI-12 o test-writer que criou %s termina com código 0 e a exceção cita o que mudou', (_label, args, expected) => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);
    const input = { agent_type: 'test-writer', agent_id: 'tw1', session_id: 's1' };
    runStart(sandbox, { ...input, cwd: sandbox.project });
    git(sandbox, ...args);

    const result = runStopOnly(sandbox, input);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain('estado do git');
    expect(exceptionLog(sandbox)).toContain(expected);
  });

  it('AI-12 o implementer que commitou o que não devia termina com código 0 e registra a exceção, sem devolução', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...IMPLEMENTER_STOP, cwd: sandbox.project });
    writeIn(sandbox, 'src/app.ts', 'export const a = 1;\n');
    git(sandbox, 'commit', '-q', '-am', 'ci: x');

    const result = runStopOnly(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain('estado do git');
  });

  it('AI-12 o implementer sem retrato (o início não rodou) termina com código 0 e registra retrato do git ausente', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);

    const result = runStopOnly(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain('retrato do git ausente');
  });

  // Controle negativo: o mesmo implementer sem mudança no git não gera registro.
  it('AI-12 controle: o implementer que só editou src/ não gera registro', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'tudo ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...IMPLEMENTER_STOP, cwd: sandbox.project });
    writeIn(sandbox, 'src/app.ts', 'export const a = 1;\n');

    const result = runStopOnly(sandbox, IMPLEMENTER_STOP);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toBeUndefined();
  });

  it('AI-12 a retomada regrava o retrato: o que mudou antes dela não vira exceção', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    makeRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });
    git(sandbox, 'commit', '-q', '--allow-empty', '-m', 'antes da retomada');
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(systemMessageOf(result.stdout)).toBeUndefined();
    expect(exceptionLog(sandbox)).toBeUndefined();
  });
});

// AI-28 e AI-29 com git de verdade: o reviewer não tem worktree, então tudo que muda na pasta principal entre o
// SubagentStart e a parada é dele; o que já estava sujo no início não é. O repositório ignora .claude/reviews/ e
// .claude/state/ como o do projeto, porque o próprio hook grava ali.
describe('AI-28 e AI-29 o hook de parada atribui só o que mudou durante a execução', () => {
  function ignoringRepo(sandbox: Sandbox): void {
    makeRepo(sandbox);
    writeIn(sandbox, '.gitignore', '.claude/reviews/\n.claude/state/\n');
    git(sandbox, 'add', '-A');
    git(sandbox, 'commit', '-q', '-m', 'gitignore');
  }

  // Controle negativo: a comparação contra o HEAD atribuiria estas duas mudanças, anteriores ao agente, ao reviewer.
  it('AI-28 uma mudança feita antes do início não é atribuída ao reviewer', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    ignoringRepo(sandbox);
    writeIn(sandbox, 'src/app.ts', 'export const antes = 1;\n');
    writeIn(sandbox, 'src/criado-antes.ts', 'export {};\n');
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(systemMessageOf(result.stdout)).toBeUndefined();
    expect(exceptionLog(sandbox)).toBeUndefined();
  });

  it.each([
    ['um arquivo criado', 'src/durante.ts', 'export {};\n'],
    ['um arquivo rastreado alterado', 'src/app.ts', 'export const durante = 1;\n'],
    ['um arquivo criado em pasta nova', 'docs/novo/nota.md', 'texto\n'],
  ])('AI-29 %s durante a execução do reviewer vira exceção, com o caminho', (_label, file, content) => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    ignoringRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });
    writeIn(sandbox, file, content);

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain(file);
    expect(systemMessageOf(result.stdout)).toContain(file);
  });

  it('AI-28 um arquivo já sujo no início e alterado de novo durante a execução é atribuído', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    ignoringRepo(sandbox);
    writeIn(sandbox, 'src/app.ts', 'export const antes = 1;\n');
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });
    writeIn(sandbox, 'src/app.ts', 'export const durante = 2;\n');

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toContain('src/app.ts');
  });

  it('AI-29 o reviewer que não mudou nada na pasta principal termina sem exceção', () => {
    const sandbox = makeSandbox({ exit: 0, print: 'ok' });
    ignoringRepo(sandbox);
    runStart(sandbox, { ...REVIEWER, cwd: sandbox.project });

    const result = runStopOnly(sandbox, REVIEWER);

    expect(result.code).toBe(0);
    expect(exceptionLog(sandbox)).toBeUndefined();
  });
});
