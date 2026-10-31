import { describe, expect, it } from 'vitest';
import { findMigrationViolations } from './check-migrations.ts';

// Saída de `git diff --name-status --no-renames <base>...HEAD -- migrations`: STATUS<TAB>caminho.
function diff(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

describe('AI-01 conferência de migrações do CI olha todo arquivo de migrations/, de qualquer extensão', () => {
  it('AI-01 entrada vazia não tem violação', () => {
    expect(findMigrationViolations('')).toEqual([]);
  });

  it.each([
    ['.ts', 'migrations/store/20260101000000_x.ts'],
    ['.sql', 'migrations/store/20260101000000_x.sql'],
    ['.mjs', 'migrations/store/20260101000000_x.mjs'],
    ['.md', 'migrations/store/LEIA-ME.md'],
  ])('AI-01 aceita um arquivo novo (A) %s', (_extension, file) => {
    expect(findMigrationViolations(diff(`A\t${file}`))).toEqual([]);
  });

  it.each(['A', 'M', 'D'])('AI-01 aceita o status %s do .gitkeep, em qualquer pasta', (status) => {
    const output = diff(`${status}\tmigrations/store/.gitkeep`, `${status}\tmigrations/erp_sim/.gitkeep`);

    expect(findMigrationViolations(output)).toEqual([]);
  });

  it('AI-01 aceita uma migração nova junto com a remoção do .gitkeep', () => {
    const output = diff('A\tmigrations/store/20260101000001_x.ts', 'D\tmigrations/store/.gitkeep');

    expect(findMigrationViolations(output)).toEqual([]);
  });

  it.each([
    ['.ts', 'migrations/store/20260101000000_x.ts'],
    ['.sql', 'migrations/store/20260101000000_x.sql'],
    ['.mjs', 'migrations/store/20260101000000_x.mjs'],
    ['.md', 'migrations/store/LEIA-ME.md'],
    ['sem extensão', 'migrations/erp_sim/notas'],
  ])('AI-01 reprova a alteração (M) de um arquivo %s que já está na base, citando o caminho', (_extension, file) => {
    const violations = findMigrationViolations(diff(`M\t${file}`));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(file);
  });

  it.each([
    ['.ts', 'migrations/store/20260101000000_x.ts'],
    ['.mjs', 'migrations/store/20260101000000_x.mjs'],
    ['.md', 'migrations/store/LEIA-ME.md'],
    ['sem extensão', 'migrations/erp_sim/notas'],
  ])('AI-01 reprova a remoção (D) de um arquivo %s que já está na base, citando o caminho', (_extension, file) => {
    const violations = findMigrationViolations(diff(`D\t${file}`));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(file);
  });

  it('AI-01 aceita a remoção (D) de um .sql, que deixou de ser migração na conversão única da AD-017', () => {
    expect(findMigrationViolations(diff('D\tmigrations/erp_sim/20260101000000_create_erp_sim.sql'))).toEqual([]);
  });

  it('AI-01 aceita a conversão única: o .sql apagado e a mesma migração reescrita em .ts', () => {
    const output = diff(
      'D\tmigrations/erp_sim/20260101000000_create_erp_sim.sql',
      'A\tmigrations/erp_sim/20260101000000_create_erp_sim.ts',
    );

    expect(findMigrationViolations(output)).toEqual([]);
  });

  it('AI-01 continua reprovando a alteração (M) de um .sql, mesmo com a remoção liberada', () => {
    const violations = findMigrationViolations(diff('M\tmigrations/store/20260101000000_x.sql'));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('migrations/store/20260101000000_x.sql');
  });

  it('AI-01 a exceção da remoção vale só para a extensão .sql: um .sql.ts apagado reprova', () => {
    expect(findMigrationViolations(diff('D\tmigrations/store/20260101000000_x.sql.ts'))).toHaveLength(1);
  });

  it('AI-01 a exceção do .gitkeep vale só para o nome exato: um arquivo que termina em .gitkeep reprova', () => {
    expect(findMigrationViolations(diff('M\tmigrations/store/nao.gitkeep'))).toHaveLength(1);
    expect(findMigrationViolations(diff('D\tmigrations/store/nao.gitkeep'))).toHaveLength(1);
  });

  it('AI-01 devolve uma frase por violação e ignora as linhas válidas', () => {
    const output = diff(
      'A\tmigrations/store/20260103000000_novo.ts',
      'M\tmigrations/store/20260101000000_x.ts',
      'D\tmigrations/store/.gitkeep',
      'D\tmigrations/store/20260102000000_y.ts',
      'D\tmigrations/store/20260100000000_antiga.sql',
      'M\tmigrations/store/20260100000001_antiga.sql',
    );

    const violations = findMigrationViolations(output);

    expect(violations).toHaveLength(3);
    expect(violations.some((violation) => violation.includes('20260101000000_x.ts'))).toBe(true);
    expect(violations.some((violation) => violation.includes('20260102000000_y.ts'))).toBe(true);
    expect(violations.some((violation) => violation.includes('20260100000001_antiga.sql'))).toBe(true);
    expect(violations.some((violation) => violation.includes('20260103000000_novo.ts'))).toBe(false);
    expect(violations.some((violation) => violation.includes('20260100000000_antiga.sql'))).toBe(false);
  });

  it('AI-01 aceita a saída sem a quebra de linha final', () => {
    expect(findMigrationViolations('A\tmigrations/store/20260101000000_x.ts')).toEqual([]);
    expect(findMigrationViolations('M\tmigrations/store/20260101000000_x.ts')).toHaveLength(1);
  });
});
