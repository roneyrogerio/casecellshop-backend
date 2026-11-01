import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

// Limites do FND-06 para cada regra de .claude/rules/.
const MAX_RULE_LINES = 200;
const MAX_RULE_CHARS = 40_000;

// Os problemas de uma regra: frontmatter que não abre, `paths:` sem algum padrão exigido, ou tamanho acima do FND-06.
function ruleProblems(raw: string, requiredPaths: string[]): string[] {
  const lines = raw.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (lines[0] !== '---' || end === -1) return ['sem frontmatter'];
  const problems: string[] = [];
  let data: unknown;
  try {
    data = parse(lines.slice(1, end).join('\n'));
  } catch {
    return ['o YAML não abre'];
  }
  const paths = (data as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(paths)) problems.push('sem paths:');
  else for (const required of requiredPaths) if (!paths.includes(required)) problems.push(`paths: sem ${required}`);
  if (lines.length > MAX_RULE_LINES) problems.push(`mais de ${MAX_RULE_LINES} linhas`);
  if (raw.length > MAX_RULE_CHARS) problems.push(`mais de ${MAX_RULE_CHARS} caracteres`);
  return problems;
}

function realRule(name: string): string | undefined {
  const file = path.join(root, '.claude', 'rules', name);
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

describe('AI-32 as regras por tipo de arquivo carregam só quando um arquivo desse tipo é lido ou escrito', () => {
  it('AI-32 a regra architecture.md existe, declara paths para src/** e fica nos limites do FND-06', () => {
    const raw = realRule('architecture.md');

    expect(raw).toBeDefined();
    expect(ruleProblems(raw ?? '', ['src/**'])).toEqual([]);
  });

  it('AI-32 a regra docs.md existe, declara paths para **/*.md e .specs/** e fica nos limites do FND-06', () => {
    const raw = realRule('docs.md');

    expect(raw).toBeDefined();
    expect(ruleProblems(raw ?? '', ['**/*.md', '.specs/**'])).toEqual([]);
  });

  // Referência do formato: a regra de testes já existente declara paths e cabe nos limites.
  it('AI-32 a regra tests.md, que já existe, passa na mesma conferência', () => {
    expect(ruleProblems(realRule('tests.md') ?? '', ['**/*.test.ts', 'test/**'])).toEqual([]);
  });
});

describe('AI-32 controle negativo: a conferência reprova a regra quebrada', () => {
  const valid = '---\npaths:\n  - "src/**"\n---\n\n# Regra\n';

  it('AI-32 aceita uma regra válida', () => {
    expect(ruleProblems(valid, ['src/**'])).toEqual([]);
  });

  it('AI-32 reprova a regra sem frontmatter, sem paths ou sem o padrão exigido', () => {
    expect(ruleProblems('# Regra\n', ['src/**'])).toEqual(['sem frontmatter']);
    expect(ruleProblems('---\ndescription: x\n---\n', ['src/**'])).toEqual(['sem paths:']);
    expect(ruleProblems(valid, ['src/**', '**/*.md'])).toEqual(['paths: sem **/*.md']);
  });

  it('AI-32 reprova a regra com 201 linhas e a com mais de 40.000 caracteres', () => {
    const long = `${valid}${'linha\n'.repeat(MAX_RULE_LINES)}`;
    expect(ruleProblems(long, ['src/**'])).toContain('mais de 200 linhas');

    const wide = `${valid}${'a'.repeat(MAX_RULE_CHARS)}\n`;
    expect(ruleProblems(wide, ['src/**'])).toContain('mais de 40000 caracteres');
  });
});
