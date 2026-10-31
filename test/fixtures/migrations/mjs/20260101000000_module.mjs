// Migração válida para o provider do Kysely, mas fora da convenção do projeto (só .ts).
export async function up(db) {
  await db.schema
    .createTable('fnd11_mjs')
    .addColumn('id', 'integer', (col) => col.primaryKey())
    .execute();
}

export async function down(db) {
  await db.schema.dropTable('fnd11_mjs').execute();
}
