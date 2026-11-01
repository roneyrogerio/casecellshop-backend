import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import { settle, track } from '../../test/helpers/async.ts';
import { createErpClient } from './acl.ts';
import type { ErpClient, ErpOrderRequest } from './erp-client.ts';
import {
  ErpNetworkError,
  type ErpNetworkCode,
  type ErpRequest,
  type ErpResponse,
  type ErpTransport,
} from './transport.ts';

const TIMEOUT_MS = 10_000;

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-acl-0001',
  items: [{ sku: 'ACL-CAPA-AZUL', quantity: 2, unitPriceCents: 4990 }],
};
const erpOrder = { erpOrderId: 'erp-1', reference: orderRequest.reference };

interface FakeTransport extends ErpTransport {
  calls: { request: ErpRequest; signal: AbortSignal }[];
}

// Transporte falso: devolve o que o teste manda e anota o que recebeu.
function fakeTransport(
  behavior: (request: ErpRequest, signal: AbortSignal) => Promise<ErpResponse>,
): FakeTransport {
  const calls: FakeTransport['calls'] = [];
  return {
    calls,
    send(request, signal) {
      calls.push({ request, signal });
      return behavior(request, signal);
    },
  };
}

function responding(status: number, body?: unknown): FakeTransport {
  return fakeTransport(() => Promise.resolve({ status, body }));
}

function failingWith(code: ErpNetworkCode): FakeTransport {
  return fakeTransport(() => Promise.reject(new ErpNetworkError(code)));
}

// Como o contrato do transporte manda: rejeita com o motivo do sinal quando ele aborta.
function hanging(): FakeTransport {
  return fakeTransport(
    (_request, signal) =>
      new Promise<ErpResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error), {
          once: true,
        });
      }),
  );
}

function clientOver(transport: ErpTransport) {
  const clock = createManualClock();
  const client = createErpClient({ transport, clock, timeoutMs: TIMEOUT_MS });
  return { client, clock };
}

type Operation = 'createOrder' | 'findOrder' | 'listCatalog';

function callOperation(client: ErpClient, operation: Operation) {
  if (operation === 'createOrder') return client.createOrder(orderRequest);
  if (operation === 'findOrder')
    return client.findOrderByReference(orderRequest.reference);
  return client.listCatalog(1);
}

const catalogItem = {
  sku: 'ACL-CAPA-AZUL',
  name: 'Capa azul',
  priceCents: 4990,
  onHand: 10,
};
const orderNotFound = { code: 'order_not_found' };

describe('ORD-21 criação: sucesso, inclusive o pedido existente devolvido pela H1b', () => {
  it.each([
    { status: 201, label: 'fatura nova' },
    { status: 200, label: 'fatura existente devolvida pela H1b' },
  ])(
    'ORD-21 criação com $status ($label) devolve ok com o pedido do ERP',
    async ({ status }) => {
      const { client } = clientOver(responding(status, erpOrder));

      expect(await client.createOrder(orderRequest)).toEqual({
        kind: 'ok',
        order: erpOrder,
      });
    },
  );

  it('ORD-21 a criação envia ao transporte a referência e os itens, uma vez só', async () => {
    const transport = responding(201, erpOrder);
    const { client } = clientOver(transport);

    await client.createOrder(orderRequest);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.request).toEqual({
      op: 'createOrder',
      body: orderRequest,
    });
  });
});

describe('classificação da criação', () => {
  it.each([
    {
      body: { code: 'out_of_stock', sku: 'ACL-CAPA-AZUL' },
      reason: 'out_of_stock',
      label: 'out_of_stock (H2)',
    },
    {
      body: { code: 'unknown_product', sku: 'ACL-CAPA-AZUL' },
      reason: 'rejected',
      label: 'unknown_product',
    },
    { body: { code: 'rejected' }, reason: 'rejected', label: 'rejected' },
    {
      body: { code: 'codigo_novo_do_erp' },
      reason: 'rejected',
      label: 'outro código',
    },
  ])(
    'ORD-21 criação com 422 e $label é permanente com o motivo $reason',
    async ({ body, reason }) => {
      const { client } = clientOver(responding(422, body));

      expect(await client.createOrder(orderRequest)).toEqual({
        kind: 'permanent',
        reason,
      });
    },
  );

  it.each([429, 503])(
    'ORD-21 criação com %i, recusa sem processar, é transitória',
    async (status) => {
      const { client } = clientOver(responding(status));

      expect(await client.createOrder(orderRequest)).toMatchObject({
        kind: 'transient',
      });
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND'] as const)(
    'ORD-21 criação com %s, a requisição não chegou, é transitória',
    async (code) => {
      const { client } = clientOver(failingWith(code));

      expect(await client.createOrder(orderRequest)).toMatchObject({
        kind: 'transient',
      });
    },
  );

  it.each([500, 502, 504])(
    'ORD-21 criação com %i pode ter chegado e é ambígua',
    async (status) => {
      const { client } = clientOver(responding(status));

      expect(await client.createOrder(orderRequest)).toMatchObject({
        kind: 'ambiguous',
      });
    },
  );

  it('ORD-21 criação com ECONNRESET, conexão encerrada depois do envio, é ambígua', async () => {
    const { client } = clientOver(failingWith('ECONNRESET'));

    expect(await client.createOrder(orderRequest)).toMatchObject({
      kind: 'ambiguous',
    });
  });

  it('ORD-21 criação com um status fora da lista é ambígua', async () => {
    const { client } = clientOver(responding(418));

    expect(await client.createOrder(orderRequest)).toMatchObject({
      kind: 'ambiguous',
    });
  });

  it.each([
    { status: 404, body: undefined, label: '404 sem corpo' },
    {
      status: 404,
      body: { code: 'outra_coisa' },
      label: '404 com outro corpo',
    },
    // O corpo order_not_found só tem sentido na consulta: na criação todo 404 é config_error.
    {
      status: 404,
      body: orderNotFound,
      label: '404 com o corpo order_not_found',
    },
  ])(
    'ORD-21 criação com $label é erro de configuração, nunca permanente',
    async ({ status, body }) => {
      const { client } = clientOver(responding(status, body));

      expect(await client.createOrder(orderRequest)).toEqual({
        kind: 'config_error',
        status,
      });
    },
  );
});

describe('classificação da consulta pela referência', () => {
  it('ORD-21 consulta com 200 devolve found com o pedido', async () => {
    const { client } = clientOver(responding(200, erpOrder));

    expect(await client.findOrderByReference(orderRequest.reference)).toEqual({
      kind: 'found',
      order: erpOrder,
    });
  });

  it('ORD-09 consulta com 404 e o corpo order_not_found devolve not_found', async () => {
    const { client } = clientOver(responding(404, orderNotFound));

    expect(await client.findOrderByReference(orderRequest.reference)).toEqual({
      kind: 'not_found',
    });
  });

  it.each([
    { body: undefined, label: 'sem corpo' },
    { body: null, label: 'com corpo nulo' },
    { body: {}, label: 'com corpo vazio' },
    { body: { code: 'rota_inexistente' }, label: 'com outro código' },
    { body: 'Not Found', label: 'com texto' },
  ])(
    'ORD-09 consulta com 404 $label é erro de configuração e nunca not_found',
    async ({ body }) => {
      const { client } = clientOver(responding(404, body));

      expect(await client.findOrderByReference(orderRequest.reference)).toEqual(
        { kind: 'config_error', status: 404 },
      );
    },
  );

  it.each([422, 429, 500, 502, 503, 504, 418])(
    'ORD-09 consulta com %i é transitória e nunca not_found',
    async (status) => {
      const { client } = clientOver(responding(status, orderNotFound));

      const result = await client.findOrderByReference(orderRequest.reference);

      expect(result.kind).toBe('transient');
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'] as const)(
    'ORD-09 consulta com %s é transitória e nunca not_found',
    async (code) => {
      const { client } = clientOver(failingWith(code));

      expect(
        await client.findOrderByReference(orderRequest.reference),
      ).toMatchObject({ kind: 'transient' });
    },
  );

  it('ORD-21 a consulta envia ao transporte a referência, uma vez só', async () => {
    const transport = responding(200, erpOrder);
    const { client } = clientOver(transport);

    await client.findOrderByReference(orderRequest.reference);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.request).toEqual({
      op: 'findOrder',
      reference: orderRequest.reference,
    });
  });
});

describe('classificação do catálogo', () => {
  it('ORD-21 catálogo com 200 devolve a página do modelo da loja', async () => {
    const transport = responding(200, { items: [catalogItem], hasNext: true });
    const { client } = clientOver(transport);

    expect(await client.listCatalog(3)).toEqual({
      kind: 'ok',
      page: { items: [catalogItem], hasNext: true },
    });
    expect(transport.calls[0]?.request).toEqual({ op: 'listCatalog', page: 3 });
  });

  it.each([422, 429, 500, 502, 503, 504, 418])(
    'ORD-21 catálogo com %i é transitório',
    async (status) => {
      const { client } = clientOver(responding(status));

      expect(await client.listCatalog(1)).toMatchObject({ kind: 'transient' });
    },
  );

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET'] as const)(
    'ORD-21 catálogo com %s é transitório',
    async (code) => {
      const { client } = clientOver(failingWith(code));

      expect(await client.listCatalog(1)).toMatchObject({ kind: 'transient' });
    },
  );

  it.each([
    { body: undefined, label: 'sem corpo' },
    { body: orderNotFound, label: 'com o corpo order_not_found' },
  ])(
    'ORD-21 catálogo com 404 $label é erro de configuração',
    async ({ body }) => {
      const { client } = clientOver(responding(404, body));

      expect(await client.listCatalog(1)).toEqual({
        kind: 'config_error',
        status: 404,
      });
    },
  );
});

describe('ORD-10 400, 401 e 403 são erro de configuração em toda operação', () => {
  const operations: Operation[] = ['createOrder', 'findOrder', 'listCatalog'];
  const cases = operations.flatMap((operation) =>
    [400, 401, 403].map((status) => ({ operation, status })),
  );

  it.each(cases)(
    'ORD-10 $operation com $status devolve config_error com o status, nunca permanent',
    async ({ operation, status }) => {
      const { client } = clientOver(responding(status, { code: 'rejected' }));

      const result = await callOperation(client, operation);

      expect(result).toEqual({ kind: 'config_error', status });
      expect(result.kind).not.toBe('permanent');
    },
  );
});

describe('timeout da camada anticorrupção', () => {
  it('ORD-21 criação sem resposta é ambígua quando o relógio avança o timeout, e não antes', async () => {
    const transport = hanging();
    const { client, clock } = clientOver(transport);

    const call = track(client.createOrder(orderRequest));
    await settle();
    clock.advance(TIMEOUT_MS - 1);
    await settle();

    expect(call.settled).toBe(false);
    expect(transport.calls[0]?.signal.aborted).toBe(false);

    clock.advance(1);
    await settle();

    expect(call.settled).toBe(true);
    expect(await call.result).toMatchObject({ kind: 'ambiguous' });
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it('ORD-21 consulta sem resposta é transitória quando o relógio avança o timeout, e não antes', async () => {
    const transport = hanging();
    const { client, clock } = clientOver(transport);

    const call = track(client.findOrderByReference(orderRequest.reference));
    await settle();
    clock.advance(TIMEOUT_MS - 1);
    await settle();

    expect(call.settled).toBe(false);
    expect(transport.calls[0]?.signal.aborted).toBe(false);

    clock.advance(1);
    await settle();

    expect(call.settled).toBe(true);
    const result = await call.result;
    expect(result.kind).toBe('transient');
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it('ORD-21 catálogo sem resposta é transitório quando o relógio avança o timeout, e não antes', async () => {
    const transport = hanging();
    const { client, clock } = clientOver(transport);

    const call = track(client.listCatalog(1));
    await settle();
    clock.advance(TIMEOUT_MS - 1);
    await settle();

    expect(call.settled).toBe(false);
    expect(transport.calls[0]?.signal.aborted).toBe(false);

    clock.advance(1);
    await settle();

    expect(call.settled).toBe(true);
    expect(await call.result).toMatchObject({ kind: 'transient' });
    expect(transport.calls[0]?.signal.aborted).toBe(true);
  });

  it('ORD-21 uma resposta que chega antes do prazo não é tratada como timeout', async () => {
    const transport = fakeTransport(() =>
      Promise.resolve({ status: 201, body: erpOrder }),
    );
    const { client, clock } = clientOver(transport);

    const result = await client.createOrder(orderRequest);
    clock.advance(TIMEOUT_MS * 3);
    await settle();

    expect(result).toEqual({ kind: 'ok', order: erpOrder });
  });
});

describe('ORD-21 nenhum retry interno: cada operação chama o transporte uma vez só', () => {
  const operations: Operation[] = ['createOrder', 'findOrder', 'listCatalog'];

  it.each(operations)(
    'ORD-21 %s com 503 chama o transporte uma vez',
    async (operation) => {
      const transport = responding(503);
      const { client } = clientOver(transport);

      await callOperation(client, operation);
      await settle();

      expect(transport.calls).toHaveLength(1);
    },
  );

  it.each(operations)(
    'ORD-21 %s com ECONNRESET chama o transporte uma vez',
    async (operation) => {
      const transport = failingWith('ECONNRESET');
      const { client } = clientOver(transport);

      await callOperation(client, operation);
      await settle();

      expect(transport.calls).toHaveLength(1);
    },
  );

  it.each(operations)(
    'ORD-21 %s que estoura o timeout chama o transporte uma vez',
    async (operation) => {
      const transport = hanging();
      const { client, clock } = clientOver(transport);

      const call = callOperation(client, operation);
      await settle();
      clock.advance(TIMEOUT_MS);
      await call;
      clock.advance(TIMEOUT_MS * 10);
      await settle();

      expect(transport.calls).toHaveLength(1);
    },
  );
});

describe('ORD-21 catálogo com corpo 200 malformado é transitório, nunca ok', () => {
  const validItem = {
    sku: 'ACL-CAPA-AZUL',
    name: 'Capa azul',
    priceCents: 4990,
    onHand: 10,
  };

  it.each([
    { label: 'sem hasNext', body: { items: [validItem] } },
    {
      label: 'com hasNext "true" (texto)',
      body: { items: [validItem], hasNext: 'true' },
    },
    {
      label: 'com hasNext 1 (número)',
      body: { items: [validItem], hasNext: 1 },
    },
    {
      label: 'com priceCents fracionário',
      body: { items: [{ ...validItem, priceCents: 49.9 }], hasNext: false },
    },
    {
      label: 'com priceCents negativo',
      body: { items: [{ ...validItem, priceCents: -1 }], hasNext: false },
    },
    {
      label: 'com onHand negativo',
      body: { items: [{ ...validItem, onHand: -3 }], hasNext: false },
    },
    {
      label: 'com onHand fracionário',
      body: { items: [{ ...validItem, onHand: 2.5 }], hasNext: false },
    },
    {
      label:
        'com priceCents fracionário e onHand negativo (reprodução do revisor)',
      body: { items: [{ sku: 'A', name: 'x', priceCents: 49.9, onHand: -3 }] },
    },
  ])(
    'ORD-21 catálogo 200 $label é transitório com http_200_invalid_body',
    async ({ body }) => {
      const { client } = clientOver(responding(200, body));

      expect(await client.listCatalog(1)).toEqual({
        kind: 'transient',
        cause: 'http_200_invalid_body',
      });
    },
  );
});

describe('ORD-21 o timeout limita a chamada mesmo quando o transporte ignora o sinal', () => {
  const lateResponses: Record<Operation, ErpResponse> = {
    createOrder: { status: 201, body: erpOrder },
    findOrder: { status: 200, body: erpOrder },
    listCatalog: {
      status: 200,
      body: { items: [catalogItem], hasNext: false },
    },
  };
  const expectedOnTimeout = {
    createOrder: { kind: 'ambiguous', cause: 'timeout' },
    findOrder: { kind: 'transient', cause: 'timeout' },
    listCatalog: { kind: 'transient', cause: 'timeout' },
  } as const;
  const operations: Operation[] = ['createOrder', 'findOrder', 'listCatalog'];

  it.each(operations)(
    'ORD-21 %s resolve no timeout, sem esperar o transporte, e ignora a resposta tardia',
    async (operation) => {
      let respond: (response: ErpResponse) => void = () => undefined;
      // Não olha o AbortSignal: só responde quando o teste mandar.
      const transport = fakeTransport(
        () =>
          new Promise<ErpResponse>((resolve) => {
            respond = resolve;
          }),
      );
      const { client, clock } = clientOver(transport);

      const pending: Promise<unknown> = callOperation(client, operation);
      const call = track(pending);
      await settle();
      clock.advance(TIMEOUT_MS - 1);
      await settle();
      expect(call.settled).toBe(false);

      clock.advance(1);
      await settle();

      expect(call.settled).toBe(true);
      expect(await call.result).toEqual(expectedOnTimeout[operation]);

      respond(lateResponses[operation]);
      await settle();
      expect(await call.result).toEqual(expectedOnTimeout[operation]);
    },
  );
});

describe('ORD-21 rejeição do transporte que não é de rede nem o aborto do timeout', () => {
  const operations: Operation[] = ['createOrder', 'findOrder', 'listCatalog'];
  const expected = {
    createOrder: { kind: 'ambiguous', cause: 'transport_error' },
    findOrder: { kind: 'transient', cause: 'transport_error' },
    listCatalog: { kind: 'transient', cause: 'transport_error' },
  } as const;

  it.each(operations)(
    'ORD-21 %s mantém a classificação com a causa transport_error, não timeout',
    async (operation) => {
      const { client } = clientOver(
        fakeTransport(() => Promise.reject(new Error('connection terminated'))),
      );

      expect(await callOperation(client, operation)).toEqual(
        expected[operation],
      );
    },
  );
});
