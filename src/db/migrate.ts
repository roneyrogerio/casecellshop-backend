import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { Pool } from 'pg';
import { withClient } from './client.ts';

const MIGRATIONS = [
  { dir: 'store', schema: 'public' },
  { dir: 'erp_sim', schema: 'erp_sim' },
] as const;

// Aplica as migrações dos dois schemas, cada um com a sua tabela de controle.
// O runner usa um advisory lock (espera, não falha) e confere a ordem; cada
// arquivo roda numa transação própria.
export async function migrate(pool: Pool): Promise<void> {
  for (const { dir, schema } of MIGRATIONS) {
    await withClient(pool, async (client) => {
      await runner({
        dbClient: client,
        dir: fileURLToPath(new URL(`../../migrations/${dir}`, import.meta.url)),
        direction: 'up',
        migrationsTable: 'pgmigrations',
        migrationsSchema: schema,
        createMigrationsSchema: true,
        checkOrder: true,
        singleTransaction: false,
        advisoryLockMode: 'wait',
        // Silencia o console do runner; quem chama registra o resultado.
        logger: { debug: undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      });
    });
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
  for (const [sku, name, priceCents, onHand] of SEED_PRODUCTS) {
    await pool.query(
      'INSERT INTO erp_sim.products (sku, name, price_cents, on_hand) VALUES ($1, $2, $3, $4) ON CONFLICT (sku) DO NOTHING',
      [sku, name, priceCents, onHand],
    );
  }
}
