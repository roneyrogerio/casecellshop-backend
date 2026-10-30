import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const FIXED_ACCOUNT = /honeyforge/i;

// Código de produção dos trilhos: scripts e hooks, fora os testes.
function isProductionRail(file: string): boolean {
  const inScope = file.startsWith('scripts/') || file.startsWith('.claude/hooks/');
  return inScope && /\.(ts|mjs)$/.test(file) && !file.endsWith('.test.ts');
}

// Arquivos rastreados e também os novos ainda não adicionados, para o teste valer antes do commit.
function railFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.stdout.split('\n').filter((file) => file !== '' && isProductionRail(file));
}

function filesWithFixedAccount(files: string[], read: (file: string) => string): string[] {
  return files.filter((file) => FIXED_ACCOUNT.test(read(file)));
}

describe('AI-14 nenhuma conta fixa no código', () => {
  it('AI-14 nenhum .ts ou .mjs de scripts/ e .claude/hooks/ (fora os testes) cita a conta fixa', () => {
    const files = railFiles();

    expect(files.length).toBeGreaterThan(5);
    expect(filesWithFixedAccount(files, (file) => readFileSync(join(root, file), 'utf8'))).toEqual([]);
  });

  // Controle negativo: a busca acha o texto num conteúdo inventado que o tenha.
  it('AI-14 a busca acha a conta fixa num conteúdo inventado (controle negativo)', () => {
    const fake: Record<string, string> = {
      'scripts/a.ts': "export const LOGIN = 'honeyforge-bot';\n",
      'scripts/b.ts': 'export const LOGIN = undefined;\n',
    };

    expect(filesWithFixedAccount(Object.keys(fake), (file) => fake[file] ?? '')).toEqual(['scripts/a.ts']);
  });

  it('AI-14 scripts/lib/bot-token.ts não existe mais', () => {
    expect(existsSync(join(root, 'scripts', 'lib', 'bot-token.ts'))).toBe(false);
  });

  it('AI-14 scripts/lib/identity.ts existe', () => {
    expect(existsSync(join(root, 'scripts', 'lib', 'identity.ts'))).toBe(true);
  });
});
