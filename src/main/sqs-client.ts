import type { SQSClient } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../queue/sqs.ts';
import { optionalEnv, requireEnv } from '../shared/config.ts';

// A leitura do ambiente fica aqui, na composição (AD-025); a fronteira do SQS
// recebe os valores prontos. O endpoint vem vazio na AWS real; no compose, é o do ElasticMQ.
export function createSqsClientFromEnv(): SQSClient {
  const endpoint = optionalEnv('SQS_ENDPOINT');
  return createSqsClient({
    region: requireEnv('AWS_REGION'),
    ...(endpoint ? { endpoint } : {}),
  });
}
