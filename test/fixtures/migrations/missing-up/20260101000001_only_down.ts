import type { Kysely } from 'kysely';

// Exporta só o down: o provider do Kysely não o reconhece como migração e o ignora (NotMigration).
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('fnd11_missing_up_only_down').execute();
}
