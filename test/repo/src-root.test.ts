import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AI-40: na raiz de src/ só fica o app.ts; todo outro arquivo vai na pasta da capacidade ou da fronteira que serve
// (AD-025). A função que decide recebe os nomes que estão na raiz e devolve os que sobram.
const srcDir = join(import.meta.dirname, '..', '..', 'src');
const ALLOWED_ROOT_FILES = ['app.ts'];

function strayRootFiles(rootFiles: string[]): string[] {
  return rootFiles.filter((name) => !ALLOWED_ROOT_FILES.includes(name)).sort();
}

describe('AI-40 a raiz de src/ só tem o app.ts', () => {
  it('AI-40 controle: a função reprova um arquivo a mais na raiz, como src/util.ts', () => {
    expect(strayRootFiles(['app.ts', 'util.ts'])).toEqual(['util.ts']);
  });

  it('AI-40 controle: a função reprova também um teste solto na raiz e um .d.ts', () => {
    expect(strayRootFiles(['app.ts', 'app.test.ts', 'env.d.ts'])).toEqual([
      'app.test.ts',
      'env.d.ts',
    ]);
  });

  it('AI-40 controle: a função aceita só o app.ts e uma raiz sem arquivos', () => {
    expect(strayRootFiles(['app.ts'])).toEqual([]);
    expect(strayRootFiles([])).toEqual([]);
  });

  it('AI-40 os arquivos na raiz de src/ são só o app.ts', () => {
    const files = readdirSync(srcDir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory())
      .map((entry) => entry.name);

    expect(files).toContain('app.ts');
    expect(strayRootFiles(files)).toEqual([]);
  });
});
