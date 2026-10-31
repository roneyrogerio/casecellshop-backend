import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.insertInto('fnd11_order_log').values({ who: 'first-2' }).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.deleteFrom('fnd11_order_log').where('who', '=', 'first-2').execute();
}
