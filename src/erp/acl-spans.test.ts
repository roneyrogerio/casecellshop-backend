import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../test/helpers/clock.ts';
import { settle, track } from '../../test/helpers/async.ts';
import {
  countingInvoices,
  hangingInvoices,
  rejectingInvoices,
} from '../../test/helpers/invoice-reader.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { createErpClient } from './acl.ts';
import type { ErpClient, ErpOrderRequest } from './erp-client.ts';
import {
  ErpNetworkError,
  type ErpInvoiceReader,
  type ErpRequest,
  type ErpResponse,
  type ErpTransport,
} from './transport.ts';

// OBS-05: cada chamada do ErpClient é um span CLIENT `erp.<operação>`, filho do span ativo (a tentativa do worker).

const TIMEOUT_MS = 10_000;

const orderRequest: ErpOrderRequest = {
  reference: 'pedido-spans-0001',
  items: [{ sku: 'SPANS-CAPA-AZUL', quantity: 1, unitPriceCents: 4990 }],
};
const erpOrder = { erpOrderId: 'erp-1', reference: orderRequest.reference };
const catalogPage = {
  items: [
    { sku: 'SPANS-CAPA-AZUL', name: 'Capa azul', priceCents: 4990, onHand: 3 },
  ],
  hasNext: false,
};

const exporter = new InMemorySpanExporter();
const telemetry = createTelemetry({ spanExporter: exporter });

beforeEach(async () => {
  await telemetry.forceFlush();
  exporter.reset();
});

afterAll(async () => {
  await telemetry.shutdown();
});

async function finishedSpans(): Promise<ReadableSpan[]> {
  // O processador exporta em lote: sem o flush o teste leria spans a menos.
  await telemetry.forceFlush();
  return exporter.getFinishedSpans();
}

async function spansNamed(name: string): Promise<ReadableSpan[]> {
  return (await finishedSpans()).filter((span) => span.name === name);
}

async function onlySpanNamed(name: string): Promise<ReadableSpan> {
  const spans = await spansNamed(name);
  expect(spans, `um único span ${name}`).toHaveLength(1);
  const [span] = spans;
  if (!span) throw new Error(`span ${name} ausente`);
  return span;
}

function transportBehaving(
  behavior: (signal: AbortSignal) => Promise<ErpResponse>,
): ErpTransport {
  return {
    send: (_request: ErpRequest, signal: AbortSignal) => behavior(signal),
  };
}

const responding = (status: number, body?: unknown) =>
  transportBehaving(() => Promise.resolve({ status, body }));

const failingWith = (code: ErpNetworkError['code']) =>
  transportBehaving(() => Promise.reject(new ErpNetworkError(code)));

// Como o contrato do transporte manda: rejeita com o motivo do sinal quando ele aborta.
const hanging = () =>
  transportBehaving(
    (signal) =>
      new Promise<ErpResponse>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error), {
          once: true,
        });
      }),
  );

function clientOver(
  transport: ErpTransport,
  withTelemetry = true,
  invoiceReader: ErpInvoiceReader = countingInvoices(),
) {
  const clock = createManualClock();
  const client = createErpClient({
    transport,
    invoiceReader,
    clock,
    timeoutMs: TIMEOUT_MS,
    ...(withTelemetry ? { telemetry } : {}),
  });
  return { client, clock };
}

type Operation = 'create_order' | 'find_order' | 'list_catalog';

const SPAN_NAME: Record<Operation, string> = {
  create_order: 'erp.create_order',
  find_order: 'erp.find_order',
  list_catalog: 'erp.list_catalog',
};

function callOperation(client: ErpClient, operation: Operation) {
  if (operation === 'create_order') return client.createOrder(orderRequest);
  if (operation === 'find_order')
    return client.findOrderByReference(orderRequest.reference);
  return client.listCatalog(1);
}

interface Case {
  label: string;
  operation: Operation;
  transport: () => ErpTransport;
  outcome: string;
  // Falha técnica: status de erro e error.type igual ao desfecho.
  technical: boolean;
}

const CASES: Case[] = [
  {
    label: 'criação 201',
    operation: 'create_order',
    transport: () => responding(201, erpOrder),
    outcome: 'ok',
    technical: false,
  },
  {
    label: 'criação 422 (recusa de negócio)',
    operation: 'create_order',
    transport: () => responding(422, { code: 'out_of_stock' }),
    outcome: 'permanent',
    technical: false,
  },
  {
    label: 'criação 503',
    operation: 'create_order',
    transport: () => responding(503),
    outcome: 'transient',
    technical: true,
  },
  {
    label: 'criação com ECONNRESET',
    operation: 'create_order',
    transport: () => failingWith('ECONNRESET'),
    outcome: 'ambiguous',
    technical: true,
  },
  {
    label: 'criação 401',
    operation: 'create_order',
    transport: () => responding(401),
    outcome: 'config_error',
    technical: true,
  },
  {
    label: 'consulta 200',
    operation: 'find_order',
    transport: () => responding(200, erpOrder),
    outcome: 'found',
    technical: false,
  },
  {
    label: 'consulta 404 order_not_found',
    operation: 'find_order',
    transport: () => responding(404, { code: 'order_not_found' }),
    outcome: 'not_found',
    technical: false,
  },
  {
    label: 'consulta 503',
    operation: 'find_order',
    transport: () => responding(503),
    outcome: 'transient',
    technical: true,
  },
  {
    label: 'consulta 403',
    operation: 'find_order',
    transport: () => responding(403),
    outcome: 'config_error',
    technical: true,
  },
  {
    label: 'listagem 200',
    operation: 'list_catalog',
    transport: () => responding(200, catalogPage),
    outcome: 'ok',
    technical: false,
  },
  {
    label: 'listagem 503',
    operation: 'list_catalog',
    transport: () => responding(503),
    outcome: 'transient',
    technical: true,
  },
  {
    label: 'listagem 404',
    operation: 'list_catalog',
    transport: () => responding(404),
    outcome: 'config_error',
    technical: true,
  },
];

describe('OBS-05 span de cada chamada do ErpClient', () => {
  it.each(CASES)(
    'OBS-05 $label abre um span CLIENT com a operação e o desfecho; só a falha técnica marca erro',
    async ({ operation, transport, outcome, technical }) => {
      const { client } = clientOver(transport());

      await callOperation(client, operation);

      const span = await onlySpanNamed(SPAN_NAME[operation]);
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes['casecellshop.erp.operation']).toBe(operation);
      expect(span.attributes['casecellshop.erp.outcome']).toBe(outcome);
      expect(span.status.code).toBe(
        technical ? SpanStatusCode.ERROR : SpanStatusCode.UNSET,
      );
      // Sem a chave quando não é falha técnica: o valor ausente é undefined.
      expect(span.attributes['error.type']).toBe(
        technical ? outcome : undefined,
      );
    },
  );

  it.each(['create_order', 'find_order', 'list_catalog'] as const)(
    'OBS-05 %s é filho do span ativo e fica no trace dele',
    async (operation) => {
      const { client } = clientOver(responding(503));

      await telemetry.tracer.startActiveSpan(
        'outbox.attempt',
        async (parent) => {
          try {
            await callOperation(client, operation);
          } finally {
            parent.end();
          }
        },
      );

      const parent = await onlySpanNamed('outbox.attempt');
      const span = await onlySpanNamed(SPAN_NAME[operation]);
      expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
    },
  );

  it('OBS-05 duas chamadas seguidas na mesma tentativa abrem dois spans irmãos, ambos filhos do span ativo', async () => {
    const { client } = clientOver(responding(404, { code: 'order_not_found' }));

    await telemetry.tracer.startActiveSpan('outbox.attempt', async (parent) => {
      try {
        await client.findOrderByReference(orderRequest.reference);
        await client.findOrderByReference(orderRequest.reference);
      } finally {
        parent.end();
      }
    });

    const parent = await onlySpanNamed('outbox.attempt');
    const spans = await spansNamed('erp.find_order');
    expect(spans).toHaveLength(2);
    for (const span of spans)
      expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
  });

  it('OBS-05 sem telemetry nas opções não há span', async () => {
    const { client } = clientOver(responding(201, erpOrder), false);

    await telemetry.tracer.startActiveSpan('outbox.attempt', async (parent) => {
      try {
        await client.createOrder(orderRequest);
        await client.findOrderByReference(orderRequest.reference);
        await client.listCatalog(1);
      } finally {
        parent.end();
      }
    });

    expect((await finishedSpans()).map((span) => span.name)).toEqual([
      'outbox.attempt',
    ]);
  });

  it.each(['create_order', 'find_order', 'list_catalog'] as const)(
    'OBS-05 %s: o span dura a chamada inteira, inclusive até o timeout',
    async (operation) => {
      const { client, clock } = clientOver(hanging());

      const pending: Promise<unknown> = callOperation(client, operation);
      const call = track(pending);
      await settle();
      expect(
        (await spansNamed(SPAN_NAME[operation])).length,
        'o span ainda está aberto enquanto a chamada espera',
      ).toBe(0);

      clock.advance(TIMEOUT_MS);
      await settle();
      expect(call.settled).toBe(true);

      const span = await onlySpanNamed(SPAN_NAME[operation]);
      expect(span.attributes['casecellshop.erp.outcome']).toBe(
        operation === 'create_order' ? 'ambiguous' : 'transient',
      );
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe(
        operation === 'create_order' ? 'ambiguous' : 'transient',
      );
    },
  );

  it.each(['create_order', 'find_order', 'list_catalog'] as const)(
    'OBS-05 %s: exceção inesperada que escapa da classificação marca erro com error.type igual ao nome da exceção, fecha o span e propaga',
    async (operation) => {
      // Uma resposta cujo corpo lança ao ser lido: a falha acontece depois do transporte, na classificação.
      const poisoned = {
        get code(): never {
          throw new RangeError('corpo ilegível');
        },
        get items(): never {
          throw new RangeError('corpo ilegível');
        },
        get erpOrderId(): never {
          throw new RangeError('corpo ilegível');
        },
      };
      const { client } = clientOver(
        // O status faz a classificação ler o corpo: 422 lê `code`, 200 lê `erpOrderId` ou `items`.
        responding(operation === 'create_order' ? 422 : 200, poisoned),
      );

      await expect(callOperation(client, operation)).rejects.toBeInstanceOf(
        RangeError,
      );

      const span = await onlySpanNamed(SPAN_NAME[operation]);
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes['casecellshop.erp.operation']).toBe(operation);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('RangeError');
    },
  );
});

describe('ORD-21 span erp.count_invoices da contagem de faturas (AD-031)', () => {
  const reference = orderRequest.reference;

  it('ORD-21 a contagem conclusiva abre um span CLIENT erp.count_invoices com a operação e o desfecho ok, sem erro', async () => {
    const { client } = clientOver(responding(500), true, countingInvoices(2));

    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 2,
    });

    const span = await onlySpanNamed('erp.count_invoices');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['casecellshop.erp.operation']).toBe(
      'count_invoices',
    );
    expect(span.attributes['casecellshop.erp.outcome']).toBe('ok');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expect(span.attributes['error.type']).toBeUndefined();
  });

  it('ORD-21 a leitura que rejeita fecha o span com o desfecho transient, status de erro e error.type transient', async () => {
    const { client } = clientOver(
      responding(500),
      true,
      rejectingInvoices(new Error('mysql: connection refused')),
    );

    expect((await client.countInvoicesByReference(reference)).kind).toBe(
      'transient',
    );

    const span = await onlySpanNamed('erp.count_invoices');
    expect(span.attributes['casecellshop.erp.outcome']).toBe('transient');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('transient');
  });

  it('ORD-21 o span dura a contagem inteira, inclusive até o timeout', async () => {
    const { client, clock } = clientOver(
      responding(500),
      true,
      hangingInvoices(),
    );

    const call = track(client.countInvoicesByReference(reference));
    await settle();
    expect(
      (await spansNamed('erp.count_invoices')).length,
      'o span ainda está aberto enquanto a leitura espera',
    ).toBe(0);

    clock.advance(TIMEOUT_MS);
    await settle();
    expect(call.settled).toBe(true);

    const span = await onlySpanNamed('erp.count_invoices');
    expect(span.attributes['casecellshop.erp.outcome']).toBe('transient');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('ORD-21 o span da contagem é filho do span ativo e fica no trace dele', async () => {
    const { client } = clientOver(responding(500), true, countingInvoices(1));

    await telemetry.tracer.startActiveSpan('late_check', async (parent) => {
      try {
        await client.countInvoicesByReference(reference);
      } finally {
        parent.end();
      }
    });

    const parent = await onlySpanNamed('late_check');
    const span = await onlySpanNamed('erp.count_invoices');
    expect(span.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(span.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it('ORD-21 sem telemetry nas opções a contagem não abre span', async () => {
    const { client } = clientOver(responding(500), false, countingInvoices(1));

    expect(await client.countInvoicesByReference(reference)).toEqual({
      kind: 'ok',
      count: 1,
    });

    expect(await spansNamed('erp.count_invoices')).toEqual([]);
  });
});
