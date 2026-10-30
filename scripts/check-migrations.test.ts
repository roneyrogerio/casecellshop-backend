import { describe, expect, it } from 'vitest';
import { findMigrationViolations } from './check-migrations.ts';

// Saída de `git diff --name-status --no-renames <base>...HEAD -- migrations`: STATUS<TAB>caminho.
function diff(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('AI-01 conferência de migrações do CI olha só os .sql', () => {
  it('AI-01 entrada vazia não tem violação', () => {
    expect(findMigrationViolations('')).toEqual([]);
  });

  it('AI-01 aceita uma migração nova (A)', () => {
    expect(findMigrationViolations(diff('A\tmigrations/store/20260101000000_x.sql'))).toEqual([]);
  });

  it('AI-01 aceita a remoção do migrations/store/.gitkeep, que não é .sql', () => {
    expect(findMigrationViolations(diff('D\tmigrations/store/.gitkeep'))).toEqual([]);
  });

  it('AI-01 aceita uma migração nova junto com a remoção do .gitkeep', () => {
    const output = diff('A\tmigrations/store/001_x.sql', 'D\tmigrations/store/.gitkeep');

    expect(findMigrationViolations(output)).toEqual([]);
  });

  it('AI-01 aceita qualquer status em arquivo que não é .sql', () => {
    const output = diff('M\tmigrations/store/README.md', 'D\tmigrations/store/notas.txt');

    expect(findMigrationViolations(output)).toEqual([]);
  });

  it('AI-01 reprova a alteração (M) de um .sql que já está na base, citando o caminho', () => {
    const violations = findMigrationViolations(diff('M\tmigrations/store/001_x.sql'));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('migrations/store/001_x.sql');
  });

  it('AI-01 reprova a remoção (D) de um .sql que já está na base, citando o caminho', () => {
    const violations = findMigrationViolations(diff('D\tmigrations/store/001_x.sql'));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('migrations/store/001_x.sql');
  });

  it('AI-01 devolve uma frase por violação e ignora as linhas válidas', () => {
    const output = diff(
      'A\tmigrations/store/003_novo.sql',
      'M\tmigrations/store/001_x.sql',
      'D\tmigrations/store/.gitkeep',
      'D\tmigrations/store/002_y.sql',
    );

    const violations = findMigrationViolations(output);

    expect(violations).toHaveLength(2);
    expect(violations.some((violation) => violation.includes('001_x.sql'))).toBe(true);
    expect(violations.some((violation) => violation.includes('002_y.sql'))).toBe(true);
    expect(violations.some((violation) => violation.includes('003_novo.sql'))).toBe(false);
  });

  it('AI-01 aceita a saída sem a quebra de linha final', () => {
    expect(findMigrationViolations('A\tmigrations/store/001_x.sql')).toEqual([]);
    expect(findMigrationViolations('M\tmigrations/store/001_x.sql')).toHaveLength(1);
  });
});
