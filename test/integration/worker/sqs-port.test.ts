import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createQueue, createSqsClient, startRedrive } from '../../../src/queue/sqs.ts';
import {
  drain,
  observe,
  openBillingQueues,
  parseQueueCountsXml,
  sendRaw,
  startBlackHole,
  startElasticMq,
  TEST_REGION,
  visibleCount,
  type BlackHole,
  type OpenedQueues,
  type QueueOptions,
  type TestElasticMq,
} from '../../helpers/sqs.ts';

// Porta do SQS (src/queue/sqs.ts) contra o ElasticMQ de verdade (AD-021; design.md, "Fila no SQS").
// A porta não tem critério próprio: send/receive provam o ORD-22 (a mensagem do faturamento e o
// traceparent) e a DLQ e o redrive provam o ORD-13. Cada teste cria o próprio par de filas.

let emq: TestElasticMq;
let blackHole: BlackHole;
const opened: OpenedQueues[] = [];

beforeAll(async () => {
  emq = await startElasticMq();
  blackHole = await startBlackHole();
}, 120_000);

afterEach(() => {
  for (const queues of opened.splice(0)) queues.close();
});

afterAll(async () => {
  await blackHole?.close();
  await emq?.stop();
});

async function fresh(options: QueueOptions = {}): Promise<OpenedQueues> {
  const queues = await openBillingQueues(emq, options);
  opened.push(queues);
  return queues;
}

describe('ORD-22 porta do SQS: envio', () => {
  it('ORD-22 send entrega o corpo e o traceparent como atributo de mensagem de texto, e não devolve id com falha', async () => {
    const { queue, queueUrl } = await fresh();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const body = JSON.stringify({ orderId: 'a', correlationId: 'req-1' });

    const result = await queue.send([{ id: 'm1', body, traceparent }]);

    expect(result).toEqual({ failedIds: [] });
    const [message, ...rest] = await drain(emq, queueUrl);
    expect(rest).toEqual([]);
    expect(message?.body).toBe(body);
    expect(message?.traceparent).toBe(traceparent);
    expect(message?.traceparentDataType).toBe('String');
  });

  it('ORD-22 send sem traceparent não cria o atributo na mensagem', async () => {
    const { queue, queueUrl } = await fresh();

    const result = await queue.send([{ id: 'm1', body: '{"orderId":"a"}', traceparent: null }]);

    expect(result.failedIds).toEqual([]);
    const messages = await drain(emq, queueUrl);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.traceparent).toBeNull();
  });

  it('ORD-22 send de um lote de 10 mensagens entrega as 10, cada uma com o próprio corpo', async () => {
    const { queue, queueUrl } = await fresh();
    const batch = Array.from({ length: 10 }, (_unused, index) => ({ id: `m${index}`, body: `corpo-${index}`, traceparent: null }));

    const result = await queue.send(batch);

    expect(result.failedIds).toEqual([]);
    const bodies = (await drain(emq, queueUrl)).map((message) => message.body).sort();
    expect(bodies).toEqual(batch.map((message) => message.body).sort());
  });

  it('ORD-22 send para uma fila que não existe rejeita: o erro do SQS chega a quem chama, que decide (o relay loga outbox.relay_error)', async () => {
    const { client, queueUrl } = await fresh();
    const ghost = createQueue(client, `${queueUrl}-inexistente`);

    await expect(ghost.send([{ id: 'm1', body: 'x', traceparent: null }])).rejects.toBeInstanceOf(Error);
  });

  it('ORD-22 send contra um servidor que aceita a conexão e nunca responde rejeita em torno de 5 s, em vez de ficar pendente', async () => {
    const client = createSqsClient({ endpoint: blackHole.url, region: TEST_REGION });
    const queue = createQueue(client, `${blackHole.url}/queue/billing`);
    const requestsBefore = blackHole.requestCount();
    try {
      // O prazo de 5 s corre em tempo real dentro do SDK, não no relógio injetável: o teste mede o tempo decorrido.
      const outcome = await observe(queue.send([{ id: 'm1', body: 'x', traceparent: null }]), 12_000);

      expect(blackHole.requestCount(), 'a requisição não chegou ao servidor que não responde').toBeGreaterThan(requestsBefore);
      expect(outcome.state).toBe('rejected');
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(4_000);
      expect(outcome.elapsedMs).toBeLessThanOrEqual(9_000);
    } finally {
      // Solta a requisição pendente, se a porta não tiver prazo, para não vazar para os outros testes.
      client.destroy();
    }
  }, 30_000);
});

describe('ORD-22 porta do SQS: recebimento', () => {
  it('ORD-22 receive devolve o corpo, o traceparent e receiveCount 1 na primeira vez', async () => {
    const { queue, queueUrl } = await fresh();
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await sendRaw(emq, queueUrl, 'corpo', traceparent);

    const messages = await queue.receive({ max: 10, waitSeconds: 0 });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: 'corpo', traceparent, receiveCount: 1 });
    expect(messages[0]?.receiptHandle).not.toBe('');
  });

  it('ORD-22 receive devolve traceparent null quando a mensagem não tem o atributo', async () => {
    const { queue, queueUrl } = await fresh();
    await sendRaw(emq, queueUrl, 'sem-traceparent');

    const messages = await queue.receive({ max: 10, waitSeconds: 0 });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.traceparent).toBeNull();
  });

  it('ORD-22 receive devolve no máximo max mensagens', async () => {
    const { queue, queueUrl } = await fresh();
    for (let index = 0; index < 5; index += 1) await sendRaw(emq, queueUrl, `m${index}`);

    const messages = await queue.receive({ max: 2, waitSeconds: 0 });

    expect(messages).toHaveLength(2);
    expect(await visibleCount(emq, queueUrl)).toBe(3);
  });

  it('ORD-22 receive com waitSeconds espera pelo long polling numa fila vazia e devolve vazio', async () => {
    const { queue } = await fresh();

    const startedAt = performance.now();
    const messages = await queue.receive({ max: 10, waitSeconds: 1 });
    const elapsedMs = performance.now() - startedAt;

    expect(messages).toEqual([]);
    // Short polling responderia na hora; o long polling segura a requisição por perto de 1 s.
    expect(elapsedMs).toBeGreaterThanOrEqual(800);
  });

  // O timeout comum da requisição (5 s) cortaria um long polling configurado perto ou acima dele: o receive tem
  // prazo próprio de waitSeconds + 5 s (design.md, "Fila no SQS"). O prazo corre em tempo real dentro do SDK.
  it('ORD-22 receive com waitSeconds de 6 s numa fila vazia espera o long polling inteiro e devolve vazio, em vez de rejeitar pelo timeout de 5 s da requisição', async () => {
    const { queue } = await fresh();

    const startedAt = performance.now();
    const outcome = await queue.receive({ max: 10, waitSeconds: 6 }).then(
      (messages) => ({ messages }) as const,
      (error: unknown) => ({ error }) as const,
    );
    const elapsedMs = performance.now() - startedAt;

    expect(outcome, 'o receive rejeitou em vez de esperar o long polling').toEqual({ messages: [] });
    expect(elapsedMs).toBeGreaterThanOrEqual(5_500);
  }, 30_000);

  it('ORD-22 receive com visibilitySeconds esconde a mensagem, mesmo que a fila tenha visibilidade 0', async () => {
    const { queue, queueUrl } = await fresh({ visibilitySeconds: 0 });
    await sendRaw(emq, queueUrl, 'corpo');

    const first = await queue.receive({ max: 1, waitSeconds: 0, visibilitySeconds: 30 });
    const second = await queue.receive({ max: 1, waitSeconds: 0 });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('ORD-22 receive sem visibilitySeconds herda a visibilidade da fila: com 0, a mensagem volta na hora com receiveCount 2', async () => {
    const { queue, queueUrl } = await fresh({ visibilitySeconds: 0 });
    await sendRaw(emq, queueUrl, 'corpo');

    const first = await queue.receive({ max: 1, waitSeconds: 0 });
    const second = await queue.receive({ max: 1, waitSeconds: 0 });

    expect(first[0]?.receiveCount).toBe(1);
    expect(second[0]?.receiveCount).toBe(2);
    expect(second[0]?.body).toBe('corpo');
  });

  it('ORD-22 receive devolve receiveCount que cresce a cada recebimento da mesma mensagem', async () => {
    const { queue, queueUrl } = await fresh();
    await sendRaw(emq, queueUrl, 'corpo');
    const counts: number[] = [];

    for (let round = 0; round < 3; round += 1) {
      const [message] = await queue.receive({ max: 1, waitSeconds: 0 });
      if (!message) throw new Error(`rodada ${round}: a mensagem não voltou`);
      counts.push(message.receiveCount);
      expect(await queue.changeVisibility(message.receiptHandle, 0)).toBe('ok');
    }

    expect(counts).toEqual([1, 2, 3]);
  });
});

describe('ORD-22 porta do SQS: delete e changeVisibility', () => {
  it('ORD-22 delete com o receipt handle vigente devolve ok e a mensagem não volta', async () => {
    const { queue, queueUrl } = await fresh({ visibilitySeconds: 0 });
    await sendRaw(emq, queueUrl, 'corpo');
    const [message] = await queue.receive({ max: 1, waitSeconds: 0, visibilitySeconds: 30 });

    const result = await queue.delete(message?.receiptHandle ?? '');

    expect(result).toBe('ok');
    // A fila tem visibilidade 0: se a mensagem não tivesse sido apagada, voltaria na hora.
    expect(await queue.receive({ max: 10, waitSeconds: 0 })).toEqual([]);
    expect(await visibleCount(emq, queueUrl)).toBe(0);
  });

  it('ORD-22 delete com um receipt handle antigo devolve stale e não apaga a mensagem recebida de novo', async () => {
    const { queue, queueUrl } = await fresh();
    await sendRaw(emq, queueUrl, 'corpo');
    const [old] = await queue.receive({ max: 1, waitSeconds: 0 });
    await queue.changeVisibility(old?.receiptHandle ?? '', 0);
    const [current] = await queue.receive({ max: 1, waitSeconds: 0 });

    const stale = await queue.delete(old?.receiptHandle ?? '');

    expect(stale).toBe('stale');
    // A mensagem segue lá: o handle vigente ainda a controla.
    expect(await queue.changeVisibility(current?.receiptHandle ?? '', 0)).toBe('ok');
    const [again] = await queue.receive({ max: 1, waitSeconds: 0 });
    expect(again?.receiveCount).toBe(3);
    expect(await queue.delete(again?.receiptHandle ?? '')).toBe('ok');
  });

  it('ORD-22 changeVisibility com 0 devolve ok e a mensagem fica recebível na hora', async () => {
    const { queue, queueUrl } = await fresh();
    await sendRaw(emq, queueUrl, 'corpo');
    const [message] = await queue.receive({ max: 1, waitSeconds: 0 });
    expect(await queue.receive({ max: 1, waitSeconds: 0 })).toEqual([]);

    const result = await queue.changeVisibility(message?.receiptHandle ?? '', 0);

    expect(result).toBe('ok');
    const [back] = await queue.receive({ max: 1, waitSeconds: 0 });
    expect(back?.body).toBe('corpo');
    expect(back?.receiveCount).toBe(2);
  });

  it('ORD-22 changeVisibility com um receipt handle antigo devolve stale e não muda a visibilidade da mensagem', async () => {
    const { queue, queueUrl } = await fresh();
    await sendRaw(emq, queueUrl, 'corpo');
    const [old] = await queue.receive({ max: 1, waitSeconds: 0 });
    await queue.changeVisibility(old?.receiptHandle ?? '', 0);
    const [current] = await queue.receive({ max: 1, waitSeconds: 0 });

    const stale = await queue.changeVisibility(old?.receiptHandle ?? '', 0);

    expect(stale).toBe('stale');
    // Se a chamada recusada tivesse valido, a mensagem (escondida por 60 s pelo recebimento vigente) já voltaria.
    expect(await queue.receive({ max: 1, waitSeconds: 0 })).toEqual([]);
    expect(await queue.changeVisibility(current?.receiptHandle ?? '', 0)).toBe('ok');
  });
});

describe('ORD-19 contagem pela API de consulta do SQS', () => {
  // O teste do compose lê as contagens da fila e da DLQ por esta API, de dentro do contêiner do worker.
  it('ORD-19 o GetQueueAttributes por GET traz, no XML, as mensagens visíveis e as em voo', async () => {
    const { queue, queueUrl } = await fresh();
    for (let index = 0; index < 2; index += 1) await sendRaw(emq, queueUrl, `m${index}`);
    await queue.receive({ max: 1, waitSeconds: 0 });

    await vi.waitFor(async () => {
      const response = await fetch(`${queueUrl}?Action=GetQueueAttributes&AttributeName.1=All`);
      expect(parseQueueCountsXml(await response.text())).toEqual({ visible: 1, notVisible: 1 });
    });
  });
});

describe('ORD-22 porta do SQS: contagem', () => {
  it('ORD-22 approximateCount reflete as mensagens visíveis: cai ao receber e não muda ao apagar', async () => {
    const { queue, queueUrl } = await fresh();
    for (let index = 0; index < 3; index += 1) await sendRaw(emq, queueUrl, `m${index}`);

    await vi.waitFor(async () => expect(await queue.approximateCount()).toBe(3));
    const [received] = await queue.receive({ max: 1, waitSeconds: 0 });
    await vi.waitFor(async () => expect(await queue.approximateCount()).toBe(2));
    await queue.delete(received?.receiptHandle ?? '');

    expect(await queue.approximateCount()).toBe(2);
  });
});

describe('ORD-13 porta do SQS: DLQ e redrive', () => {
  it('ORD-13 a mensagem vai para a DLQ no recebimento seguinte ao limite e some da fila de origem', async () => {
    const { queue, dlq, queueUrl } = await fresh({ maxReceiveCount: 2 });
    await sendRaw(emq, queueUrl, 'corpo');

    for (let round = 1; round <= 2; round += 1) {
      const [message] = await queue.receive({ max: 1, waitSeconds: 0 });
      expect(message?.receiveCount, `recebimento ${round}`).toBe(round);
      await queue.changeVisibility(message?.receiptHandle ?? '', 0);
    }
    // O recebimento seguinte ao 2º não devolve a mensagem: ela vai para a DLQ.
    expect(await queue.receive({ max: 1, waitSeconds: 0 })).toEqual([]);

    await vi.waitFor(async () => expect(await dlq.approximateCount()).toBe(1));
    expect(await queue.approximateCount()).toBe(0);
    const [dead] = await dlq.receive({ max: 1, waitSeconds: 0 });
    expect(dead?.body).toBe('corpo');
    expect(await visibleCount(emq, queueUrl)).toBe(0);
  });

  it('ORD-13 startRedrive devolve a mensagem da DLQ à fila de origem, com a contagem de recebimentos zerada', async () => {
    const { queue, dlq, client, queueUrl, dlqUrl } = await fresh({ maxReceiveCount: 2 });
    await sendRaw(emq, queueUrl, 'corpo');
    for (let round = 1; round <= 2; round += 1) {
      const [message] = await queue.receive({ max: 1, waitSeconds: 0 });
      await queue.changeVisibility(message?.receiptHandle ?? '', 0);
    }
    await queue.receive({ max: 1, waitSeconds: 0 });
    await vi.waitFor(async () => expect(await dlq.approximateCount()).toBe(1));

    await startRedrive(client, dlqUrl);

    // O redrive é uma tarefa assíncrona do SQS: o teste acompanha pelo número de mensagens, como o runbook.
    await vi.waitFor(async () => expect(await dlq.approximateCount()).toBe(0), { timeout: 20_000 });
    await vi.waitFor(async () => expect(await queue.approximateCount()).toBe(1), { timeout: 20_000 });
    const [back] = await queue.receive({ max: 1, waitSeconds: 0 });
    expect(back?.body).toBe('corpo');
    expect(back?.receiveCount).toBe(1);
  });
});
