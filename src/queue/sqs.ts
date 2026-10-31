import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { TRACEPARENT_ATTRIBUTE } from '../contract/billing-message.ts';

// Porta da fila do faturamento sobre o SQS (AD-021; design.md, "Fila no SQS").
// Sem retry interno: quem chama decide o que fazer com cada falha.

export interface SqsSettings {
  // Vazio na AWS real; no compose e nos testes, o endereço do ElasticMQ.
  endpoint?: string;
  region: string;
}

export interface OutgoingMessage {
  id: string;
  body: string;
  traceparent: string | null;
}

export interface ReceivedMessage {
  body: string;
  receiptHandle: string;
  // ApproximateReceiveCount: é o número da tentativa.
  receiveCount: number;
  traceparent: string | null;
}

export interface ReceiveOptions {
  max: number;
  waitSeconds: number;
  visibilitySeconds?: number;
}

// `stale`: o SQS recusou o receipt handle (ReceiptHandleIsInvalid), porque a
// mensagem já foi recebida de novo por outro.
export type HandleResult = 'ok' | 'stale';

export interface Queue {
  send(messages: OutgoingMessage[]): Promise<{ failedIds: string[] }>;
  receive(options: ReceiveOptions): Promise<ReceivedMessage[]>;
  delete(receiptHandle: string): Promise<HandleResult>;
  changeVisibility(receiptHandle: string, seconds: number): Promise<HandleResult>;
  approximateCount(): Promise<number>;
}

const REQUEST_TIMEOUT_MS = 5_000;

export function createSqsClient(settings: SqsSettings): SQSClient {
  return new SQSClient({
    region: settings.region,
    // Uma tentativa só: quem chama (relay, worker) decide se repete.
    maxAttempts: 1,
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS },
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
  });
}

// Só o handle antigo vira `stale`; qualquer outro erro chega a quem chama.
async function settleHandle(action: () => Promise<unknown>): Promise<HandleResult> {
  try {
    await action();
    return 'ok';
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === 'ReceiptHandleIsInvalid') return 'stale';
    throw error;
  }
}

export function createQueue(client: SQSClient, queueUrl: string): Queue {
  return {
    async send(messages) {
      if (messages.length === 0) return { failedIds: [] };
      const response = await client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((message) => ({
            Id: message.id,
            MessageBody: message.body,
            ...(message.traceparent === null
              ? {}
              : { MessageAttributes: { [TRACEPARENT_ATTRIBUTE]: { DataType: 'String', StringValue: message.traceparent } } }),
          })),
        }),
      );
      return { failedIds: (response.Failed ?? []).map((entry) => entry.Id ?? '') };
    },
    async receive(options) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: options.max,
          WaitTimeSeconds: options.waitSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          MessageAttributeNames: [TRACEPARENT_ATTRIBUTE],
          ...(options.visibilitySeconds === undefined ? {} : { VisibilityTimeout: options.visibilitySeconds }),
        }),
      );
      return (response.Messages ?? []).map((message) => ({
        body: message.Body ?? '',
        receiptHandle: message.ReceiptHandle ?? '',
        receiveCount: Number(message.Attributes?.['ApproximateReceiveCount'] ?? 1),
        traceparent: message.MessageAttributes?.[TRACEPARENT_ATTRIBUTE]?.StringValue ?? null,
      }));
    },
    delete: (receiptHandle) => settleHandle(() => client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }))),
    changeVisibility: (receiptHandle, seconds) =>
      settleHandle(() =>
        client.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds })),
      ),
    async approximateCount() {
      const response = await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
      return Number(response.Attributes?.['ApproximateNumberOfMessages'] ?? 0);
    },
  };
}

// StartMessageMoveTask da DLQ para a fila de origem dela (sem destino, o SQS usa a origem).
export async function startRedrive(client: SQSClient, dlqUrl: string): Promise<void> {
  const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const arn = attributes.Attributes?.['QueueArn'];
  if (arn === undefined) throw new Error('o SQS não devolveu o ARN da DLQ');
  await client.send(new StartMessageMoveTaskCommand({ SourceArn: arn }));
}
