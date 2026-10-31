import type { SQSClient } from '@aws-sdk/client-sqs';

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

export function createSqsClient(_settings: SqsSettings): SQSClient {
  throw new Error('não implementado');
}

export function createQueue(_client: SQSClient, _queueUrl: string): Queue {
  throw new Error('não implementado');
}

// StartMessageMoveTask da DLQ para a fila de origem dela.
export function startRedrive(_client: SQSClient, _dlqUrl: string): Promise<void> {
  throw new Error('não implementado');
}
