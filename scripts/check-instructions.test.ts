import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkInstructions } from './check-instructions.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'test', 'fixtures');

const AGENT_FILES = ['test-writer.md', 'implementer.md', 'reviewer.md'];

let tree: string;

beforeEach(() => {
  mkdirSync(fixturesDir, { recursive: true });
  tree = mkdtempSync(join(fixturesDir, 'instructions-'));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const file = join(tree, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Texto com exatamente `count` linhas, como o `wc -l` conta (cada uma terminada em \n).
function lines(count: number): string {
  return 'linha\n'.repeat(count);
}

// Árvore mínima e dentro dos limites, que cada teste altera num ponto.
function writeValidTree(): void {
  write('AGENTS.md', lines(100));
  write('CLAUDE.md', '@AGENTS.md\n');
  for (const agent of AGENT_FILES) write(`.claude/agents/${agent}`, lines(40));
  write('.claude/skills/marco/SKILL.md', lines(300));
}

describe('FND-06 limites do Claude Code no que carrega sempre', () => {
  it('FND-06 uma árvore dentro de todos os limites não tem violação', () => {
    writeValidTree();

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 acusa o AGENTS.md com 201 linhas', () => {
    writeValidTree();
    write('AGENTS.md', lines(201));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('AGENTS.md');
  });

  it('FND-06 não acusa o AGENTS.md com 200 linhas', () => {
    writeValidTree();
    write('AGENTS.md', lines(200));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 acusa o CLAUDE.md com 201 linhas', () => {
    writeValidTree();
    write('CLAUDE.md', lines(201));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('CLAUDE.md');
  });

  it('FND-06 não acusa o CLAUDE.md com 200 linhas', () => {
    writeValidTree();
    write('CLAUDE.md', lines(200));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it.each(AGENT_FILES)('FND-06 acusa o agente %s com 201 linhas', (agent) => {
    writeValidTree();
    write(`.claude/agents/${agent}`, lines(201));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(agent);
  });

  it('FND-06 não acusa um agente com 200 linhas', () => {
    writeValidTree();
    write('.claude/agents/reviewer.md', lines(200));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 acusa um SKILL.md com 501 linhas', () => {
    writeValidTree();
    write('.claude/skills/marco/SKILL.md', lines(501));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('marco');
  });

  it('FND-06 não acusa um SKILL.md com 500 linhas', () => {
    writeValidTree();
    write('.claude/skills/marco/SKILL.md', lines(500));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 confere o SKILL.md de cada skill, e não só o da marco', () => {
    writeValidTree();
    write('.claude/skills/outra/SKILL.md', lines(501));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('outra');
  });

  it('FND-06 não acusa outros arquivos da skill nem arquivos de agente que não são .md', () => {
    writeValidTree();
    write('.claude/skills/marco/referencia.md', lines(900));
    write('.claude/agents/notas.txt', lines(900));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 não acusa uma spec enorme em .specs/, que não tem mais teto de palavras', () => {
    writeValidTree();
    write('.specs/project/STATE.md', `${'palavra '.repeat(10)}\n`.repeat(20_000));
    write('.specs/features/casecellshop/spec.md', lines(20_000));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 não exige o .specs/README.md nem a tabela de limites', () => {
    writeValidTree();

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 uma árvore sem .claude/skills/ não tem violação', () => {
    write('AGENTS.md', lines(100));
    write('CLAUDE.md', '@AGENTS.md\n');
    write('.claude/agents/reviewer.md', lines(40));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 devolve uma frase por arquivo quando vários passam do limite', () => {
    writeValidTree();
    write('AGENTS.md', lines(201));
    write('CLAUDE.md', lines(201));
    write('.claude/agents/reviewer.md', lines(201));
    write('.claude/skills/marco/SKILL.md', lines(501));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(4);
    for (const name of ['AGENTS.md', 'CLAUDE.md', 'reviewer.md', 'marco']) {
      expect(violations.some((violation) => violation.includes(name)), `sem violação citando ${name}`).toBe(true);
    }
  });

  it('FND-06 não acusa nada no repositório real', () => {
    expect(checkInstructions(root)).toEqual([]);
  });
});

// Texto ASCII com exatamente `size` bytes e linhas curtas (80 bytes), bem abaixo de 500 linhas.
function bytesOf(size: number): string {
  const line = `${'a'.repeat(79)}\n`;
  const full = Math.floor((size - 1) / line.length);
  const rest = size - full * line.length;
  return line.repeat(full) + 'a'.repeat(rest - 1) + '\n';
}

describe('FND-06 teto de bytes do SKILL.md e de linhas das regras', () => {
  it('FND-06 o texto de apoio tem os bytes e as linhas esperados', () => {
    expect(Buffer.byteLength(bytesOf(15_000))).toBe(15_000);
    expect(Buffer.byteLength(bytesOf(15_001))).toBe(15_001);
    expect(bytesOf(15_001).split('\n').length - 1).toBeLessThan(500);
  });

  it('FND-06 acusa um SKILL.md com menos de 500 linhas mas com 15.001 bytes', () => {
    writeValidTree();
    write('.claude/skills/x/SKILL.md', bytesOf(15_001));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(join('skills', 'x', 'SKILL.md'));
    expect(violations[0]).toMatch(/bytes|15000|15\.000/);
  });

  it('FND-06 não acusa um SKILL.md com exatamente 15.000 bytes', () => {
    writeValidTree();
    write('.claude/skills/x/SKILL.md', bytesOf(15_000));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 acusa uma regra de .claude/rules/ com 201 linhas', () => {
    writeValidTree();
    write('.claude/rules/area.md', lines(201));

    const violations = checkInstructions(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(join('rules', 'area.md'));
  });

  it('FND-06 não acusa uma regra de .claude/rules/ com 200 linhas', () => {
    writeValidTree();
    write('.claude/rules/area.md', lines(200));

    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 uma árvore sem .claude/rules/ não quebra nem tem violação', () => {
    writeValidTree();

    expect(() => checkInstructions(tree)).not.toThrow();
    expect(checkInstructions(tree)).toEqual([]);
  });

  it('FND-06 o repositório real continua sem violação com os limites novos', () => {
    expect(checkInstructions(root)).toEqual([]);
  });
});
