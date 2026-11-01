import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

interface SourceFile {
  path: string;
  content: string;
}

// Todo módulo que o arquivo importa: `from '…'`, `import '…'`, `import('…')` e `require('…')`, com
// aspas simples, duplas ou crase (o template literal sem interpolação também é um import válido).
// Uma migração só pode importar de `kysely` (e de subcaminhos dele): nada de `src/`, de caminho
// relativo ou de `node:`, para uma constante da aplicação que mude depois não mudar o esquema que
// uma migração antiga cria.
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;

function isAllowedSpecifier(specifier: string): boolean {
  return specifier === 'kysely' || specifier.startsWith('kysely/');
}

function findMigrationImportViolations(files: SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const match of file.content.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier !== undefined && !isAllowedSpecifier(specifier)) {
        violations.push(
          `${file.path} importa de '${specifier}', e uma migração só pode importar de kysely`,
        );
      }
    }
  }
  return violations;
}

// Todo arquivo de migrations/ (a menos do .gitkeep), com o caminho relativo à raiz.
function listMigrationFiles(): string[] {
  const dir = path.join(root, 'migrations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)),
    )
    .sort();
}

describe('FND-11 as migrações do repositório são .ts e só importam de kysely', () => {
  it('FND-11 todo arquivo de migrations/ é um .ts com nome AAAAMMDDHHMMSS_nome.ts, e a migração erp_sim está lá', () => {
    const files = listMigrationFiles();

    expect(files).toContain(
      'migrations/erp_sim/20260101000000_create_erp_sim.ts',
    );
    for (const file of files) {
      expect(path.basename(file), file).toMatch(/^\d{14}_[a-z0-9_]+\.ts$/);
    }
  });

  it('FND-11 cada arquivo de migrations/ só importa de kysely, sem import de src/ nem relativo', () => {
    const files = listMigrationFiles()
      .filter((file) => file.endsWith('.ts'))
      .map((file) => ({
        path: file,
        content: readFileSync(path.join(root, file), 'utf8'),
      }));

    // Sem nenhum .ts a conferência passaria vazia: a migração erp_sim em .ts precisa existir.
    expect(files.length).toBeGreaterThan(0);
    expect(findMigrationImportViolations(files)).toEqual([]);
  });
});

describe('FND-11 controle negativo do conferidor de imports das migrações', () => {
  const sample = (importLine: string): SourceFile[] => [
    {
      path: 'migrations/store/20260101000000_amostra.ts',
      content: `${importLine}\n\nexport async function up(db: Kysely<any>): Promise<void> {\n  await db.schema.dropTable('x').execute();\n}\n`,
    },
  ];

  it.each([
    ["import type { Kysely } from 'kysely';"],
    ["import { type Kysely, sql } from 'kysely';"],
    ["import {\n  type Kysely,\n  sql,\n} from 'kysely';"],
    ["import { jsonArrayFrom } from 'kysely/helpers/postgres';"],
    ['const { sql } = await import(`kysely`);'],
    ['const helpers = await import(`kysely/helpers/postgres`);'],
  ])('FND-11 aceita o import de kysely: %s', (importLine) => {
    expect(findMigrationImportViolations(sample(importLine))).toEqual([]);
  });

  it.each([
    [
      "import { TABLE } from '../../src/db/constants.ts';",
      '../../src/db/constants.ts',
    ],
    [
      "import type { DB } from '../../src/db/types/store.ts';",
      '../../src/db/types/store.ts',
    ],
    ["import { x } from './outra-migracao.ts';", './outra-migracao.ts'],
    [
      "import {\n  TABLE,\n} from '../../src/db/constants.ts';",
      '../../src/db/constants.ts',
    ],
    ["import '../../src/setup.ts';", '../../src/setup.ts'],
    [
      "export { TABLE } from '../../src/db/constants.ts';",
      '../../src/db/constants.ts',
    ],
    [
      "const { TABLE } = await import('../../src/db/constants.ts');",
      '../../src/db/constants.ts',
    ],
    [
      'const { TABLE } = await import(`../../src/db/constants.ts`);',
      '../../src/db/constants.ts',
    ],
    [
      'const { TABLE } = require(`../../src/db/constants.ts`);',
      '../../src/db/constants.ts',
    ],
    ['const { readFileSync } = await import(`node:fs`);', 'node:fs'],
    ["import { readFileSync } from 'node:fs';", 'node:fs'],
    ["import pg from 'pg';", 'pg'],
  ])('FND-11 reprova o import fora de kysely: %s', (importLine, specifier) => {
    const violations = findMigrationImportViolations(sample(importLine));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'migrations/store/20260101000000_amostra.ts',
    );
    expect(violations[0]).toContain(specifier);
  });

  it('FND-11 uma violação por import: o import de kysely ao lado do de src/ não a esconde', () => {
    const files = sample(
      "import { sql } from 'kysely';\nimport { TABLE } from '../../src/db/constants.ts';",
    );

    expect(findMigrationImportViolations(files)).toHaveLength(1);
  });
});
