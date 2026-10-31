import type { ExpressionBuilder, Kysely } from 'kysely';

// Troca a unicidade de invoices.reference por uma dedup_key única e anulável: com a H1b
// a criação grava dedup_key = reference; sem ela grava NULL, e o PostgreSQL aceita
// vários NULL numa restrição única, então cada criação vira uma fatura nova.
export async function up(db: Kysely<any>): Promise<void> {
  const schema = db.schema.withSchema('erp_sim');
  await schema.alterTable('invoices').addColumn('dedup_key', 'text', (col) => col.unique()).execute();
  // As faturas que já existem foram criadas com a H1b, então a chave delas é a própria referência.
  await db
    .withSchema('erp_sim')
    .updateTable('invoices')
    .set({ dedup_key: (eb: ExpressionBuilder<any, any>) => eb.ref('reference') })
    .execute();
  // Nome padrão do PostgreSQL para a restrição criada com `unique()` na migração inicial.
  await schema.alterTable('invoices').dropConstraint('invoices_reference_key').execute();
  // A consulta pela referência (H1a) continua precisando de índice, agora sem unicidade.
  await schema.createIndex('invoices_reference_idx').on('invoices').column('reference').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  const schema = db.schema.withSchema('erp_sim');
  await schema.dropIndex('invoices_reference_idx').execute();
  await schema.alterTable('invoices').addUniqueConstraint('invoices_reference_key', ['reference']).execute();
  await schema.alterTable('invoices').dropColumn('dedup_key').execute();
}
