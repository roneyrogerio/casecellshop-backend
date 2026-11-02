import { randomUUID } from 'node:crypto';
import { expressionBuilder, type Kysely, sql } from 'kysely';
import type { StoreDb } from '../db/database.ts';

// Fora do callback do set: a regra do Kysely exige o objeto, e o coalesce precisa citar a coluna.
export const outbox = expressionBuilder<StoreDb, 'outbox'>();

// Permissão de chamada por pedido (AD-024; design.md, "Worker: envio"): uma
// chamada ao ERP por pedido a cada atraso mínimo, pelo relógio do banco.

// Atraso mínimo entre duas chamadas ao ERP do mesmo pedido, contado do início da última (H4 mais a
// ida da requisição). O worker e a reconciliação tomam a mesma permissão, então partilham o valor.
export const MIN_CALL_DELAY_MS = 45_000;

// Janela de assentamento (AD-031): bem maior que a H4, a criação em dúvida já concluiu ou foi abandonada.
// Vale para a verificação tardia, o cancelamento e a recusa que vem depois de outro envio.
export const SETTLE_WINDOW_MS = 900_000;

export type CallPermit =
  | { granted: true; token: string; sentBefore: boolean }
  // Outra tentativa chamou o ERP há menos que o atraso mínimo.
  | { granted: false; retryInMs: number };

export interface TakeCallPermitOptions {
  minDelayMs: number;
  // Só o worker zera o dead_at; a reconciliação não.
  clearDead: boolean;
}

export function intervalOf(ms: number) {
  return sql<Date>`make_interval(secs => ${ms / 1000})`;
}

// O que só a tomada do worker grava. A marca de envio (AD-031) soma quando first_sent_at era nulo, porque
// a criação vem logo depois; soma antes da chamada: contar a mais é inofensivo, contar a menos é impossível.
function workerOnlyColumns() {
  return {
    dead_at: null,
    create_calls: outbox
      .case()
      .when(outbox('first_sent_at', 'is', null))
      .then(outbox('create_calls', '+', 1))
      .else(outbox.ref('create_calls'))
      .end(),
  };
}

// Um UPDATE só: a condição e a gravação juntas é que impedem duas tentativas de ganharem a mesma
// permissão (ler e gravar em dois comandos deixaria uma janela).
export async function takeCallPermit(
  db: Kysely<StoreDb>,
  orderId: string,
  { minDelayMs, clearDead }: TakeCallPermitOptions,
): Promise<CallPermit> {
  const token = randomUUID();
  const taken = await db
    .updateTable('outbox')
    .set({
      last_call_at: sql<Date>`now()`,
      call_token: token,
      first_sent_at: outbox.fn.coalesce('first_sent_at', sql<Date>`now()`),
      ...(clearDead ? workerOnlyColumns() : {}),
    })
    .where('order_id', '=', orderId)
    .where((eb) =>
      eb.or([
        eb('last_call_at', 'is', null),
        eb(
          eb('last_call_at', '+', intervalOf(minDelayMs)),
          '<=',
          sql<Date>`now()`,
        ),
      ]),
    )
    // O RETURNING devolve a linha nova, então o "enviado antes" sai da comparação: na primeira tomada
    // first_sent_at e last_call_at valem o mesmo now() da transação; nas seguintes, first_sent_at é mais antigo.
    .returning((eb) =>
      eb(eb.ref('first_sent_at'), '<', eb.ref('last_call_at')).as(
        'sent_before',
      ),
    )
    .executeTakeFirst();
  if (taken)
    return { granted: true, token, sentBefore: taken.sent_before === true };

  const row = await db
    .selectFrom('outbox')
    .select((eb) =>
      sql<number>`(extract(epoch from (${eb.ref('last_call_at')} + ${intervalOf(minDelayMs)} - now())) * 1000)::float8`.as(
        'retry_in_ms',
      ),
    )
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!row) throw new Error('a linha da outbox não existe');
  return { granted: false, retryInMs: Math.max(0, row.retry_in_ms) };
}

// Regrava o início da chamada para a criação que vem depois da consulta; false
// quando o token já não vale. O token, e não o horário, porque o `Date` do JS perde
// os microssegundos do now().
export async function renewCallPermit(
  db: Kysely<StoreDb>,
  orderId: string,
  token: string,
): Promise<boolean> {
  const renewed = await db
    .updateTable('outbox')
    // A renovação antecede uma criação depois da consulta: soma no mesmo UPDATE (AD-031).
    .set({
      last_call_at: sql<Date>`now()`,
      create_calls: outbox('create_calls', '+', 1),
    })
    .where('order_id', '=', orderId)
    .where('call_token', '=', token)
    .executeTakeFirst();
  return renewed.numUpdatedRows > 0n;
}
