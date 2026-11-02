// Atributos da convenção de mensageria do OpenTelemetry, ainda em desenvolvimento
// (https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/). O README de
// @opentelemetry/semantic-conventions recomenda copiar essas constantes em vez de importar
// de `/incubating`, cujos nomes podem mudar entre versões.
export const ATTR_MESSAGING_SYSTEM = 'messaging.system';
export const ATTR_MESSAGING_OPERATION_NAME = 'messaging.operation.name';
export const ATTR_MESSAGING_OPERATION_TYPE = 'messaging.operation.type';
export const ATTR_MESSAGING_DESTINATION_NAME = 'messaging.destination.name';
export const ATTR_MESSAGING_BATCH_MESSAGE_COUNT =
  'messaging.batch.message_count';

export const MESSAGING_SYSTEM_VALUE_AWS_SQS = 'aws_sqs';
export const MESSAGING_OPERATION_TYPE_VALUE_SEND = 'send';
