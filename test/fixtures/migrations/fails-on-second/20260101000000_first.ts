import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('fnd11_fail_first')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_fail_first').execute();
}
