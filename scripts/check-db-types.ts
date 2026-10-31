// FND-09: os tipos do banco vêm só do kysely-codegen, rodado sobre o banco migrado.
// Confere (ou grava, com --write) um arquivo por schema. Rodado direto, sobe o
// próprio PostgreSQL pelo Testcontainers, para dar o mesmo resultado na máquina e
// no CI.
//
// Todas as opções do gerador vão por flag, e o Cli recebe `config: {}`: com uma
// configuração dada, ele nem procura `.kysely-codegenrc*` ou a chave do
// package.json, que o implementer pode editar e mudariam os tipos em silêncio.
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cli } from 'kysely-codegen';
import pg from 'pg';
import { MIGRATION_FOLDERS, migrate, type MigrationFolder } from '../src/db/migrate.ts';

const DEFAULT_OUT_DIR = fileURLToPath(new URL('../src/db/types', import.meta.url));

// Um arquivo por schema; o nome do arquivo é o que o código importa.
const SCHEMAS = [
  { schema: 'public', file: 'store.ts' },
  { schema: 'erp_sim', file: 'erp-sim.ts' },
] as const;

export interface CheckDbTypesOptions {
  databaseUrl: string;
  folders?: readonly MigrationFolder[];
  // Pasta dos arquivos de tipos; o padrão é src/db/types.
  outDir?: string;
  // Grava os arquivos em vez de conferir.
  write?: boolean;
}

export function codegenArgs(databaseUrl: string, schema: string, outFile: string): string[] {
  return [
    '--dialect=postgres',
    `--url=${databaseUrl}`,
    `--include-pattern=${schema}.*`,
    // As tabelas de controle do Migrator não são do domínio (FND-09).
    '--exclude-pattern=*.kysely_migration*',
    `--out-file=${outFile}`,
    // Os valores padrão do gerador ficam escritos, para uma versão nova que mude o padrão não mudar os tipos.
    '--date-parser=timestamp',
    '--numeric-parser=string',
    '--log-level=error',
  ];
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Devolve as divergências, uma frase por arquivo; vazio quando tudo bate.
export async function checkDbTypes({
  databaseUrl,
  folders = MIGRATION_FOLDERS,
  outDir = DEFAULT_OUT_DIR,
  write = false,
}: CheckDbTypesOptions): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(pool, folders);
  } finally {
    await pool.end();
  }

  // O gerador grava sempre numa pasta temporária, e a comparação é feita aqui: com
  // o --verify, ele lança na divergência antes de fechar a própria conexão, que
  // fica aberta e derruba o processo quando o banco cai.
  const workDir = mkdtempSync(path.join(tmpdir(), 'check-db-types-'));
  const divergences: string[] = [];
  try {
    for (const { schema, file } of SCHEMAS) {
      const generated = path.join(workDir, file);
      await new Cli().run({ argv: codegenArgs(databaseUrl, schema, generated), config: {} });
      const target = path.resolve(outDir, file);
      if (write) {
        copyFileSync(generated, target);
      } else if (readOrNull(target) !== readFileSync(generated, 'utf8')) {
        divergences.push(
          `${file} diverge do schema ${schema} migrado; gere de novo com node scripts/check-db-types.ts --write`,
        );
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  // Um arquivo a mais na pasta seria um tipo do banco escrito à mão, fora da conferência.
  const expected = new Set<string>(SCHEMAS.map(({ file }) => file));
  for (const name of readdirSync(outDir)) {
    if (!expected.has(name)) {
      divergences.push(`${name} está na pasta dos tipos do banco, mas não sai do gerador; apague-o ou gere os tipos de novo`);
    }
  }
  return divergences;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Só aqui, para importar o módulo nos testes não exigir o Testcontainers.
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const write = process.argv.includes('--write');
  const container = await new PostgreSqlContainer('postgres:18.6').start();
  try {
    const divergences = await checkDbTypes({ databaseUrl: container.getConnectionUri(), write });
    for (const divergence of divergences) console.error(divergence);
    if (divergences.length === 0) console.log(write ? 'Tipos do banco gerados.' : 'Tipos do banco em dia com as migrações.');
    process.exitCode = divergences.length > 0 ? 1 : 0;
  } finally {
    await container.stop();
  }
}
