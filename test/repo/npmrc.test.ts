import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/repo-root.ts';

// AI-50: o .npmrc fixa `min-release-age=7`, para o `npm install` local só escolher versão publicada há mais de 7 dias
// (a mesma espera do Dependabot, AI-45). O npm ci instala o lockfile e não é afetado.
const REQUIRED_DAYS = '7';

// Valor da chave no formato do .npmrc (`chave=valor`, comentários com # ou ;). Vale a última ocorrência, como no npm.
function npmrcValue(text: string, key: string): string | undefined {
  let value: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const [name, ...rest] = line.split('=');
    if (name?.trim() === key) value = rest.join('=').trim();
  }
  return value;
}

function minReleaseAgeIsSeven(text: string): boolean {
  return npmrcValue(text, 'min-release-age') === REQUIRED_DAYS;
}

describe('AI-50 o .npmrc fixa min-release-age=7', () => {
  it('AI-50 o leitor aceita a chave com 7 e recusa o .npmrc sem a chave, com outro número ou comentada', () => {
    expect(minReleaseAgeIsSeven('min-release-age=7\n')).toBe(true);
    expect(minReleaseAgeIsSeven('save-exact=true\nmin-release-age=7\n')).toBe(
      true,
    );
    expect(minReleaseAgeIsSeven('')).toBe(false);
    expect(minReleaseAgeIsSeven('save-exact=true\n')).toBe(false);
    expect(minReleaseAgeIsSeven('min-release-age=3\n')).toBe(false);
    expect(minReleaseAgeIsSeven('min-release-age=70\n')).toBe(false);
    expect(minReleaseAgeIsSeven('min-release-age=0\n')).toBe(false);
    expect(minReleaseAgeIsSeven('# min-release-age=7\n')).toBe(false);
    expect(minReleaseAgeIsSeven('min-release-age=7\nmin-release-age=1\n')).toBe(
      false,
    );
  });

  it('AI-50 o .npmrc existe na raiz do repositório', () => {
    expect(existsSync(join(repoRoot, '.npmrc'))).toBe(true);
  });

  it('AI-50 o .npmrc da raiz tem min-release-age=7', () => {
    const file = join(repoRoot, '.npmrc');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';

    expect(npmrcValue(text, 'min-release-age')).toBe(REQUIRED_DAYS);
  });
});
