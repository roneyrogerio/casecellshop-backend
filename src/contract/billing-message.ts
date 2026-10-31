import { z } from 'zod';
import { OrderId } from './orders.ts';
import { CorrelationId } from './problem.ts';

// Corpo da mensagem do faturamento no SQS (AD-021). O worker o valida antes de
// qualquer chamada: a fila é uma entrada como outra qualquer. Só ASCII, porque o
// ElasticMQ com persistência perde acentos ao recarregar do disco (R12).
export const BillingMessage = z.strictObject({
  orderId: OrderId,
  correlationId: CorrelationId,
});

export type BillingMessage = z.infer<typeof BillingMessage>;

// Nome do atributo de mensagem que leva o traceparent do checkout.
export const TRACEPARENT_ATTRIBUTE = 'traceparent';
