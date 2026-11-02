import { randomUUID } from 'node:crypto';
import {
  type ExpressionBuilder,
  expressionBuilder,
  type Kysely,
  sql,
  type SqlBool,
} from 'kysely';
import type { StoreDb } from '../db/database.ts';
import type { RefusalReason, StoredRefusal } from './refusal.ts';

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
  | {
      granted: true;
      token: string;
      sentBefore: boolean;
      // Criações contadas, já com a desta tentativa (AD-031): maior que 1 = não é a primeira.
      createCalls: number;
      // Recusa definitiva já gravada (AD-031); com ela a tentativa só consulta.
      refusal: StoredRefusal | null;
    }
  // Outra tentativa chamou o ERP há menos que o atraso mínimo.
  | { granted: false; retryInMs: number };

export interface TakeCallPermitOptions {
  minDelayMs: number;
  // Só o worker zera o dead_at; a reconciliação não.
  clearDead: boolean;
  // Só o cancel: a tomada exige também que a última criação enviada seja mais antiga que a janela, no
  // mesmo UPDATE, para outra tentativa não criar a fatura entre a conferência e a permissão.
  createWindowMs?: number;
}

export function intervalOf(ms: number) {
  return sql<Date>`make_interval(secs => ${ms / 1000})`;
}

// O que só a tomada do worker grava. A marca de envio (AD-031) soma quando first_sent_at era nulo, porque
// a criação vem logo depois; soma antes da chamada: contar a mais é inofensivo, contar a menos é impossível.
function workerOnlyColumns() {
  return {
    dead_at: null,
    // A janela do cancel conta da criação, e não da chamada: consulta e reconciliação regravam last_call_at
    // sem criar fatura. Grava antes da chamada: se o worker morrer durante a criação, a janela já existe.
    last_create_at: outbox
      .case()
      .when(outbox('first_sent_at', 'is', null))
      .then(sql<Date>`now()`)
      .else(outbox.ref('last_create_at'))
      .end(),
    create_calls: outbox
      .case()
      .when(outbox('first_sent_at', 'is', null))
      .then(outbox('create_calls', '+', 1))
      .else(outbox.ref('create_calls'))
      .end(),
  };
}

// O RETURNING da tomada devolve a linha nova, então o "enviado antes" sai da comparação: na primeira tomada
// first_sent_at e last_call_at valem o mesmo now() da transação; nas seguintes, first_sent_at é mais antigo.
// Traz também a recusa gravada e o que falta da janela de assentamento, pelo relógio do banco.
function grantedColumns(eb: ExpressionBuilder<StoreDb, 'outbox'>) {
  return [
    eb(eb.ref('first_sent_at'), '<', eb.ref('last_call_at')).as('sent_before'),
    eb.ref('create_calls').as('create_calls'),
    eb.ref('refusal_reason').as('refusal_reason'),
    sql<
      number | null
    >`(extract(epoch from (${eb.ref('refused_at')} + ${intervalOf(SETTLE_WINDOW_MS)} - now())) * 1000)::float8`.as(
      'refusal_left_ms',
    ),
  ];
}

function granted(
  token: string,
  taken: {
    sent_before: SqlBool;
    create_calls: number;
    refusal_reason: string | null;
    refusal_left_ms: number | null;
  },
): CallPermit {
  return {
    granted: true,
    token,
    sentBefore: taken.sent_before === true,
    createCalls: taken.create_calls,
    refusal:
      taken.refusal_reason !== null && taken.refusal_left_ms !== null
        ? {
            reason: taken.refusal_reason as RefusalReason,
            leftMs: taken.refusal_left_ms,
          }
        : null,
  };
}

// Um UPDATE só: a condição e a gravação juntas é que impedem duas tentativas de ganharem a mesma
// permissão (ler e gravar em dois comandos deixaria uma janela).
export async function takeCallPermit(
  db: Kysely<StoreDb>,
  orderId: string,
  { minDelayMs, clearDead, createWindowMs }: TakeCallPermitOptions,
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
    .$if(createWindowMs !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('last_create_at', 'is', null),
          eb(
            eb('last_create_at', '+', intervalOf(createWindowMs ?? 0)),
            '<=',
            sql<Date>`now()`,
          ),
        ]),
      ),
    )
    .returning(grantedColumns)
    .executeTakeFirst();
  if (taken) return granted(token, taken);
  return {
    granted: false,
    retryInMs: await timeLeftMs(db, orderId, minDelayMs, createWindowMs),
  };
}

// O que falta é o maior entre o atraso mínimo e a janela; sem criação, só o atraso.
async function timeLeftMs(
  db: Kysely<StoreDb>,
  orderId: string,
  minDelayMs: number,
  createWindowMs: number | undefined,
): Promise<number> {
  const row = await db
    .selectFrom('outbox')
    .select((eb) => [
      sql<
        number | null
      >`(extract(epoch from (${eb.ref('last_call_at')} + ${intervalOf(minDelayMs)} - now())) * 1000)::float8`.as(
        'retry_in_ms',
      ),
      sql<
        number | null
      >`(extract(epoch from (${eb.ref('last_create_at')} + ${intervalOf(createWindowMs ?? 0)} - now())) * 1000)::float8`.as(
        'window_left_ms',
      ),
    ])
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!row) throw new Error('a linha da outbox não existe');
  return Math.max(0, row.retry_in_ms ?? 0, row.window_left_ms ?? 0);
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
      last_create_at: sql<Date>`now()`,
      create_calls: outbox('create_calls', '+', 1),
    })
    .where('order_id', '=', orderId)
    .where('call_token', '=', token)
    .executeTakeFirst();
  return renewed.numUpdatedRows > 0n;
}
