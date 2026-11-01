import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

// AI-41: o editor recomenda as extensões do Prettier e do oxlint; formatar ao salvar é escolha de cada pessoa.

function readExtensions(): { recommendations?: unknown } {
  try {
    return JSON.parse(
      readFileSync(join(root, '.vscode', 'extensions.json'), 'utf8'),
    ) as { recommendations?: unknown };
  } catch {
    return {};
  }
}

describe('AI-41 o .vscode do repositório recomenda as extensões e não impõe configuração', () => {
  it('AI-41 o .vscode/extensions.json existe e é um JSON válido', () => {
    expect(existsSync(join(root, '.vscode', 'extensions.json'))).toBe(true);
    expect(Array.isArray(readExtensions().recommendations)).toBe(true);
  });

  it.each(['esbenp.prettier-vscode', 'oxc.oxc-vscode'])(
    'AI-41 as recomendações incluem %s',
    (extension) => {
      expect(readExtensions().recommendations).toContain(extension);
    },
  );

  it('AI-41 não há .vscode/settings.json: formatar ao salvar é escolha de cada pessoa', () => {
    // Sem o extensions.json o controle seria vazio: a pasta tem de existir para a ausência significar algo.
    expect(existsSync(join(root, '.vscode', 'extensions.json'))).toBe(true);
    expect(existsSync(join(root, '.vscode', 'settings.json'))).toBe(false);
  });
});
