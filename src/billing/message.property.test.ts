import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  expectFalsified,
  expectProperty,
} from '../../test/helpers/properties.ts';
import { BillingMessage } from '../contract/index.ts';
import { parseBillingMessage, type ParsedBillingMessage } from './message.ts';

// FND-15, "Mensagem da fila": qualquer texto vira uma mensagem válida ou o resultado de mensagem inválida, sem lançar.

type Parser = (body: string) => ParsedBillingMessage;

function readJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

// O oráculo é o contrato: o texto é uma mensagem válida se, e só se, o JSON dele passa no schema; a inválida
// leva o orderId só quando o JSON o traz como texto.
function expectedFor(body: string): ParsedBillingMessage {
  const json = readJson(body);
  const parsed = BillingMessage.safeParse(json);
  if (parsed.success) return { valid: true, message: parsed.data };
  const hasOrderId =
    typeof json === 'object' && json !== null && 'orderId' in json;
  return {
    valid: false,
    orderId:
      hasOrderId && typeof json.orderId === 'string' ? json.orderId : undefined,
  };
}

const correlationIdArb = fc.stringMatching(/^[\x21-\x7E]{1,128}$/);

// Perto da forma certa: os dois campos, cada um certo ou errado, mais chaves a mais ou a menos.
const nearShapeArb = fc
  .record(
    {
      orderId: fc.oneof(fc.uuid(), fc.string(), fc.jsonValue()),
      correlationId: fc.oneof(
        correlationIdArb,
        fc.string({ maxLength: 200 }),
        fc.jsonValue(),
      ),
      extra: fc.jsonValue(),
    },
    { requiredKeys: [] },
  )
  .map((value) => JSON.stringify(value));

const validArb = fc
  .record({ orderId: fc.uuid(), correlationId: correlationIdArb })
  .map((value) => JSON.stringify(value));

const textArb = fc.oneof(
  fc.string(),
  fc.string({ unit: 'binary' }),
  fc.json(),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  nearShapeArb,
  validArb,
);

function parsesWithoutThrowing(candidate: Parser) {
  return fc.property(textArb, (body) => {
    expect(candidate(body)).toEqual(expectedFor(body));
  });
}

describe('FND-15 parseBillingMessage', () => {
  it('FND-15 qualquer texto vira mensagem válida ou o resultado de inválida, sem lançar', () => {
    expectProperty(parsesWithoutThrowing(parseBillingMessage));
  });

  it('FND-15 toda mensagem bem formada é aceita e devolvida como veio', () => {
    expectProperty(
      fc.property(
        fc.record({ orderId: fc.uuid(), correlationId: correlationIdArb }),
        (message) => {
          expect(parseBillingMessage(JSON.stringify(message))).toEqual({
            valid: true,
            message,
          });
        },
      ),
    );
  });

  it.each([
    {
      defect: 'que lança com JSON quebrado',
      broken: (body: string): ParsedBillingMessage => {
        const parsed = BillingMessage.safeParse(JSON.parse(body));
        return parsed.success
          ? { valid: true, message: parsed.data }
          : { valid: false, orderId: undefined };
      },
    },
    {
      defect: 'que aceita qualquer JSON como mensagem',
      broken: (body: string): ParsedBillingMessage => ({
        valid: true,
        message: readJson(body) as BillingMessage,
      }),
    },
    {
      defect: 'que perde o orderId da mensagem inválida',
      broken: (body: string): ParsedBillingMessage => {
        const parsed = BillingMessage.safeParse(readJson(body));
        return parsed.success
          ? { valid: true, message: parsed.data }
          : { valid: false, orderId: undefined };
      },
    },
  ])(
    'FND-15 controle negativo: a mesma propriedade reprova o parser $defect',
    ({ broken }) => {
      expectFalsified(parsesWithoutThrowing(broken));
    },
  );
});
