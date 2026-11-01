import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

let scriptsDiffer: (base: string, head: string) => boolean;
let packageJsonDiffers: (base: string, head: string) => boolean;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(
    pathToFileURL(join(import.meta.dirname, 'check-scripts.ts')).href
  )) as {
    scriptsDiffer: typeof scriptsDiffer;
    packageJsonDiffers: typeof packageJsonDiffers;
  };
  scriptsDiffer = mod.scriptsDiffer;
  packageJsonDiffers = mod.packageJsonDiffers;
});

function pkg(
  scripts: Record<string, string> | undefined,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify(
    { name: 'x', version: '0.0.0', ...(scripts ? { scripts } : {}), ...extra },
    null,
    2,
  );
}

const BASE_SCRIPTS = {
  test: 'vitest run',
  lint: 'oxlint',
  typecheck: 'tsc --noEmit',
};

describe('AI-05 scriptsDiffer compara o bloco scripts do package.json com a base', () => {
  it('AI-05 blocos idênticos não diferem (controle)', () => {
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(BASE_SCRIPTS))).toBe(false);
  });

  it('AI-05 um comando alterado difere', () => {
    expect(
      scriptsDiffer(pkg(BASE_SCRIPTS), pkg({ ...BASE_SCRIPTS, lint: 'true' })),
    ).toBe(true);
  });

  it('AI-05 um script acrescentado difere', () => {
    expect(
      scriptsDiffer(
        pkg(BASE_SCRIPTS),
        pkg({ ...BASE_SCRIPTS, extra: 'echo oi' }),
      ),
    ).toBe(true);
  });

  it('AI-05 um script removido difere', () => {
    expect(
      scriptsDiffer(
        pkg(BASE_SCRIPTS),
        pkg({ test: 'vitest run', lint: 'oxlint' }),
      ),
    ).toBe(true);
  });

  it('AI-05 um script renomeado difere', () => {
    expect(
      scriptsDiffer(
        pkg(BASE_SCRIPTS),
        pkg({ test: 'vitest run', lint: 'oxlint', check: 'tsc --noEmit' }),
      ),
    ).toBe(true);
  });

  it('AI-05 outra ordem das chaves não difere', () => {
    const reordered = {
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      lint: 'oxlint',
    };

    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(reordered))).toBe(false);
    expect(scriptsDiffer(pkg(reordered), pkg(BASE_SCRIPTS))).toBe(false);
  });

  it('AI-05 outra formatação do JSON não difere', () => {
    expect(
      scriptsDiffer(
        pkg(BASE_SCRIPTS),
        JSON.stringify({ name: 'x', scripts: BASE_SCRIPTS }),
      ),
    ).toBe(false);
  });

  it('AI-05 mudar dependências, versão ou outros campos sem tocar nos scripts não difere', () => {
    const head = pkg(BASE_SCRIPTS, {
      dependencies: { zod: '4.6.7' },
      engines: { node: '>=24.12.0' },
    });

    expect(scriptsDiffer(pkg(BASE_SCRIPTS), head)).toBe(false);
  });

  it('AI-05 o bloco que aparece onde não havia difere, e o que some também', () => {
    expect(scriptsDiffer(pkg(undefined), pkg(BASE_SCRIPTS))).toBe(true);
    expect(scriptsDiffer(pkg(BASE_SCRIPTS), pkg(undefined))).toBe(true);
  });

  it('AI-05 sem bloco scripts nos dois lados não difere', () => {
    expect(
      scriptsDiffer(
        pkg(undefined),
        pkg(undefined, { dependencies: { zod: '4.6.7' } }),
      ),
    ).toBe(false);
  });

  it('AI-05 um espaço a mais dentro do comando difere (o comando é o que executa)', () => {
    expect(
      scriptsDiffer(pkg({ lint: 'oxlint' }), pkg({ lint: 'oxlint ' })),
    ).toBe(true);
  });
});

// O Prettier, o knip e o jscpd leem configuração de chaves do package.json: tudo fora dos blocos de dependências é do oráculo.
const BASE_DEPENDENCIES = {
  dependencies: { zod: '4.6.7', kysely: '0.28.0' },
  devDependencies: { vitest: '4.0.0' },
};

describe('AI-05 packageJsonDiffers compara tudo fora dos blocos de dependências com a base', () => {
  it('AI-05 package.json idêntico não difere (controle)', () => {
    const text = pkg(BASE_SCRIPTS, BASE_DEPENDENCIES);

    expect(packageJsonDiffers(text, text)).toBe(false);
  });

  it('AI-05 mudar um script difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        pkg({ ...BASE_SCRIPTS, lint: 'true' }, BASE_DEPENDENCIES),
      ),
    ).toBe(true);
  });

  it.each([
    ['prettier', { prettier: { semi: false } }],
    ['knip', { knip: { ignore: ['src/**'] } }],
    ['jscpd', { jscpd: { threshold: 100 } }],
    ['engines', { engines: { node: '>=1' } }],
    ['type', { type: 'commonjs' }],
    ['name', { name: 'outro' }],
  ])('AI-05 acrescentar ou mudar a chave %s difere', (_key, extra) => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, { ...BASE_DEPENDENCIES, type: 'module' }),
        pkg(BASE_SCRIPTS, { ...BASE_DEPENDENCIES, type: 'module', ...extra }),
      ),
    ).toBe(true);
  });

  it('AI-05 remover uma chave de configuração difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, { ...BASE_DEPENDENCIES, prettier: { semi: false } }),
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
      ),
    ).toBe(true);
  });

  it('AI-05 mudar a versão de uma dependência não difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        pkg(BASE_SCRIPTS, {
          ...BASE_DEPENDENCIES,
          dependencies: { zod: '4.7.0', kysely: '0.28.0' },
        }),
      ),
    ).toBe(false);
  });

  it('AI-05 acrescentar uma devDependency não difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        pkg(BASE_SCRIPTS, {
          ...BASE_DEPENDENCIES,
          devDependencies: { vitest: '4.0.0', knip: '6.0.0' },
        }),
      ),
    ).toBe(false);
  });

  it.each([
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ])('AI-05 acrescentar o bloco %s onde não havia não difere', (block) => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS),
        pkg(BASE_SCRIPTS, { [block]: { zod: '4.6.7' } }),
      ),
    ).toBe(false);
  });

  it('AI-05 mudar só a ordem das chaves dentro de um bloco de dependências não difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        pkg(BASE_SCRIPTS, {
          ...BASE_DEPENDENCIES,
          dependencies: { kysely: '0.28.0', zod: '4.6.7' },
        }),
      ),
    ).toBe(false);
  });

  it('AI-05 mudar só a ordem das chaves de nível superior não difere', () => {
    expect(
      packageJsonDiffers(
        JSON.stringify({
          name: 'x',
          scripts: BASE_SCRIPTS,
          engines: { node: '1' },
        }),
        JSON.stringify({
          engines: { node: '1' },
          scripts: BASE_SCRIPTS,
          name: 'x',
        }),
      ),
    ).toBe(false);
  });

  it('AI-05 mudar a ordem das chaves dentro de uma chave de configuração não difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, { prettier: { semi: false, tabWidth: 4 } }),
        pkg(BASE_SCRIPTS, { prettier: { tabWidth: 4, semi: false } }),
      ),
    ).toBe(false);
  });

  it('AI-05 outra formatação do JSON não difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        JSON.stringify({
          name: 'x',
          version: '0.0.0',
          scripts: BASE_SCRIPTS,
          ...BASE_DEPENDENCIES,
        }),
      ),
    ).toBe(false);
  });

  it('AI-05 mudar uma dependência e uma chave de configuração ao mesmo tempo difere', () => {
    expect(
      packageJsonDiffers(
        pkg(BASE_SCRIPTS, BASE_DEPENDENCIES),
        pkg(BASE_SCRIPTS, {
          ...BASE_DEPENDENCIES,
          dependencies: { zod: '9.9.9' },
          knip: { entry: [] },
        }),
      ),
    ).toBe(true);
  });
});
