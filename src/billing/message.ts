import { BillingMessage } from '../contract/billing-message.ts';

export type ParsedBillingMessage =
  | { valid: true; message: BillingMessage }
  // O orderId, quando o corpo é um JSON que o traz, serve só para o log da mensagem recusada.
  | { valid: false; orderId: string | undefined };

// Lê o corpo uma vez: a fila é uma entrada como outra qualquer, então JSON quebrado e corpo fora
// do schema viram o mesmo resultado, sem exceção.
export function parseBillingMessage(body: string): ParsedBillingMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  const parsed = BillingMessage.safeParse(json);
  if (parsed.success) return { valid: true, message: parsed.data };
  const orderId = (json as { orderId?: unknown } | null | undefined)?.orderId;
  return { valid: false, orderId: typeof orderId === 'string' ? orderId : undefined };
}
