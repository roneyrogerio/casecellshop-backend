import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { typecheckSample } from '../helpers/lint-tree.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';

interface TsConfig {
  include: string[];
}

interface OxlintOverride {
  files: string[];
  rules: Record<string, unknown>;
}

describe('FND-11 as migrações entram no typecheck e no lint do repositório', () => {
  it('FND-11 o include do tsconfig.json tem a pasta migrations', () => {
    const config = JSON.parse(
      readFileSync(path.join(root, 'tsconfig.json'), 'utf8'),
    ) as TsConfig;

    expect(config.include).toContain('migrations');
  });

  it('FND-11 o overrides do .oxlintrc.json para as migrações desliga só o no-explicit-any', () => {
    const config = JSON.parse(
      readFileSync(path.join(root, '.oxlintrc.json'), 'utf8'),
    ) as {
      overrides: OxlintOverride[];
    };

    const override = config.overrides.find((entry) =>
      entry.files.includes('**/migrations/**/*.ts'),
    );

    expect(override?.rules).toEqual({ 'typescript/no-explicit-any': 'off' });
  });
});

// Pasta no tmpdir do sistema, e não no repositório (mesma razão do AI-20): um lint paralelo ou uma
// execução interrompida esbarraria no arquivo de amostra.
describe('FND-11 uma migração com erro de tipo reprova o typecheck', () => {
  afterEach(cleanupTempDirs);

  function typecheck(columnType: string): {
    status: number | null;
    output: string;
  } {
    const source = `import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createTable('amostra').addColumn('id', '${columnType}').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('amostra').execute();
}
`;
    return typecheckSample('fnd11-tsc-', source);
  }

  it('FND-11 um tipo de coluna que o construtor de esquema do Kysely não conhece reprova no tsc', () => {
    const result = typecheck('inteiro_inexistente');

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).toContain('amostra.ts');
    expect(result.output).toContain('inteiro_inexistente');
  }, 60_000);

  it('FND-11 a mesma migração corrigida passa no tsc', () => {
    const result = typecheck('integer');

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
