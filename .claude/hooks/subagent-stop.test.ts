import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface CheckResult {
  ok: boolean;
  output: string;
}

interface Deps {
  runCheck(name: string): Promise<CheckResult>;
  readCount(key: string): number;
  writeCount(key: string, n: number): void;
}

interface StopInput {
  agent_type?: string;
  agent_id: string;
  session_id: string;
  stop_hook_active?: boolean;
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
function makeDeps(failing: Record<string, string> = {}, counts: Record<string, number> = {}) {
  const ran: string[] = [];
  const reads: string[] = [];
  const writes: [string, number][] = [];
  const deps: Deps = {
    runCheck: (name) => {
      ran.push(name);
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
  };
  return { deps, ran, reads, writes, counts };
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
