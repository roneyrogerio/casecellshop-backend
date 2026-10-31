import type { Kysely } from 'kysely';

// Depende da tabela criada pela pasta "primeira": se a ordem das pastas não for respeitada, falha.
export async function up(db: Kysely<any>): Promise<void> {
  await db.insertInto('fnd11_ordem_log').values({ quem: 'segunda-1' }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('fnd11_ordem_log').where('quem', '=', 'segunda-1').execute();
}
