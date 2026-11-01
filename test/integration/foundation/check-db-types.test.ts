import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkDbTypes } from '../../../scripts/check-db-types.ts';
import { migrate } from '../../../src/db/migrate.ts';
import {
  fixtureFolder,
  type MigrationContainer,
  startMigrationContainer,
} from '../../helpers/migration-database.ts';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)).replace(
  /\/$/,
  '',
);
const versionedDir = path.join(repoRoot, 'src', 'db', 'types');
const TYPE_FILES = ['store.ts', 'erp-sim.ts'];

let container: MigrationContainer;
const tempDirs: string[] = [];

beforeAll(async () => {
  container = await startMigrationContainer();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// Pasta no temporário do sistema, nunca dentro do repositório: um lint paralelo esbarraria nela.
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fnd09-'));
  tempDirs.push(dir);
  return dir;
}

function copyVersionedTypes(): string {
  const dir = makeTempDir();
  for (const file of TYPE_FILES)
    cpSync(path.join(versionedDir, file), path.join(dir, file));
  return dir;
}

describe('FND-09 a conferência dos tipos do banco', () => {
  it('FND-09 as pastas do repositório e o outDir padrão, sobre um banco novo, não têm divergência: os arquivos versionados batem com o banco', async () => {
    const { uri } = await container.createDatabase();

    await expect(checkDbTypes({ databaseUrl: uri })).resolves.toEqual([]);
  });

  it.each([
    ['erp_sim', 'erp-sim.ts', 'erp-sim-extra'],
    ['public', 'store.ts', 'store-extra'],
  ])(
    'FND-09 controle negativo: uma migração nova no schema %s, sem os tipos gerados de novo, devolve divergência citando %s',
    async (_schema, typeFile, fixtureName) => {
      const { uri, pool } = await container.createDatabase();
      // A migração nova entra junto das do repositório, com a tabela de controle num schema próprio:
      // duas pastas com a mesma tabela de controle fariam o Migrator reprovar a migração "ausente".
      await migrate(pool);
      await migrate(pool, [
        fixtureFolder(`db-types/${fixtureName}`, 'fnd09_controle'),
      ]);

      const divergences = await checkDbTypes({ databaseUrl: uri });

      expect(divergences.length).toBeGreaterThan(0);
      expect(divergences.some((sentence) => sentence.includes(typeFile))).toBe(
        true,
      );
    },
  );

  it('FND-09 controle negativo: um arquivo de tipos editado à mão devolve divergência citando só esse arquivo', async () => {
    const { uri } = await container.createDatabase();
    const outDir = copyVersionedTypes();
    const target = path.join(outDir, 'erp-sim.ts');
    const original = readFileSync(target, 'utf8');
    const edited = original.replace(
      'export interface DB {',
      'export interface DB {\n  editado_a_mao: never;',
    );
    expect(edited).not.toBe(original);
    writeFileSync(target, edited);

    const divergences = await checkDbTypes({ databaseUrl: uri, outDir });

    expect(
      divergences.some((sentence) => sentence.includes('erp-sim.ts')),
    ).toBe(true);
    expect(divergences.some((sentence) => sentence.includes('store.ts'))).toBe(
      false,
    );
  });

  it('FND-09 controle negativo: um arquivo a mais no outDir (extra.ts, escrito à mão) devolve divergência citando esse arquivo', async () => {
    const { uri } = await container.createDatabase();
    const outDir = copyVersionedTypes();
    writeFileSync(
      path.join(outDir, 'extra.ts'),
      'export interface Extra {\n  coluna: string;\n}\n',
    );

    const divergences = await checkDbTypes({ databaseUrl: uri, outDir });

    expect(divergences.some((sentence) => sentence.includes('extra.ts'))).toBe(
      true,
    );
    // Os dois arquivos gerados continuam batendo: só o que sobra é citado.
    expect(divergences.some((sentence) => sentence.includes('store.ts'))).toBe(
      false,
    );
    expect(
      divergences.some((sentence) => sentence.includes('erp-sim.ts')),
    ).toBe(false);
  });

  it('FND-09 a cópia dos versionados, sem edição, não tem divergência (o par do controle negativo da edição à mão)', async () => {
    const { uri } = await container.createDatabase();
    const outDir = copyVersionedTypes();

    await expect(checkDbTypes({ databaseUrl: uri, outDir })).resolves.toEqual(
      [],
    );
  });

  it('FND-09 write: true numa pasta temporária grava os arquivos de cada schema, e depois eles conferem sem divergência', async () => {
    const { uri } = await container.createDatabase();
    const outDir = makeTempDir();

    await checkDbTypes({ databaseUrl: uri, outDir, write: true });

    expect(readdirSync(outDir).sort()).toEqual([...TYPE_FILES].sort());
    await expect(checkDbTypes({ databaseUrl: uri, outDir })).resolves.toEqual(
      [],
    );
  });

  it('FND-09 o arquivo gerado não traz kysely_migration nem kysely_migration_lock, nem enum', async () => {
    // As duas tabelas de controle existem no banco migrado: o gerador precisa deixá-las de fora.
    const { uri, pool } = await container.createDatabase();
    await migrate(pool);
    const outDir = makeTempDir();

    await checkDbTypes({ databaseUrl: uri, outDir, write: true });

    const generated = readdirSync(outDir);
    expect(generated.length).toBeGreaterThan(0);
    for (const file of generated) {
      const content = readFileSync(path.join(outDir, file), 'utf8');
      expect(content, file).not.toContain('kysely_migration');
      expect(content, file).not.toContain('KyselyMigration');
      expect(content, file).not.toMatch(/\benum\b/);
    }
  });
});

describe('FND-09 o script ignora a configuração do kysely-codegen em arquivo e no package.json', () => {
  // Pasta de trabalho com as duas formas de configuração, as duas pedindo camelCase.
  function makeConfiguredCwd(): string {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, '.kysely-codegenrc.json'),
      JSON.stringify({ camelCase: true }),
    );
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'amostra-fnd09',
        'kysely-codegen': { camelCase: true },
      }),
    );
    return dir;
  }

  it('FND-09 o gerador honra essa configuração quando roda sozinho nessa pasta (a precondição do teste do script)', async () => {
    const { uri, pool } = await container.createDatabase();
    await migrate(pool);
    const cwd = makeConfiguredCwd();

    const output = execFileSync(
      path.join(repoRoot, 'node_modules', '.bin', 'kysely-codegen'),
      [
        '--dialect',
        'postgres',
        '--url',
        uri,
        '--default-schema',
        'erp_sim',
        '--print',
      ],
      { cwd, encoding: 'utf8' },
    );

    // Sem a configuração, a coluna sairia como on_hand.
    expect(output).toContain('onHand');
  });

  it('FND-09 com .kysely-codegenrc.json e package.json pedindo camelCase no process.cwd(), a conferência dos versionados continua sem divergência', async () => {
    const { uri } = await container.createDatabase();
    const originalCwd = process.cwd();
    process.chdir(makeConfiguredCwd());
    try {
      await expect(checkDbTypes({ databaseUrl: uri })).resolves.toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('FND-09 o script não grava nada na pasta de onde foi chamado (trabalha numa pasta temporária vazia)', async () => {
    const { uri } = await container.createDatabase();
    const cwd = makeConfiguredCwd();
    const before = readdirSync(cwd).sort();
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      await expect(checkDbTypes({ databaseUrl: uri })).resolves.toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }

    expect(readdirSync(cwd).sort()).toEqual(before);
  });
});
