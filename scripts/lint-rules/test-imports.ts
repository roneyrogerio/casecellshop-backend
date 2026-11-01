// FND-13 e FND-14: o import dinâmico de um módulo restrito nos testes. O
// no-restricted-imports do oxlint só confere o import('…') quando a entrada não
// tem importNames, e as restrições dos testes travam só alguns nomes do módulo;
// o import dinâmico traz todos, então esta regra trava o módulo inteiro nessa
// forma. Formato de plugin do ESLint, carregado pelo jsPlugins do .oxlintrc.json.
import type { Context, Visitor } from './ast.ts';

// As opções seguem a forma do `paths` do no-restricted-imports.
const schema = [
  {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['name', 'message'],
          additionalProperties: false,
        },
      },
    },
    required: ['paths'],
    additionalProperties: false,
  },
];

const noRestrictedDynamicImport = {
  meta: { type: 'problem' as const, schema },
  // Stub: não reprova nada até a implementação.
  create(_context: Context): Visitor {
    return {};
  },
};

export default {
  meta: { name: 'test-imports' },
  rules: {
    'no-restricted-dynamic-import': noRestrictedDynamicImport,
  },
};
