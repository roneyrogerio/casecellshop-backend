import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { createQueue, createSqsClient, type Queue } from '../../src/queue/sqs.ts';

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
  const container: StartedTestContainer = await new GenericContainer(ELASTICMQ_IMAGE)
    .withExposedPorts(ELASTICMQ_PORT)
    .withWaitStrategy(Wait.forHttp('/?Action=ListQueues', ELASTICMQ_PORT).forStatusCodeMatching((status) => status < 500))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(ELASTICMQ_PORT)}`;
  const client = new SQSClient({ endpoint, region: TEST_REGION, credentials: FAKE_CREDENTIALS });
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
function reachableUrl(emq: TestElasticMq, queueUrl: string | undefined): string {
  if (queueUrl === undefined) throw new Error('o ElasticMQ não devolveu o QueueUrl');
  return `${emq.endpoint}${new URL(queueUrl).pathname}`;
}

// A DLQ e depois a fila de origem com a mesma redrive policy do elasticmq.conf (design.md, "Fila no SQS").
export async function createBillingQueues(emq: TestElasticMq, options: QueueOptions = {}): Promise<BillingQueues> {
  const suffix = randomUUID().slice(0, 8);
  const dlq = await emq.client.send(new CreateQueueCommand({ QueueName: `billing-dlq-${suffix}` }));
  const dlqUrl = reachableUrl(emq, dlq.QueueUrl);
  const attributes = await emq.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const dlqArn = attributes.Attributes?.['QueueArn'];
  if (dlqArn === undefined) throw new Error('o ElasticMQ não devolveu o ARN da DLQ');
  const source = await emq.client.send(
    new CreateQueueCommand({
      QueueName: `billing-${suffix}`,
      Attributes: {
        VisibilityTimeout: String(options.visibilitySeconds ?? 60),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: options.maxReceiveCount ?? 12 }),
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

export async function openBillingQueues(emq: TestElasticMq, options: QueueOptions = {}): Promise<OpenedQueues> {
  const urls = await createBillingQueues(emq, options);
  const client = createSqsClient({ endpoint: emq.endpoint, region: TEST_REGION });
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

// ---------------------------------------------------------------- inspeção crua

export interface RawMessage {
  body: string;
  receiptHandle: string;
  receiveCount: number;
  traceparent: string | null;
  // Tipo de dado do atributo `traceparent` no SQS (deve ser `String`).
  traceparentDataType: string | null;
}

export async function sendRaw(emq: TestElasticMq, queueUrl: string, body: string, traceparent?: string): Promise<void> {
  await emq.client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      ...(traceparent === undefined ? {} : { MessageAttributes: { traceparent: { DataType: 'String', StringValue: traceparent } } }),
    }),
  );
}

// Recebe tudo o que está visível, de dez em dez, escondendo as mensagens por `visibilitySeconds`
// (o teste usa uma fila só dele, então elas não voltam). Não espera: o teste só lê o estado.
export async function drain(emq: TestElasticMq, queueUrl: string, visibilitySeconds = 300): Promise<RawMessage[]> {
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
        receiveCount: Number(message.Attributes?.['ApproximateReceiveCount'] ?? '0'),
        traceparent: attribute?.StringValue ?? null,
        traceparentDataType: attribute?.DataType ?? null,
      });
    }
  }
}

// ApproximateNumberOfMessages: as mensagens visíveis agora.
export async function visibleCount(emq: TestElasticMq, queueUrl: string): Promise<number> {
  const response = await emq.client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
  return Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? '0');
}

// Os orderId que aparecem em mais de uma mensagem. A invariante dos testes do relay: sem duplicata na mesma rodada.
export function duplicatedOrderIds(messages: { body: string }[]): string[] {
  const seen = new Map<string, number>();
  for (const message of messages) {
    const { orderId } = JSON.parse(message.body) as { orderId: string };
    seen.set(orderId, (seen.get(orderId) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, times]) => times > 1).map(([orderId]) => orderId);
}
