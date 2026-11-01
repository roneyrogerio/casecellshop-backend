import type { Kysely } from 'kysely';

// Depende da tabela criada pela pasta "first": se a ordem das pastas não for respeitada, falha.
export async function up(db: Kysely<any>): Promise<void> {
  await db.insertInto('fnd11_order_log').values({ who: 'second-1' }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('fnd11_order_log').where('who', '=', 'second-1').execute();
}
