import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const APP_CHECK = '.claude/skills/app-check/SKILL.md';
const MARCO = '.claude/skills/marco/SKILL.md';

// Cada passo da receita do AI-22, como um padrão sobre o texto da skill.
const RECIPE_STEPS: [string, RegExp][] = [
  ['sobe o compose (docker compose up)', /docker compose up/],
  ['faz um checkout (/checkout)', /\/checkout/],
  ['acompanha o status até invoiced', /invoiced/],
  ['lê o /metrics do worker', /\/metrics/],
  ['lê os logs do worker (docker compose logs)', /docker compose logs/],
  ['derruba o compose (docker compose down)', /docker compose down/],
];

// A conferência como função, para provar também que reprova uma cópia sem um passo (controle negativo).
function appCheckViolations(content: string): string[] {
  const violations: string[] = [];
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!frontmatter) violations.push('a skill não começa com um bloco de frontmatter');
  else if (!/^name:\s*app-check\s*$/m.test(frontmatter[1] ?? '')) violations.push('o frontmatter não tem name: app-check');
  for (const [label, pattern] of RECIPE_STEPS) {
    if (!pattern.test(content)) violations.push(`a receita não ${label}`);
  }
  return violations;
}

// O texto do passo "Ready and merge" da /marco, até o próximo título de seção.
function readyAndMergeStep(content: string): string {
  const match = /^## (?:\d+\. )?Ready and merge\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(content);
  return match?.[1] ?? '';
}

const scratch = mkdtempSync(path.join(tmpdir(), 'app-check-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('AI-22 a skill app-check roda o sistema pelo docker compose e colhe a evidência', () => {
  it('AI-22 a skill .claude/skills/app-check/SKILL.md existe', () => {
    expect(existsSync(path.join(root, APP_CHECK))).toBe(true);
  });

  it('AI-22 o frontmatter tem name: app-check e a receita sobe o compose, faz o checkout, acompanha o status até invoiced, lê o /metrics e os logs do worker e derruba o compose', () => {
    expect(appCheckViolations(readFileSync(path.join(root, APP_CHECK), 'utf8'))).toEqual([]);
  });

  it('AI-22 controle negativo: a mesma conferência reprova uma cópia da skill sem o docker compose down', () => {
    const original = readFileSync(path.join(root, APP_CHECK), 'utf8');
    const folder = path.join(scratch, 'sem-down');
    mkdirSync(folder, { recursive: true });
    const copy = path.join(folder, 'SKILL.md');
    writeFileSync(copy, original.replaceAll('docker compose down', 'docker compose stop'));

    const violations = appCheckViolations(readFileSync(copy, 'utf8'));

    expect(violations).toEqual(['a receita não derruba o compose (docker compose down)']);
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia com outro name no frontmatter', () => {
    const original = readFileSync(path.join(root, APP_CHECK), 'utf8');

    expect(appCheckViolations(original.replace(/^name:\s*app-check\s*$/m, 'name: verify'))).toContain('o frontmatter não tem name: app-check');
  });

  it('AI-22 o passo "Ready and merge" da skill marco cita app-check', () => {
    const step = readyAndMergeStep(readFileSync(path.join(root, MARCO), 'utf8'));

    expect(step, 'a skill marco não tem o passo "Ready and merge"').not.toBe('');
    expect(step).toContain('app-check');
  });
});
