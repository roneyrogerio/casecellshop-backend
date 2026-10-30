import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

let scriptsDiffer: (base: string, head: string) => boolean;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(import.meta.dirname, 'check-scripts.ts')).href)) as {
    scriptsDiffer: typeof scriptsDiffer;
  };
  scriptsDiffer = mod.scriptsDiffer;
});

function pkg(scripts: Record<string, string> | undefined, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'x', version: '0.0.0', ...(scripts ? { scripts } : {}), ...extra }, null, 2);
}

const BASE_SCRIPTS = { test: 'vitest run', lint: 'oxlint', typecheck: 'tsc --noEmit' };

describe('AI-05 scriptsDiffer compara o bloco scripts do package.json com a base', () => {
  it('AI-05 blocos idênticos não diferem (controle)', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(BASE_SCRIPTS))).toBe(false);
  });

  it('AI-05 um comando alterado difere', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg({ ...BASE_SCRIPTS, lint: 'true' }))).toBe(true);
  });

  it('AI-05 um script acrescentado difere', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg({ ...BASE_SCRIPTS, extra: 'echo oi' }))).toBe(true);
  });

  it('AI-05 um script removido difere', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg({ test: 'vitest run', lint: 'oxlint' }))).toBe(true);
  });

  it('AI-05 um script renomeado difere', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg({ test: 'vitest run', lint: 'oxlint', check: 'tsc --noEmit' }))).toBe(true);
  });

  it('AI-05 outra ordem das chaves não difere', () => {
    const reordered = { typecheck: 'tsc --noEmit', test: 'vitest run', lint: 'oxlint' };

    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(reordered))).toBe(false);
    expect(scriptsDiffer(pkg(reordered), pkg(BASE_SCRIPTS))).toBe(false);
  });

  it('AI-05 outra formatação do JSON não difere', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), JSON.stringify({ name: 'x', scripts: BASE_SCRIPTS }))).toBe(false);
  });

  it('AI-05 mudar dependências, versão ou outros campos sem tocar nos scripts não difere', () => {
    const head = pkg(BASE_SCRIPTS, { dependencies: { zod: '4.6.7' }, engines: { node: '>=24.12.0' } });

    expect(scriptsDiffer(pkg(BASE_SCRIPTS), head)).toBe(false);
  });

  it('AI-05 o bloco que aparece onde não havia difere, e o que some também', () => {
    expect(scriptsDiffer(pkg(undefined), pkg(BASE_SCRIPTS))).toBe(true);
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(undefined))).toBe(true);
  });

  it('AI-05 sem bloco scripts nos dois lados não difere', () => {
    expect(scriptsDiffer(pkg(undefined), pkg(undefined, { dependencies: { zod: '4.6.7' } }))).toBe(false);
  });

  it('AI-05 um espaço a mais dentro do comando difere (o comando é o que executa)', () => {
    expect(scriptsDiffer(pkg({ lint: 'oxlint' }), pkg({ lint: 'oxlint ' }))).toBe(true);
  });
});
