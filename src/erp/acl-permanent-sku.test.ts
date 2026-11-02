import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import { createErpClient } from './acl.ts';
import type { CreateOrderResult, ErpOrderRequest } from './erp-client.ts';

// OBS-01 (a porta do ERP leva o sku ao log): o 422 de criação devolve `permanent` com o `sku` do corpo quando ele é
// um texto no formato do Sku do contrato (/^[A-Za-z0-9._-]{1,64}$/); em qualquer outro caso, `permanent` sem a chave
// `sku`, porque o corpo do ERP é entrada externa.

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-sku-0001',
  items: [{ sku: 'ACL-CAPA-AZUL', quantity: 1, unitPriceCents: 4990 }],
};

function create(body: unknown): Promise<CreateOrderResult> {
  const client = createErpClient({
    transport: { send: () => Promise.resolve({ status: 422, body }) },
    clock: createManualClock(),
    timeoutMs: 10_000,
  });
  return client.createOrder(orderRequest);
}

const REASONS = [
  { code: 'out_of_stock', reason: 'out_of_stock' },
  { code: 'unknown_product', reason: 'rejected' },
  { code: 'rejected', reason: 'rejected' },
] as const;

describe('OBS-01 o 422 de criação com sku no formato do contrato devolve permanent com o sku', () => {
  it.each(REASONS)(
    'OBS-01 422 $code com sku válido devolve permanent $reason com o sku',
    async ({ code, reason }) => {
      expect(await create({ code, sku: 'CAPA-IP15-PRETA' })).toEqual({
        kind: 'permanent',
        reason,
        sku: 'CAPA-IP15-PRETA',
      });
    },
  );

  it.each([
    { label: 'um caractere', sku: 'a' },
    { label: 'letras, dígitos, ponto, sublinhado e hífen', sku: 'Aa0._-9' },
    { label: 'o limite de 64 caracteres', sku: 'x'.repeat(64) },
  ])('OBS-01 sku com $label é aceito', async ({ sku }) => {
    expect(await create({ code: 'out_of_stock', sku })).toEqual({
      kind: 'permanent',
      reason: 'out_of_stock',
      sku,
    });
  });
});

describe('OBS-01 o 422 de criação sem sku utilizável devolve permanent sem a chave sku', () => {
  // `undefined` é o corpo sem a chave `sku`.
  const INVALID: { label: string; sku: unknown }[] = [
    { label: 'ausente', sku: undefined },
    { label: 'número', sku: 42 },
    { label: 'nulo', sku: null },
    { label: 'lista', sku: ['ACL-CAPA-AZUL'] },
    { label: 'objeto', sku: { sku: 'ACL-CAPA-AZUL' } },
    { label: 'texto vazio', sku: '' },
    { label: 'texto de 65 caracteres', sku: 'x'.repeat(65) },
    { label: 'texto com espaço', sku: 'CAPA AZUL' },
    { label: 'texto com acento', sku: 'CAPA-AÇÃO' },
    { label: 'texto com barra', sku: 'CAPA/AZUL' },
    { label: 'texto com quebra de linha no fim', sku: 'CAPA-AZUL\n' },
  ];

  it.each(
    REASONS.flatMap((entry) =>
      INVALID.map((invalid) => ({ ...entry, ...invalid })),
    ),
  )(
    'OBS-01 422 $code com sku $label devolve permanent $reason sem sku',
    async ({ code, reason, sku }) => {
      const body = sku === undefined ? { code } : { code, sku };

      const result = await create(body);

      expect(result).toEqual({ kind: 'permanent', reason });
      expect(Object.hasOwn(result, 'sku'), 'a chave sku não existe').toBe(
        false,
      );
    },
  );

  it('OBS-01 o 422 sem corpo devolve permanent rejected sem a chave sku', async () => {
    const result = await create(undefined);

    expect(result).toEqual({ kind: 'permanent', reason: 'rejected' });
    expect(Object.hasOwn(result, 'sku')).toBe(false);
  });
});
