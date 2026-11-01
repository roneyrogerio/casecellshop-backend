import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { assert } from 'vitest';
import {
  createQueue,
  createSqsClient,
  type HandleResult,
  type Queue,
  type ReceiveOptions,
  type ReceivedMessage,
} from '../../src/queue/sqs.ts';

// A mesma imagem do compose (STATE.md, "Escolhas de ferramenta"): o teste fala com o emulador que roda em produção local.
export const ELASTICMQ_IMAGE = 'softwaremill/elasticmq-native:1.7.1';
export const ELASTICMQ_PORT = 9324;
export const TEST_REGION = 'elasticmq';

// O ElasticMQ ignora as credenciais, mas a cadeia padrão do SDK (usada pelo createSqsClient de
// produção) exige alguma. Valores fixos, sem segredo, como no compose.
const FAKE_CREDENTIALS = { accessKeyId: 'x', secretAccessKey: 'x' };

export interface TestElasticMq {
  endpoint: string;
  // Cliente cru do SDK, só para o teste criar filas e inspecionar o que a porta fez. O código sob teste usa o createSqsClient.
  client: SQSClient;
  stop(): Promise<void>;
}

// Um contêiner por arquivo de teste; as filas têm nome único por teste (createBillingQueues).
export async function startElasticMq(): Promise<TestElasticMq> {
  process.env['AWS_ACCESS_KEY_ID'] ??= FAKE_CREDENTIALS.accessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] ??= FAKE_CREDENTIALS.secretAccessKey;
  // A espera é HTTP, de fora: a imagem nativa não tem shell para a checagem interna de porta do Testcontainers.
  const container: StartedTestContainer = await new GenericContainer(
    ELASTICMQ_IMAGE,
  )
    .withExposedPorts(ELASTICMQ_PORT)
    .withWaitStrategy(
      Wait.forHttp('/?Action=ListQueues', ELASTICMQ_PORT).forStatusCodeMatching(
        (status) => status < 500,
      ),
    )
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(ELASTICMQ_PORT)}`;
  const client = new SQSClient({
    endpoint,
    region: TEST_REGION,
    credentials: FAKE_CREDENTIALS,
  });
  return {
    endpoint,
    client,
    async stop() {
      client.destroy();
      await container.stop();
    },
  };
}

export interface BillingQueues {
  queueUrl: string;
  dlqUrl: string;
}

export interface QueueOptions {
  // Padrão 12, o do design; o teste de DLQ usa um limite menor.
  maxReceiveCount?: number;
  // Padrão 60, o da fila `billing`; 0 deixa a mensagem recebível na hora, quando o teste quer a visibilidade da fila sem esperar.
  visibilitySeconds?: number;
}

// O QueueUrl que o ElasticMQ devolve cita a porta interna (9324); o que vale é o caminho.
function reachableUrl(
  emq: TestElasticMq,
  queueUrl: string | undefined,
): string {
  if (queueUrl === undefined)
    throw new Error('o ElasticMQ não devolveu o QueueUrl');
  return `${emq.endpoint}${new URL(queueUrl).pathname}`;
}

// A DLQ e depois a fila de origem com a mesma redrive policy do elasticmq.conf (design.md, "Fila no SQS").
export async function createBillingQueues(
  emq: TestElasticMq,
  options: QueueOptions = {},
): Promise<BillingQueues> {
  const suffix = randomUUID().slice(0, 8);
  const dlq = await emq.client.send(
    new CreateQueueCommand({ QueueName: `billing-dlq-${suffix}` }),
  );
  const dlqUrl = reachableUrl(emq, dlq.QueueUrl);
  const attributes = await emq.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = attributes.Attributes?.['QueueArn'];
  if (dlqArn === undefined)
    throw new Error('o ElasticMQ não devolveu o ARN da DLQ');
  const source = await emq.client.send(
    new CreateQueueCommand({
      QueueName: `billing-${suffix}`,
      Attributes: {
        VisibilityTimeout: String(options.visibilitySeconds ?? 60),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: options.maxReceiveCount ?? 12,
        }),
      },
    }),
  );
  return { queueUrl: reachableUrl(emq, source.QueueUrl), dlqUrl };
}

export interface OpenedQueues extends BillingQueues {
  // O SDK criado pelo createSqsClient de produção, e as portas sobre ele.
  client: SQSClient;
  queue: Queue;
  dlq: Queue;
  close(): void;
}

export async function openBillingQueues(
  emq: TestElasticMq,
  options: QueueOptions = {},
): Promise<OpenedQueues> {
  const urls = await createBillingQueues(emq, options);
  const client = createSqsClient({
    endpoint: emq.endpoint,
    region: TEST_REGION,
  });
  return {
    ...urls,
    client,
    queue: createQueue(client, urls.queueUrl),
    dlq: createQueue(client, urls.dlqUrl),
    close() {
      client.destroy();
    },
  };
}

// ---------------------------------------------------------------- servidor que não responde

export interface BlackHole {
  // Endereço http://127.0.0.1:porta, para o endpoint do SDK e para a URL da fila.
  url: string;
  // Requisições cujo cabeçalho chegou ao servidor: prova que a falha injetada disparou.
  requestCount(): number;
  close(): Promise<void>;
}

// Aceita a conexão, lê a requisição e nunca responde: a falha de rede que o ElasticMQ não produz
// sob demanda. É a única coisa injetada, na fronteira; o resto do caminho é o real.
export async function startBlackHole(): Promise<BlackHole> {
  let requests = 0;
  const server = createServer((request) => {
    requests += 1;
    request.resume();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('o servidor não respondeu a porta');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requestCount: () => requests,
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Sem isto o close esperaria para sempre as conexões que nunca terminam.
        server.closeAllConnections();
      });
    },
  };
}

export interface Observed {
  state: 'resolved' | 'rejected' | 'pending';
  elapsedMs: number;
}

// Espera a promessa por no máximo `guardMs` de tempo real. O prazo é do teste: uma promessa que não
// termina vira `pending` (falha por asserção) em vez de travar o teste até o timeout do vitest.
export async function observe(
  promise: Promise<unknown>,
  guardMs: number,
): Promise<Observed> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<Observed['state']>((resolve) => {
    timer = setTimeout(() => resolve('pending'), guardMs);
  });
  const settled = promise.then(
    (): Observed['state'] => 'resolved',
    (): Observed['state'] => 'rejected',
  );
  const state = await Promise.race([settled, guard]);
  clearTimeout(timer);
  return { state, elapsedMs: performance.now() - startedAt };
}

// ---------------------------------------------------------------- inspeção crua

export interface RawMessage {
  body: string;
  receiptHandle: string;
  receiveCount: number;
  traceparent: string | null;
  // Tipo de dado do atributo `traceparent` no SQS (deve ser `String`).
  traceparentDataType: string | null;
}

export async function sendRaw(
  emq: TestElasticMq,
  queueUrl: string,
  body: string,
  traceparent?: string,
): Promise<void> {
  await emq.client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      ...(traceparent === undefined
        ? {}
        : {
            MessageAttributes: {
              traceparent: { DataType: 'String', StringValue: traceparent },
            },
          }),
    }),
  );
}

// Recebe tudo o que está visível, de dez em dez, escondendo as mensagens por `visibilitySeconds`
// (o teste usa uma fila só dele, então elas não voltam). Não espera: o teste só lê o estado.
export async function drain(
  emq: TestElasticMq,
  queueUrl: string,
  visibilitySeconds = 300,
): Promise<RawMessage[]> {
  const messages: RawMessage[] = [];
  for (;;) {
    const response = await emq.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        VisibilityTimeout: visibilitySeconds,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
    );
    const batch = response.Messages ?? [];
    if (batch.length === 0) return messages;
    for (const message of batch) {
      const attribute = message.MessageAttributes?.['traceparent'];
      messages.push({
        body: message.Body ?? '',
        receiptHandle: message.ReceiptHandle ?? '',
        receiveCount: Number(
          message.Attributes?.['ApproximateReceiveCount'] ?? '0',
        ),
        traceparent: attribute?.StringValue ?? null,
        traceparentDataType: attribute?.DataType ?? null,
      });
    }
  }
}

// ApproximateNumberOfMessages: as mensagens visíveis agora.
export async function visibleCount(
  emq: TestElasticMq,
  queueUrl: string,
): Promise<number> {
  const response = await emq.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );
  return Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
}

// ApproximateNumberOfMessagesNotVisible: as mensagens em voo (recebidas e ainda escondidas). Sozinha, a
// contagem das visíveis não vê uma mensagem que um worker segura ou que o retry escondeu.
export async function notVisibleCount(
  emq: TestElasticMq,
  queueUrl: string,
): Promise<number> {
  const response = await emq.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(
    response.Attributes?.['ApproximateNumberOfMessagesNotVisible'] ?? '0',
  );
}

export interface QueueCounts {
  visible: number;
  notVisible: number;
}

export async function countsOf(
  emq: TestElasticMq,
  queueUrl: string,
): Promise<QueueCounts> {
  return {
    visible: await visibleCount(emq, queueUrl),
    notVisible: await notVisibleCount(emq, queueUrl),
  };
}

// Lê as contagens da resposta XML da API de consulta do SQS (`GET <fila>?Action=GetQueueAttributes&AttributeName.1=All`).
// O teste do compose a usa de dentro do contêiner do worker, porque o ElasticMQ não publica porta no host.
export function parseQueueCountsXml(xml: string): QueueCounts {
  const read = (attribute: string): number => {
    const match = new RegExp(
      `<Name>${attribute}</Name>\\s*<Value>(\\d+)</Value>`,
    ).exec(xml);
    if (!match)
      return assert.fail(
        `${attribute} não está na resposta do SQS: ${xml.slice(0, 300)}`,
      );
    return Number(match[1]);
  };
  return {
    visible: read('ApproximateNumberOfMessages'),
    notVisible: read('ApproximateNumberOfMessagesNotVisible'),
  };
}

// ---------------------------------------------------------------- fila observada

export interface HandleCall {
  receiptHandle: string;
  // Só nas mudanças de visibilidade.
  seconds?: number;
  // `rejected`: a chamada lançou (falha injetada ou do SQS).
  result: HandleResult | 'rejected';
}

export type QueueOperation = 'receive' | 'delete' | 'changeVisibility';

export interface Injection {
  // Quantas vezes a falha injetada disparou: o teste confere que ela aconteceu.
  readonly fired: number;
}

export interface ObservedQueue extends Queue {
  // Opções de cada `receive` iniciado, na ordem.
  readonly receives: readonly ReceiveOptions[];
  // `receive` que já voltaram (com mensagens, vazios ou rejeitados).
  readonly completedReceives: number;
  readonly received: readonly ReceivedMessage[];
  readonly deletes: readonly HandleCall[];
  readonly visibilityChanges: readonly (HandleCall & { seconds: number })[];
  // O pedido da mensagem que o handle recebeu (corpo fora do schema não tem pedido).
  orderIdOf(receiptHandle: string): string | undefined;
  // Handle do último recebimento do pedido que ainda não foi apagado (ou, sem argumento, da última mensagem recebida).
  latestHandle(orderId?: string): string;
  deletesOf(orderId: string): HandleCall[];
  changesOf(orderId: string): (HandleCall & { seconds: number })[];
  // Roda antes de o `receive` seguir para o SQS: o teste prende o recebimento sem sleep.
  beforeReceive(hook: () => Promise<void>, times?: number): void;
  // Roda depois de o SQS responder e antes de a resposta voltar a quem chamou.
  afterReceive(
    hook: (messages: ReceivedMessage[]) => void | Promise<void>,
    times?: number,
  ): void;
  // Faz as próximas `times` chamadas da operação lançarem, sem chegar ao SQS. É só falha: nunca devolve dado.
  inject(operation: QueueOperation, times?: number): Injection;
}

function orderIdOfBody(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const orderId = (parsed as { orderId?: unknown } | null)?.orderId;
    return typeof orderId === 'string' ? orderId : undefined;
  } catch {
    return undefined;
  }
}

// Embrulha a porta real, que segue falando com o ElasticMQ: registra o que o worker fez, guarda os
// receipt handles (o teste devolve a mensagem à fila com `changeVisibility(handle, 0)`, sem esperar a
// visibilidade) e deixa o teste prender um recebimento ou fazer uma operação lançar.
export function observeQueue(inner: Queue): ObservedQueue {
  const receives: ReceiveOptions[] = [];
  const received: ReceivedMessage[] = [];
  const deletes: HandleCall[] = [];
  const visibilityChanges: (HandleCall & { seconds: number })[] = [];
  const orderByHandle = new Map<string, string | undefined>();
  const before: { remaining: number; hook: () => Promise<void> }[] = [];
  const after: {
    remaining: number;
    hook: (messages: ReceivedMessage[]) => void | Promise<void>;
  }[] = [];
  const injections = new Map<
    QueueOperation,
    { remaining: number; state: { fired: number } }
  >();
  let completedReceives = 0;

  function takeHook<T extends { remaining: number }>(
    hooks: T[],
  ): T | undefined {
    const hook = hooks.find((candidate) => candidate.remaining > 0);
    if (hook) hook.remaining -= 1;
    return hook;
  }

  function maybeFail(operation: QueueOperation): void {
    const injection = injections.get(operation);
    if (!injection || injection.remaining <= 0) return;
    injection.remaining -= 1;
    injection.state.fired += 1;
    throw new Error(`falha injetada no SQS (${operation})`);
  }

  async function handleCall(
    operation: 'delete' | 'changeVisibility',
    receiptHandle: string,
    seconds: number | undefined,
    run: () => Promise<HandleResult>,
  ): Promise<HandleResult> {
    const record = (result: HandleResult | 'rejected'): void => {
      if (operation === 'delete') deletes.push({ receiptHandle, result });
      else
        visibilityChanges.push({
          receiptHandle,
          seconds: seconds ?? 0,
          result,
        });
    };
    try {
      maybeFail(operation);
      const result = await run();
      record(result);
      return result;
    } catch (error) {
      record('rejected');
      throw error;
    }
  }

  return {
    get receives() {
      return receives;
    },
    get completedReceives() {
      return completedReceives;
    },
    get received() {
      return received;
    },
    get deletes() {
      return deletes;
    },
    get visibilityChanges() {
      return visibilityChanges;
    },
    orderIdOf: (receiptHandle) => orderByHandle.get(receiptHandle),
    latestHandle(orderId) {
      // Pula o handle de uma mensagem já apagada: duas mensagens do mesmo pedido têm handles distintos,
      // e o que interessa ao teste é o da que segue na fila.
      const deleted = new Set(
        deletes
          .filter((call) => call.result === 'ok')
          .map((call) => call.receiptHandle),
      );
      for (let index = received.length - 1; index >= 0; index -= 1) {
        const message = received[index];
        if (
          message &&
          !deleted.has(message.receiptHandle) &&
          (orderId === undefined || orderIdOfBody(message.body) === orderId)
        ) {
          return message.receiptHandle;
        }
      }
      // Falha de asserção, e não erro de montagem: o worker que não recebeu da fila é o comportamento que falta.
      return assert.fail(
        `o worker não recebeu nenhuma mensagem${orderId === undefined ? '' : ` do pedido ${orderId}`}`,
      );
    },
    deletesOf: (orderId) =>
      deletes.filter(
        (call) => orderByHandle.get(call.receiptHandle) === orderId,
      ),
    changesOf: (orderId) =>
      visibilityChanges.filter(
        (call) => orderByHandle.get(call.receiptHandle) === orderId,
      ),
    beforeReceive(hook, times = 1) {
      before.push({ remaining: times, hook });
    },
    afterReceive(hook, times = 1) {
      after.push({ remaining: times, hook });
    },
    inject(operation, times = 1) {
      const state = { fired: 0 };
      injections.set(operation, { remaining: times, state });
      return {
        get fired() {
          return state.fired;
        },
      };
    },
    send: (messages) => inner.send(messages),
    approximateCount: () => inner.approximateCount(),
    async receive(options) {
      receives.push(options);
      try {
        const gate = takeHook(before);
        if (gate) await gate.hook();
        maybeFail('receive');
        const messages = await inner.receive(options);
        for (const message of messages) {
          received.push(message);
          orderByHandle.set(message.receiptHandle, orderIdOfBody(message.body));
        }
        const observer = takeHook(after);
        if (observer) await observer.hook(messages);
        return messages;
      } finally {
        completedReceives += 1;
      }
    },
    delete: (receiptHandle) =>
      handleCall('delete', receiptHandle, undefined, () =>
        inner.delete(receiptHandle),
      ),
    changeVisibility: (receiptHandle, seconds) =>
      handleCall('changeVisibility', receiptHandle, seconds, () =>
        inner.changeVisibility(receiptHandle, seconds),
      ),
  };
}

// Os orderId que aparecem em mais de uma mensagem. A invariante dos testes do relay: sem duplicata na mesma rodada.
export function duplicatedOrderIds(messages: { body: string }[]): string[] {
  const seen = new Map<string, number>();
  for (const message of messages) {
    const { orderId } = JSON.parse(message.body) as { orderId: string };
    seen.set(orderId, (seen.get(orderId) ?? 0) + 1);
  }
  return [...seen.entries()]
    .filter(([, times]) => times > 1)
    .map(([orderId]) => orderId);
}
