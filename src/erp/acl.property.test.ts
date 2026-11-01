import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import {
  expectAsyncProperty,
  expectFalsifiedAsync,
} from '../../test/helpers/properties.ts';
import { createErpClient, type ErpClientOptions } from './acl.ts';
import type { ErpClient, ErpOrderRequest } from './erp-client.ts';
import {
  ErpNetworkError,
  type ErpResponse,
  type ErpTransport,
} from './transport.ts';

// FND-15, "Catálogo do ERP" e "Classificação do ERP": o que o ERP devolver, seja qual for o corpo e o status, vira
// um resultado da lista fechada de erp-client.ts, sem lançar. O transporte é falso (a porta), não o fetch.

type Factory = (options: ErpClientOptions) => ErpClient;

// O que o transporte faz: responde, falha de rede ou rejeita com um erro qualquer.
type Behavior =
  | { how: 'respond'; response: ErpResponse }
  | { how: 'network'; code: 'ECONNREFUSED' | 'ENOTFOUND' | 'ECONNRESET' }
  | { how: 'reject' };

function transportOf(behavior: Behavior): ErpTransport {
  return {
    send() {
      if (behavior.how === 'respond') return Promise.resolve(behavior.response);
      return Promise.reject(
        behavior.how === 'network'
          ? new ErpNetworkError(behavior.code)
          : new Error('falha qualquer do transporte'),
      );
    },
  };
}

function clientOver(make: Factory, behavior: Behavior): ErpClient {
  return make({
    transport: transportOf(behavior),
    clock: createManualClock(),
    timeoutMs: 10_000,
  });
}

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-property-0001',
  items: [{ sku: 'PROP-CAPA-AZUL', quantity: 1, unitPriceCents: 4990 }],
};

const statusArb = fc.oneof(
  fc.integer({ min: 100, max: 599 }),
  fc.constantFrom(200, 201, 400, 401, 403, 404, 422, 429, 500, 503),
  fc.integer(),
);

// Números nas bordas do dinheiro e do estoque: inteiros seguros, fora da faixa, fracionários e não numéricos.
const numberLikeArb = fc.oneof(
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.integer({ min: -1_000_000, max: -1 }),
  fc.double({ noNaN: false }),
  fc.constantFrom(
    0,
    -0,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ),
  fc.string(),
  fc.jsonValue(),
);

const nearItemArb = fc.record(
  {
    sku: fc.oneof(fc.string(), fc.jsonValue()),
    name: fc.oneof(fc.string(), fc.jsonValue()),
    priceCents: numberLikeArb,
    onHand: numberLikeArb,
  },
  { requiredKeys: ['sku', 'name', 'priceCents', 'onHand'] },
);

// Perto da página certa: itens quase certos, às vezes com chave faltando, e o hasNext certo ou errado.
const nearPageArb = fc.record(
  {
    items: fc.oneof(
      fc.array(nearItemArb, { maxLength: 6 }),
      fc.array(fc.anything(), { maxLength: 4 }),
      fc.anything(),
    ),
    hasNext: fc.oneof(fc.boolean(), fc.anything()),
  },
  { requiredKeys: [] },
);

const catalogBodyArb = fc.oneof(
  fc.anything(),
  fc.jsonValue(),
  nearPageArb,
  nearPageArb,
);

const behaviorArb: fc.Arbitrary<Behavior> = fc.oneof(
  { weight: 8, arbitrary: respondArb(statusArb, fc.anything()) },
  { weight: 4, arbitrary: respondArb(statusArb, fc.jsonValue()) },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom<'ECONNREFUSED' | 'ENOTFOUND' | 'ECONNRESET'>(
        'ECONNREFUSED',
        'ENOTFOUND',
        'ECONNRESET',
      )
      .map((code) => ({ how: 'network' as const, code })),
  },
  { weight: 1, arbitrary: fc.constant({ how: 'reject' as const }) },
);

function respondArb(
  status: fc.Arbitrary<number>,
  body: fc.Arbitrary<unknown>,
): fc.Arbitrary<Behavior> {
  return fc
    .record({ status, body })
    .map((response) => ({ how: 'respond' as const, response }));
}

function isSafeCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

type Fields = Record<string, unknown>;

const hasCause = (r: Fields) => typeof r['cause'] === 'string';
const hasStatus = (r: Fields) => typeof r['status'] === 'number';
const isOrder = (r: Fields) => {
  const order = r['order'] as Fields | undefined;
  return (
    typeof order?.['erpOrderId'] === 'string' &&
    typeof order['reference'] === 'string'
  );
};
const isPage = (r: Fields) => {
  const page = r['page'] as { items: Fields[]; hasNext: unknown };
  return (
    typeof page.hasNext === 'boolean' &&
    page.items.every(
      (item) =>
        typeof item['sku'] === 'string' &&
        typeof item['name'] === 'string' &&
        isSafeCount(item['priceCents']) &&
        isSafeCount(item['onHand']),
    )
  );
};

// A lista fechada de cada operação (erp-client.ts): o que cada resultado carrega para valer.
const CREATE_RESULTS: Record<string, (r: Fields) => boolean> = {
  ok: isOrder,
  permanent: (r) =>
    r['reason'] === 'rejected' || r['reason'] === 'out_of_stock',
  transient: hasCause,
  ambiguous: hasCause,
  config_error: hasStatus,
};
const FIND_RESULTS: Record<string, (r: Fields) => boolean> = {
  found: isOrder,
  not_found: () => true,
  transient: hasCause,
  config_error: hasStatus,
};
const LIST_RESULTS: Record<string, (r: Fields) => boolean> = {
  ok: isPage,
  transient: hasCause,
  config_error: hasStatus,
};

// Vazio quando o resultado está na lista da operação e traz os campos do desfecho; senão, diz o que falhou.
function violationsOf(
  allowed: Record<string, (r: Fields) => boolean>,
  result: { kind: string },
): string[] {
  const check = Object.hasOwn(allowed, result.kind)
    ? allowed[result.kind]
    : undefined;
  if (check === undefined) return [`resultado fora da lista: ${result.kind}`];
  return check(result) ? [] : [`campos inválidos em ${result.kind}`];
}

// Uma propriedade por operação; cada uma devolve a propriedade para o teste real e para o controle negativo.
function catalogIsValidOrClosedError(make: Factory) {
  return fc.asyncProperty(
    statusArb,
    catalogBodyArb,
    fc.integer({ min: 1, max: 50 }),
    async (status, body, page) => {
      const result = await clientOver(make, {
        how: 'respond',
        response: { status: 200, body },
      }).listCatalog(page);
      const other = await clientOver(make, {
        how: 'respond',
        response: { status, body },
      }).listCatalog(page);

      expect([
        ...violationsOf(LIST_RESULTS, result),
        ...violationsOf(LIST_RESULTS, other),
      ]).toEqual([]);
    },
  );
}

function everyOperationIsClosed(make: Factory) {
  return fc.asyncProperty(behaviorArb, async (behavior) => {
    const client = clientOver(make, behavior);
    const created = await client.createOrder(orderRequest);
    const found = await client.findOrderByReference(orderRequest.reference);
    const listed = await client.listCatalog(1);

    expect([
      ...violationsOf(CREATE_RESULTS, created),
      ...violationsOf(FIND_RESULTS, found),
      ...violationsOf(LIST_RESULTS, listed),
    ]).toEqual([]);
  });
}

function create404IsConfigError(make: Factory) {
  return fc.asyncProperty(fc.anything(), async (body) => {
    const result = await clientOver(make, {
      how: 'respond',
      response: { status: 404, body },
    }).createOrder(orderRequest);

    expect(result).toEqual({ kind: 'config_error', status: 404 });
  });
}

// Versões quebradas do cliente, escritas aqui. Cada uma troca uma regra do módulo e mantém o resto.
function passThroughCatalog(options: ErpClientOptions): ErpClient {
  const real = createErpClient(options);
  return {
    ...real,
    // Confia no corpo do ERP: devolve a página como veio, sem conferir preço nem estoque.
    async listCatalog(page) {
      const response = await options.transport.send(
        { op: 'listCatalog', page },
        new AbortController().signal,
      );
      return { kind: 'ok', page: response.body as never };
    },
  };
}

function throwingClient(options: ErpClientOptions): ErpClient {
  const real = createErpClient(options);
  return {
    ...real,
    // Lança quando o ERP responde com um corpo que não é objeto.
    async createOrder(request) {
      const response = await options.transport.send(
        { op: 'createOrder', body: request },
        new AbortController().signal,
      );
      const body = response.body as { erpOrderId: string; reference: string };
      return {
        kind: 'ok',
        order: { erpOrderId: body.erpOrderId, reference: body.reference },
      };
    },
  };
}

function create404AsAmbiguous(options: ErpClientOptions): ErpClient {
  const real = createErpClient(options);
  return {
    ...real,
    async createOrder(request) {
      const result = await real.createOrder(request);
      return result.kind === 'config_error' && result.status === 404
        ? { kind: 'ambiguous', cause: 'http_404' }
        : result;
    },
  };
}

function leaksUnknownKind(options: ErpClientOptions): ErpClient {
  const real = createErpClient(options);
  return {
    ...real,
    async findOrderByReference(reference) {
      const result = await real.findOrderByReference(reference);
      return result.kind === 'transient' && result.cause.startsWith('http_5')
        ? ({ kind: 'retry_later' } as never)
        : result;
    },
  };
}

describe('FND-15 createErpClient: catálogo', () => {
  it('FND-15 qualquer corpo do catálogo vira página válida ou erro da lista fechada, sem lançar', async () => {
    await expectAsyncProperty(catalogIsValidOrClosedError(createErpClient));
  });

  it('FND-15 preço e estoque só passam como inteiro seguro maior ou igual a zero', async () => {
    await expectAsyncProperty(
      fc.asyncProperty(nearItemArb, async (item) => {
        const result = await clientOver(createErpClient, {
          how: 'respond',
          response: { status: 200, body: { items: [item], hasNext: false } },
        }).listCatalog(1);

        const acceptable =
          typeof item.sku === 'string' &&
          typeof item.name === 'string' &&
          isSafeCount(item.priceCents) &&
          isSafeCount(item.onHand);
        expect(result.kind).toBe(acceptable ? 'ok' : 'transient');
      }),
    );
  });

  it.each([
    { defect: 'confia no corpo sem conferir', broken: passThroughCatalog },
  ])(
    'FND-15 controle negativo: a mesma propriedade do catálogo reprova o cliente que $defect',
    async ({ broken }) => {
      await expectFalsifiedAsync(catalogIsValidOrClosedError(broken));
    },
  );
});

describe('FND-15 createErpClient: classificação', () => {
  it('FND-15 qualquer status e corpo dão um resultado da lista fechada em toda operação', async () => {
    await expectAsyncProperty(everyOperationIsClosed(createErpClient));
  });

  it('FND-15 o 404 na criação do pedido é sempre config_error, com qualquer corpo', async () => {
    await expectAsyncProperty(create404IsConfigError(createErpClient));
  });

  it.each([
    { defect: 'lança com corpo estranho', broken: throwingClient },
    { defect: 'devolve resultado fora da lista', broken: leaksUnknownKind },
  ])(
    'FND-15 controle negativo: a propriedade da lista fechada reprova o cliente que $defect',
    async ({ broken }) => {
      await expectFalsifiedAsync(everyOperationIsClosed(broken));
    },
  );

  it('FND-15 controle negativo: a propriedade do 404 reprova o cliente que trata o 404 da criação como ambíguo', async () => {
    await expectFalsifiedAsync(create404IsConfigError(create404AsAmbiguous));
  });
});
