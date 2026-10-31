import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.insertInto('fnd11_ordem_log').values({ quem: 'primeira-2' }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('fnd11_ordem_log').where('quem', '=', 'primeira-2').execute();
}
