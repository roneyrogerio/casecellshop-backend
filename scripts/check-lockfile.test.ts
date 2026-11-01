import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, writeFileIn } from '../test/helpers/git-sandbox.ts';
import { repoRoot } from '../test/helpers/repo-root.ts';
import {
  exportedFn,
  loadScript,
  runScript,
  sandboxWithScript,
  type ScriptModule,
} from '../test/helpers/script-module.ts';

// AI-05: todo pacote do package-lock.json vem de https://registry.npmjs.org/ e traz integrity sha512. Um lockfile
// apontando para outro host, para git ou para arquivo local trocaria uma ferramenta da verificação sem mudar o nome.
const FILE = 'check-lockfile.ts';
const GOOD_RESOLVED = 'https://registry.npmjs.org/zod/-/zod-4.6.7.tgz';
const GOOD_INTEGRITY = 'sha512-AAAA';

let mod: ScriptModule;
beforeAll(async () => {
  mod = await loadScript(FILE);
});
afterAll(cleanupTempDirs);

const lockfileViolations = (lockText: string): string[] =>
  exportedFn<(lockText: string) => string[]>(
    mod,
    FILE,
    'lockfileViolations',
  )(lockText);

function lock(packages: Record<string, Record<string, unknown>>): string {
  return JSON.stringify(
    { name: 'x', lockfileVersion: 3, requires: true, packages },
    null,
    2,
  );
}

const ROOT = { '': { name: 'x', version: '0.0.0' } };
const GOOD_ENTRY = { resolved: GOOD_RESOLVED, integrity: GOOD_INTEGRITY };

describe('AI-05 lockfileViolations confere a origem e a integridade de cada pacote do lockfile', () => {
  it('AI-05 um lockfile só com pacotes do registro e integrity sha512 passa (controle)', () => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': GOOD_ENTRY,
      'node_modules/a/node_modules/b': {
        resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz',
        integrity: 'sha512-BBBB',
        dev: true,
      },
    });

    expect(lockfileViolations(text)).toEqual([]);
  });

  it('AI-05 só a raiz "", sem resolved nem integrity, fica de fora', () => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': GOOD_ENTRY,
    });

    expect(lockfileViolations(text)).toEqual([]);
  });

  it('AI-05 uma dependência aninhada em qualquer nível, com registro e integrity sha512, passa (controle)', () => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': GOOD_ENTRY,
      'packages/a/node_modules/lodash': {
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
        integrity: 'sha512-CCCC',
      },
    });

    expect(lockfileViolations(text)).toEqual([]);
  });

  it('AI-05 o pacote ruim ao lado da raiz continua reprovando (a exceção não vira passe livre)', () => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': {
        resolved: 'file:../zod',
        integrity: GOOD_INTEGRITY,
      },
    });

    expect(lockfileViolations(text)).toEqual([
      expect.stringContaining('node_modules/zod'),
    ]);
  });

  it.each([
    ['outro host', 'https://registry.evil.example/zod/-/zod-4.6.7.tgz'],
    ['http sem TLS', 'http://registry.npmjs.org/zod/-/zod-4.6.7.tgz'],
    ['git+https', 'git+https://github.com/colinhacks/zod.git#abc123'],
    ['git+ssh', 'git+ssh://git@github.com/colinhacks/zod.git#abc123'],
    ['file:', 'file:../zod'],
    ['host parecido', 'https://registry.npmjs.org.evil.example/zod.tgz'],
    ['o registro como subdomínio', 'https://x.registry.npmjs.org/zod.tgz'],
    ['o registro no meio da URL', 'https://evil.example/registry.npmjs.org/'],
  ])('AI-05 resolved com %s reprova, e cita o pacote', (_label, resolved) => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': { resolved, integrity: GOOD_INTEGRITY },
    });

    expect(lockfileViolations(text)).toEqual([
      expect.stringContaining('node_modules/zod'),
    ]);
  });

  it.each([
    ['ausente', undefined],
    ['sha1', 'sha1-AAAA'],
    ['sha256', 'sha256-AAAA'],
    ['vazia', ''],
  ])('AI-05 integrity %s reprova, e cita o pacote', (_label, integrity) => {
    const entry: Record<string, unknown> = { resolved: GOOD_RESOLVED };
    if (integrity !== undefined) entry.integrity = integrity;
    const text = lock({ ...ROOT, 'node_modules/zod': entry });

    expect(lockfileViolations(text)).toEqual([
      expect.stringContaining('node_modules/zod'),
    ]);
  });

  it('AI-05 cada pacote ruim gera a própria violação, e os bons não aparecem', () => {
    const text = lock({
      ...ROOT,
      'node_modules/good': GOOD_ENTRY,
      'node_modules/bad-host': {
        resolved: 'https://evil.example/x.tgz',
        integrity: GOOD_INTEGRITY,
      },
      'node_modules/bad-integrity': { resolved: GOOD_RESOLVED },
    });
    const violations = lockfileViolations(text);

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('node_modules/bad-host');
    expect(violations.join('\n')).toContain('node_modules/bad-integrity');
    expect(violations.join('\n')).not.toContain('node_modules/good');
  });

  // O projeto não usa workspaces: o link trocaria um pacote baixado por código local com o mesmo nome.
  it.each([
    [
      'o link para uma pasta local',
      'node_modules/vitest',
      { link: true, resolved: 'src/vitest' },
    ],
    [
      'o link do workspace',
      'node_modules/x',
      { resolved: 'packages/x', link: true },
    ],
    ['o link sem resolved', 'node_modules/local', { link: true }],
    [
      'a pasta sem resolved',
      'packages/local',
      { name: 'local', version: '1.0.0' },
    ],
    ['a pasta com registro e integrity', 'packages/a', GOOD_ENTRY],
    [
      'o pacote fora do registro e sem integrity, sob outra pasta com node_modules/',
      'tools/x/node_modules/evil',
      { resolved: 'https://evil.example/evil.tgz' },
    ],
    [
      'o pacote aninhado com resolved fora do registro',
      'packages/a/node_modules/lodash',
      { resolved: 'file:../lodash', integrity: GOOD_INTEGRITY },
    ],
  ])('AI-05 %s reprova, e cita a entrada', (_label, key, entry) => {
    // Uma violação por entrada, citando a chave dela.
    const text = lock({
      ...ROOT,
      'node_modules/zod': GOOD_ENTRY,
      [key]: entry,
    });

    expect(lockfileViolations(text)).toEqual([expect.stringContaining(key)]);
  });

  it('AI-05 um lockfile com lockfileVersion 1 (pacotes em dependencies, sem packages) reprova, e cita lockfileVersion', () => {
    const text = JSON.stringify({
      name: 'x',
      lockfileVersion: 1,
      requires: true,
      dependencies: {
        zod: { version: '4.6.7', resolved: GOOD_RESOLVED },
      },
    });

    expect(lockfileViolations(text)).toEqual([
      expect.stringContaining('lockfileVersion'),
    ]);
  });

  it('AI-05 um lockfile com lockfileVersion 2 e packages passa', () => {
    const text = JSON.stringify({
      name: 'x',
      lockfileVersion: 2,
      packages: { ...ROOT, 'node_modules/zod': GOOD_ENTRY },
    });

    expect(lockfileViolations(text)).toEqual([]);
  });

  it.each([
    ['um objeto vazio', '{}'],
    ['sem packages', JSON.stringify({ name: 'x', lockfileVersion: 3 })],
    [
      'packages nulo',
      JSON.stringify({ name: 'x', lockfileVersion: 3, packages: null }),
    ],
    [
      'packages como lista',
      JSON.stringify({
        name: 'x',
        lockfileVersion: 3,
        packages: [GOOD_ENTRY],
      }),
    ],
    [
      'packages como texto',
      JSON.stringify({ name: 'x', lockfileVersion: 3, packages: 'texto' }),
    ],
  ])(
    'AI-05 %s reprova (sem packages não há o que conferir, e passar seria falso)',
    (_label, text) => {
      const violations = lockfileViolations(text);

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.join('\n')).toMatch(/packages|lockfileVersion/);
    },
  );

  it.each([
    ['sem resolved nem integrity', {}],
    ['sem resolved', { integrity: GOOD_INTEGRITY }],
    ['sem integrity', { resolved: GOOD_RESOLVED }],
    ['com link: false e sem resolved', { link: false }],
  ])(
    'AI-05 uma entrada %s, que não é a raiz nem link, reprova e cita o pacote',
    (_label, entry) => {
      const text = lock({ ...ROOT, 'node_modules/zod': entry });

      expect(lockfileViolations(text)).toEqual([
        expect.stringContaining('node_modules/zod'),
      ]);
    },
  );

  it('AI-05 o package-lock.json do repositório passa', () => {
    const text = readFileSync(join(repoRoot, 'package-lock.json'), 'utf8');

    expect(lockfileViolations(text)).toEqual([]);
  });
});

describe('AI-05 o CLI do check-lockfile lê o package-lock.json da raiz', () => {
  it('AI-05 o lockfile bom sai com 0 e o com pacote fora do registro sai com 1, citando o pacote', () => {
    const good = sandboxWithScript(FILE);
    writeFileIn(
      good,
      'package-lock.json',
      lock({ ...ROOT, 'node_modules/zod': GOOD_ENTRY }),
    );
    const bad = sandboxWithScript(FILE);
    writeFileIn(
      bad,
      'package-lock.json',
      lock({
        ...ROOT,
        'node_modules/zod': {
          resolved: 'https://evil.example/zod.tgz',
          integrity: GOOD_INTEGRITY,
        },
      }),
    );

    const ok = runScript(good, FILE);
    const denied = runScript(bad, FILE);

    expect(ok.status, ok.stderr).toBe(0);
    expect(denied.status).toBe(1);
    expect(denied.stderr + denied.stdout).toContain('node_modules/zod');
  });
});
