import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSpecLimits } from './check-spec-limits.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'test', 'fixtures');

// Limites da tabela do .specs/README.md, em palavras.
const WORD_LIMITS: [string, string, number][] = [
  ['PROJECT.md', '.specs/project/PROJECT.md', 1200],
  ['ROADMAP.md', '.specs/project/ROADMAP.md', 1800],
  ['STATE.md', '.specs/project/STATE.md', 6000],
  ['spec.md', '.specs/features/casecellshop/spec.md', 3000],
  ['design.md', '.specs/features/casecellshop/design.md', 4800],
  ['CONVENTIONS.md', '.specs/codebase/CONVENTIONS.md', 1800],
];
const AGENT_FILES = ['planner.md', 'test-writer.md', 'implementer.md', 'reviewer.md'];

let tree: string;

beforeEach(() => {
  mkdirSync(fixturesDir, { recursive: true });
  tree = mkdtempSync(join(fixturesDir, 'spec-limits-'));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

function write(relativePath: string, content: string): void {
  const file = join(tree, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

// Texto com exatamente `count` palavras, como o `wc -w` conta, em linhas de 10.
function words(count: number): string {
  const lines: string[] = [];
  for (let done = 0; done < count; done += 10) {
    lines.push(Array.from({ length: Math.min(10, count - done) }, () => 'palavra').join(' '));
  }
  return `${lines.join('\n')}\n`;
}

// Texto com exatamente `count` linhas, como o `wc -l` conta (cada uma terminada em \n).
function lines(count: number): string {
  return 'linha\n'.repeat(count);
}

const README_TABLE = [
  '# Specs',
  '',
  '| Arquivo | Limite |',
  '| --- | --- |',
  ...WORD_LIMITS.map(([name, , limit]) => `| \`${name}\` | ${limit.toLocaleString('pt-BR')} |`),
  '',
].join('\n');

// Árvore mínima e dentro dos limites, que cada teste altera num ponto.
function writeValidTree(): void {
  write('.specs/README.md', README_TABLE);
  for (const [, path, limit] of WORD_LIMITS) write(path, words(Math.floor(limit / 2)));
  write('AGENTS.md', lines(100));
  for (const agent of AGENT_FILES) write(`.claude/agents/${agent}`, lines(40));
}

describe('FND-06 limites de tamanho das specs e das instruções da IA', () => {
  it('FND-06 uma árvore dentro de todos os limites não tem violação', () => {
    writeValidTree();

    expect(checkSpecLimits(tree)).toEqual([]);
  });

  it.each(WORD_LIMITS)('FND-06 acusa o %s com uma palavra acima do limite', (name, path, limit) => {
    writeValidTree();
    write(path, words(limit + 1));

    const violations = checkSpecLimits(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(name);
  });

  it.each(WORD_LIMITS)('FND-06 não acusa o %s exatamente no limite de palavras', (_name, path, limit) => {
    writeValidTree();
    write(path, words(limit));

    expect(checkSpecLimits(tree)).toEqual([]);
  });

  it('FND-06 acusa o AGENTS.md com 201 linhas', () => {
    writeValidTree();
    write('AGENTS.md', lines(201));

    const violations = checkSpecLimits(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('AGENTS.md');
  });

  it('FND-06 não acusa o AGENTS.md com 200 linhas', () => {
    writeValidTree();
    write('AGENTS.md', lines(200));

    expect(checkSpecLimits(tree)).toEqual([]);
  });

  it.each(AGENT_FILES)('FND-06 acusa o agente %s com 201 linhas', (agent) => {
    writeValidTree();
    write(`.claude/agents/${agent}`, lines(201));

    const violations = checkSpecLimits(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(agent);
  });

  it('FND-06 não acusa um agente com 200 linhas', () => {
    writeValidTree();
    write('.claude/agents/reviewer.md', lines(200));

    expect(checkSpecLimits(tree)).toEqual([]);
  });

  it('FND-06 devolve uma frase por arquivo quando vários passam do limite', () => {
    writeValidTree();
    write('.specs/project/PROJECT.md', words(1201));
    write('AGENTS.md', lines(201));
    write('.claude/agents/planner.md', lines(201));

    const violations = checkSpecLimits(tree);

    expect(violations).toHaveLength(3);
    expect(violations.some((violation) => violation.includes('PROJECT.md'))).toBe(true);
    expect(violations.some((violation) => violation.includes('AGENTS.md'))).toBe(true);
    expect(violations.some((violation) => violation.includes('planner.md'))).toBe(true);
  });

  it('FND-06 acusa a tabela do README com uma coluna a mais, que não é reconhecida', () => {
    writeValidTree();
    write(
      '.specs/README.md',
      [
        '# Specs',
        '',
        '| Arquivo | Limite | Observação |',
        '| --- | --- | --- |',
        ...WORD_LIMITS.map(([name, , limit]) => `| \`${name}\` | ${limit.toLocaleString('pt-BR')} | ok |`),
        '',
      ].join('\n'),
    );

    const violations = checkSpecLimits(tree);

    expect(violations.length).toBeGreaterThan(0);
    for (const [name] of WORD_LIMITS) {
      expect(violations.some((violation) => violation.includes(name)), `sem violação citando ${name}`).toBe(true);
    }
  });

  it.each(WORD_LIMITS)('FND-06 acusa a tabela do README sem a linha do %s, citando o arquivo', (name) => {
    writeValidTree();
    write(
      '.specs/README.md',
      [
        '# Specs',
        '',
        '| Arquivo | Limite |',
        '| --- | --- |',
        ...WORD_LIMITS.filter(([other]) => other !== name).map(
          ([other, , limit]) => `| \`${other}\` | ${limit.toLocaleString('pt-BR')} |`,
        ),
        '',
      ].join('\n'),
    );

    const violations = checkSpecLimits(tree);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(name);
  });

  it('FND-06 não acusa nada no repositório real', () => {
    expect(checkSpecLimits(root)).toEqual([]);
  });
});
