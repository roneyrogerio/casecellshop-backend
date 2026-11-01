import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  writeFileIn,
} from '../test/helpers/git-sandbox.ts';
import { CONFIG_KEYS_OUTSIDE_DEPENDENCIES } from '../test/helpers/package-json-config.ts';
import { repoRoot } from '../test/helpers/repo-root.ts';
import {
  exportedFn,
  loadScript,
  runScript,
  sandboxWithScript,
  type ScriptModule,
} from '../test/helpers/script-module.ts';

let packageJsonDiffers: (base: string, head: string) => boolean;
let scriptModule: ScriptModule;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(
    pathToFileURL(join(import.meta.dirname, 'check-scripts.ts')).href
  )) as {
    packageJsonDiffers: typeof packageJsonDiffers;
  };
  packageJsonDiffers = mod.packageJsonDiffers;
  scriptModule = await loadScript('check-scripts.ts');
});
afterAll(cleanupTempDirs);

const dependencyVersionViolations = (packageJson: string): string[] =>
  exportedFn<(packageJson: string) => string[]>(
    scriptModule,
    'check-scripts.ts',
    'dependencyVersionViolations',
  )(packageJson);

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
    ...CONFIG_KEYS_OUTSIDE_DEPENDENCIES,
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

const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function withDependency(version: string, block = 'dependencies'): string {
  return pkg(BASE_SCRIPTS, {
    [block]: { good: '1.0.0', pkg: version },
  });
}

describe('AI-05 dependencyVersionViolations só aceita versão semver exata nos blocos de dependências', () => {
  it.each(['1.2.3', '1.2.3-rc.1', '0.0.0', '10.20.30-beta.2', '4.0.0-alpha'])(
    'AI-05 a versão exata %s passa (controle)',
    (version) => {
      expect(dependencyVersionViolations(withDependency(version))).toEqual([]);
    },
  );

  it.each([
    ['npm:', 'npm:outro@1.2.3'],
    ['file:', 'file:../pacote'],
    ['link:', 'link:../pacote'],
    ['git+https', 'git+https://github.com/a/b.git#abc123'],
    ['git+ssh', 'git+ssh://git@github.com/a/b.git'],
    ['git://', 'git://github.com/a/b.git'],
    ['atalho do GitHub', 'github:a/b'],
    ['URL https', 'https://example.com/pacote.tgz'],
    ['URL http', 'http://example.com/pacote.tgz'],
    ['circunflexo', '^1.2.3'],
    ['til', '~1.2.3'],
    ['faixa com maior ou igual', '>=1.2.3'],
    ['faixa com dois limites', '>=1.2.3 <2.0.0'],
    ['faixa com hífen', '1.2.3 - 2.0.0'],
    ['curinga x', '1.2.x'],
    ['curinga *', '*'],
    ['versão incompleta', '1.2'],
    ['só o maior', '1'],
    ['prefixo v', 'v1.2.3'],
    ['tag latest', 'latest'],
    ['tag next', 'next'],
    ['vazia', ''],
  ])('AI-05 a forma %s (%s) reprova, e cita a dependência', (_label, value) => {
    expect(dependencyVersionViolations(withDependency(value))).toEqual([
      expect.stringContaining('pkg'),
    ]);
  });

  it.each(DEPENDENCY_BLOCKS)(
    'AI-05 o circunflexo reprova no bloco %s, e a versão exata passa nele',
    (block) => {
      expect(
        dependencyVersionViolations(withDependency('^1.2.3', block)),
      ).toEqual([expect.stringContaining('pkg')]);
      expect(
        dependencyVersionViolations(withDependency('1.2.3', block)),
      ).toEqual([]);
    },
  );

  it('AI-05 cada dependência fora do padrão gera a própria violação, e as exatas não aparecem', () => {
    const text = pkg(BASE_SCRIPTS, {
      dependencies: { steady: '1.0.0', caret: '^1.0.0' },
      devDependencies: { tagged: 'latest', steadyDev: '2.0.0-rc.1' },
    });
    const violations = dependencyVersionViolations(text);

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('caret');
    expect(violations.join('\n')).toContain('tagged');
    expect(violations.join('\n')).not.toContain('steady');
  });

  it('AI-05 um package.json sem blocos de dependências passa, e versão fora desses blocos não conta', () => {
    expect(dependencyVersionViolations(pkg(BASE_SCRIPTS))).toEqual([]);
    expect(
      dependencyVersionViolations(
        pkg(BASE_SCRIPTS, {
          version: '^1.0.0',
          engines: { node: '>=24.12.0' },
        }),
      ),
    ).toEqual([]);
  });

  it('AI-05 o package.json do repositório passa', () => {
    const text = readFileSync(join(repoRoot, 'package.json'), 'utf8');

    expect(dependencyVersionViolations(text)).toEqual([]);
  });

  it('AI-05 o package.json do repositório com uma dependência em faixa reprova', () => {
    const text = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    const ranged = text.replace(/("zod": ")(\d)/, '$1^$2');

    expect(ranged).not.toBe(text);
    expect(dependencyVersionViolations(ranged)).toEqual([
      expect.stringContaining('zod'),
    ]);
  });
});

// O CLI vê o package.json do PR: a base é a origin/BASE_REF, simulada por uma ref em refs/remotes, sem rede.
function prWithDependency(version: string): ReturnType<typeof runScript> {
  const dir = sandboxWithScript('check-scripts.ts');
  const manifest = (value: string): string =>
    JSON.stringify({
      name: 'x',
      type: 'module',
      scripts: BASE_SCRIPTS,
      dependencies: { zod: value },
    });
  writeFileIn(dir, 'package.json', manifest('4.6.7'));
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileIn(dir, 'package.json', manifest(version));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'build(deps): muda a versão do zod');
  return runScript(dir, 'check-scripts.ts', { BASE_REF: 'main' });
}

describe('AI-05 o CLI do check-scripts também reprova a versão fora do padrão', () => {
  it('AI-05 trocar a dependência por uma versão exata sai com 0', () => {
    const result = prWithDependency('4.7.0');

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-05 trocar a dependência por uma faixa sai com 1, citando a dependência, mesmo num commit build:', () => {
    const result = prWithDependency('^4.7.0');

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('zod');
  });

  it('AI-05 trocar a dependência por npm: sai com 1', () => {
    const result = prWithDependency('npm:outro@1.0.0');

    expect(result.status).toBe(1);
  });
});
