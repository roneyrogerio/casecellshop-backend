import { type Kysely, sql } from 'kysely';

// Colunas do relay e do worker sobre o SQS (AD-021). Só acrescenta: a fila na tabela
// ainda roda e a fatia seguinte remove as colunas que deixam de servir.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('outbox')
    .addColumn('published_at', 'timestamptz')
    .addColumn('call_token', 'uuid')
    .addColumn('dead_at', 'timestamptz')
    .execute();

  // O relay lê só as não publicadas; o índice parcial fica pequeno depois que quase tudo foi publicado.
  await db.schema
    .createIndex('outbox_unpublished_idx')
    .on('outbox')
    .column('created_at')
    .where(sql.ref('published_at'), 'is', null)
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('outbox_unpublished_idx').execute();
  await db.schema.alterTable('outbox').dropColumn('published_at').dropColumn('call_token').dropColumn('dead_at').execute();
}
