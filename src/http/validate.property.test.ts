import express, { type RequestHandler } from 'express';
import * as fc from 'fast-check';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { captureLogs } from '../../test/helpers/logs.ts';
import {
  expectAsyncProperty,
  expectFalsifiedAsync,
} from '../../test/helpers/properties.ts';
import {
  expectMatchesContract,
  findRoute,
} from '../../test/helpers/contract.ts';
import { CheckoutRequest } from '../contract/index.ts';
import { createTelemetry } from '../shared/telemetry.ts';
import { createErrorHandler, ProblemError } from './problem.ts';
import { requestContext } from './request-context.ts';
import { validateRequest } from './validate.ts';

// FND-15, "Validação da requisição": um corpo fora do contrato de uma rota real (POST /checkout) dá 400 em
// problem+json, com um erro por campo violado e mensagens só da lista do módulo, sem lançar.

type Validator = (route: RouteConfig) => RequestHandler;

const route = findRoute('post', '/checkout');
const telemetry = createTelemetry();
const { logger } = captureLogs('casecellshop-api', 'silent');

afterAll(() => telemetry.shutdown());

// A lista de mensagens do módulo (src/http/validate.ts), enumerada aqui pelo que a API devolve ao cliente.
const MODULE_MESSAGES = [
  'Tipo inválido',
  'Valor abaixo do mínimo',
  'Valor acima do máximo',
  'Formato inválido',
  'Valor não permitido',
  'Parâmetro desconhecido',
  'Valor inválido',
];

function appWith(validator: Validator) {
  const app = express();
  app.use(requestContext(telemetry, logger));
  // strict: false deixa passar `null`, número e texto como corpo, que também estão fora do contrato.
  app.use(express.json({ strict: false }));
  app.post('/checkout', validator(route), (_req, res) => {
    res.status(204).end();
  });
  app.use(createErrorHandler(logger));
  return app;
}

const skuArb = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9._-]{1,64}$/),
  fc.string(),
  fc.jsonValue(),
);

// Perto do contrato: itens quase certos, com campos errados, chaves a mais e listas de tamanho fora do limite.
const itemArb = fc.oneof(
  fc.record(
    {
      sku: skuArb,
      quantity: fc.oneof(
        fc.integer({ min: -3, max: 15 }),
        fc.constantFrom(2 ** 53, -(2 ** 53)),
        fc.jsonValue(),
      ),
      expectedUnitPrice: fc.oneof(
        fc.integer({ min: -100, max: 10_000 }),
        // Fora da faixa dos inteiros seguros, o número viola dois limites de uma vez.
        fc.constantFrom(2 ** 53, -(2 ** 53), 1e300, -1e300),
        fc.double(),
        fc.jsonValue(),
      ),
      extra: fc.jsonValue(),
    },
    { requiredKeys: [] },
  ),
  fc.jsonValue(),
);

const nearBodyArb = fc.record(
  {
    items: fc.oneof(fc.array(itemArb, { maxLength: 25 }), fc.jsonValue()),
    extra: fc.jsonValue(),
  },
  { requiredKeys: [] },
);

// Só entra o corpo que o contrato recusa: a propriedade é sobre o que está fora dele.
const invalidBodyArb = fc
  .oneof(fc.jsonValue(), nearBodyArb, nearBodyArb)
  .filter((body) => !CheckoutRequest.safeParse(body).success);

// Um erro por violação do schema do contrato, na ordem; a chave desconhecida conta uma a uma, com o nome no caminho.
function expectedPaths(body: unknown): string[] {
  const parsed = CheckoutRequest.safeParse(body);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) =>
          ['body', ...issue.path.map(String), key].join('.'),
        )
      : [['body', ...issue.path.map(String)].join('.')],
  );
}

function rejectsWithOneErrorPerField(validator: Validator) {
  const app = appWith(validator);
  return fc.asyncProperty(invalidBodyArb, async (body) => {
    const response = await request(app)
      .post('/checkout')
      .set('Idempotency-Key', 'chave-property-0001')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));

    expect(response.status).toBe(400);
    expectMatchesContract(route, {
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
    const problem = response.body as {
      errors?: { path: string; message: string }[];
    };
    const errors = problem.errors ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((error) => error.path)).toEqual(expectedPaths(body));
    expect(new Set(errors.map((error) => error.path)).size).toBe(errors.length);
    for (const error of errors) {
      expect(MODULE_MESSAGES).toContain(error.message);
    }
  });
}

// Versões quebradas do validador, escritas aqui.
const rawZodMessages: Validator = () => (req, _res, next) => {
  const parsed = CheckoutRequest.safeParse(req.body);
  if (parsed.success) {
    next();
    return;
  }
  next(
    new ProblemError({
      status: 400,
      cause: 'invalid-request',
      title: 'Requisição fora do contrato',
      errors: parsed.error.issues.map((issue) => ({
        path: ['body', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    }),
  );
};

const acceptsEverything: Validator = () => (_req, _res, next) => {
  next();
};

const throwsOnPrimitiveBody: Validator = (target) => {
  const real = validateRequest(target);
  return (req, res, next) => {
    if (typeof req.body !== 'object' || req.body === null)
      throw new TypeError('corpo não é objeto');
    real(req, res, next);
  };
};

const onlyFirstError: Validator = (target) => {
  const real = validateRequest(target);
  return (req, res, next) => {
    real(req, res, (error?: unknown) => {
      if (error instanceof ProblemError && error.init.errors) {
        next(
          new ProblemError({
            ...error.init,
            errors: error.init.errors.slice(0, 1),
          }),
        );
        return;
      }
      next(error);
    });
  };
};

describe('FND-15 validateRequest', () => {
  it('FND-15 qualquer corpo fora do contrato dá 400 em problem+json, com um erro por campo e mensagens da lista do módulo', async () => {
    await expectAsyncProperty(rejectsWithOneErrorPerField(validateRequest));
  });

  it.each([
    { defect: 'devolve a mensagem crua do zod', broken: rawZodMessages },
    { defect: 'aceita qualquer corpo', broken: acceptsEverything },
    {
      defect: 'lança com corpo que não é objeto',
      broken: throwsOnPrimitiveBody,
    },
    { defect: 'devolve só o primeiro erro', broken: onlyFirstError },
  ])(
    'FND-15 controle negativo: a mesma propriedade reprova o validador que $defect',
    async ({ broken }) => {
      await expectFalsifiedAsync(rejectsWithOneErrorPerField(broken));
    },
  );
});
