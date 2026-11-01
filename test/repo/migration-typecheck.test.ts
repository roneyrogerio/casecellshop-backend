import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);

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
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'fnd11-tsc-'));
    // O `import 'kysely'` da migração resolve pelo node_modules do repositório.
    symlinkSync(
      path.join(root, 'node_modules'),
      path.join(tree, 'node_modules'),
      'dir',
    );
    // Fora do repositório não há o `"type": "module"` da raiz, e o `export` da amostra seria lido como CommonJS.
    writeFileSync(
      path.join(tree, 'package.json'),
      JSON.stringify({ type: 'module' }),
    );
    // Herda as opções do repositório por caminho absoluto; `include` é refeito porque o herdado valeria
    // para as pastas do repositório, e `typeRoots` aponta para o repositório porque, fora dele, os tipos
    // do Node não são achados.
    writeFileSync(
      path.join(tree, 'tsconfig.json'),
      JSON.stringify({
        extends: path.join(root, 'tsconfig.json'),
        compilerOptions: {
          typeRoots: [path.join(root, 'node_modules', '@types')],
        },
        include: ['*.ts'],
      }),
    );
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

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
    writeFileSync(path.join(tree, '20260101000000_amostra.ts'), source);
    const result = spawnSync(
      path.join(root, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '-p', path.join(tree, 'tsconfig.json')],
      { cwd: root, encoding: 'utf8' },
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  it('FND-11 um tipo de coluna que o construtor de esquema do Kysely não conhece reprova no tsc', () => {
    const result = typecheck('inteiro_inexistente');

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).toContain('20260101000000_amostra.ts');
    expect(result.output).toContain('inteiro_inexistente');
  }, 60_000);

  it('FND-11 a mesma migração corrigida passa no tsc', () => {
    const result = typecheck('integer');

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
