import { type Kysely, sql } from 'kysely';

// Recusa definitiva depois de um envio sem resposta (AD-031): o motivo e o início da janela de
// assentamento ficam na outbox, porque a conclusão só vem depois dela, em outra tentativa.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('outbox')
    .addColumn('refusal_reason', 'text', (col) =>
      col.check(sql`refusal_reason in ('erp_rejected', 'erp_out_of_stock')`),
    )
    .addColumn('refused_at', 'timestamptz')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('outbox')
    .dropColumn('refusal_reason')
    .dropColumn('refused_at')
    .execute();
}
