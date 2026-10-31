import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import type { Pool } from 'pg';
import { createErpDb, createPoolAdapter } from './database.ts';

export interface MigrationFolder {
  // Caminho absoluto da pasta de migrações.
  dir: string;
  schema: string;
}

// Loja antes do erp_sim; os testes do FND-11 passam pastas próprias.
export const MIGRATION_FOLDERS: readonly MigrationFolder[] = [
  { dir: fileURLToPath(new URL('../../migrations/store', import.meta.url)), schema: 'public' },
  { dir: fileURLToPath(new URL('../../migrations/erp_sim', import.meta.url)), schema: 'erp_sim' },
];

// Um arquivo ignorado (extensão errada, sem `up`) seria pulado em silêncio pelo
// provider; aqui vira erro, para uma migração nunca deixar de rodar sem aviso.
function createProvider(dir: string): FileMigrationProvider {
  return new FileMigrationProvider({
    fs,
    path,
    migrationFolder: dir,
    onFileIgnored: (fileName) => {
      if (fileName === '.gitkeep') return;
      throw new Error(`arquivo ignorado na pasta de migrações: ${fileName}`);
    },
    import: async (filePath: string) => {
      const fileName = path.basename(filePath);
      if (!filePath.endsWith('.ts')) {
        throw new Error(`migração com extensão inválida (esperado .ts): ${fileName}`);
      }
      const module: unknown = await import(filePath);
      if (typeof (module as { down?: unknown }).down !== 'function') {
        throw new Error(`migração sem a exportação down: ${fileName}`);
      }
      return module;
    },
  });
}

// Aplica as migrações dos dois schemas, cada um com a sua tabela de controle.
// O Migrator espera pelo advisory lock, reprova migração fora de ordem e aplica
// as pendentes de cada schema numa transação só.
export async function migrate(pool: Pool, folders: readonly MigrationFolder[] = MIGRATION_FOLDERS): Promise<void> {
  // Não chamamos db.destroy(): o pool pertence a quem chamou.
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: createPoolAdapter(pool) }) });
  for (const { dir, schema } of folders) {
    const migrator = new Migrator({
      db,
      provider: createProvider(dir),
      migrationTableSchema: schema,
    });
    const { error, results } = await migrator.migrateToLatest();
    // `if (error)` deixaria passar um erro falso (uma migração que lança null); o
    // resultado com status Error e a presença da chave também reprovam.
    const failed = results?.some((result) => result.status === 'Error') ?? false;
    if (error !== undefined || failed) {
      // O erro original segue sem embrulho, para a mensagem da migração aparecer.
      throw error instanceof Error ? error : new Error('falha ao migrar', { cause: error });
    }
  }
}

const SEED_PRODUCTS: [sku: string, name: string, priceCents: number, onHand: number][] = [
  ['CAPA-IP15-PRETA', 'Capa iPhone 15 preta', 7990, 40],
  ['CAPA-IP15-AZUL', 'Capa iPhone 15 azul', 7990, 25],
  ['CAPA-S24-TRANSP', 'Capa Galaxy S24 transparente', 5990, 60],
  ['CAPA-S24-VERDE', 'Capa Galaxy S24 verde', 6490, 8],
  ['CAPA-MOTO-G84', 'Capa Moto G84 antichoque', 4990, 100],
  ['PELICULA-IP15', 'Película de vidro iPhone 15', 3990, 120],
  ['PELICULA-S24', 'Película de vidro Galaxy S24', 3990, 90],
  ['CARREGADOR-20W', 'Carregador de parede 20 W', 12990, 3],
  ['CABO-USBC-1M', 'Cabo USB-C de 1 m', 2990, 200],
  ['FONE-BT-PRETO', 'Fone Bluetooth preto', 18990, 15],
];

// Catálogo de exemplo do ERP simulado. Idempotente: rodar de novo não repõe
// estoque nem muda preço que já existe.
export async function seed(pool: Pool): Promise<void> {
  const db = createErpDb(pool);
  for (const [sku, name, priceCents, onHand] of SEED_PRODUCTS) {
    await db
      .insertInto('erp_sim.products')
      .values({ sku, name, price_cents: priceCents, on_hand: onHand })
      .onConflict((oc) => oc.column('sku').doNothing())
      .execute();
  }
}
