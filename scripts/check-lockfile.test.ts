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

  it('AI-05 a raiz e o link do workspace, sem resolved, ficam de fora', () => {
    const text = lock({
      ...ROOT,
      'node_modules/zod': GOOD_ENTRY,
      'node_modules/local': { link: true },
      'packages/local': { name: 'local', version: '1.0.0' },
    });

    expect(lockfileViolations(text)).toEqual([]);
  });

  it('AI-05 o pacote ruim ao lado da raiz e do link continua reprovando (a exceção não vira passe livre)', () => {
    const text = lock({
      ...ROOT,
      'node_modules/local': { link: true },
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
