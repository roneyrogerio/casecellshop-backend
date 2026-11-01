// FND-13 e FND-14: o import dinâmico de um módulo restrito nos testes. O
// no-restricted-imports do oxlint só confere o import('…') quando a entrada não
// tem importNames, e as restrições dos testes travam só alguns nomes do módulo;
// o import dinâmico traz todos, então esta regra trava o módulo inteiro nessa
// forma. Formato de plugin do ESLint, carregado pelo jsPlugins do .oxlintrc.json.
import { type Context, importSource, visit, type Visitor } from './ast.ts';

interface RestrictedPath {
  name: string;
  message: string;
}

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
  create(context: Context): Visitor {
    // O oxlint já validou as opções contra o esquema acima.
    const options = context.options[0] as
      { paths: RestrictedPath[] } | undefined;
    const messages = new Map(
      (options?.paths ?? []).map(({ name, message }) => [name, message]),
    );
    return visit({
      // Um nome calculado (import(nome)) não tem texto fixo e fica de fora,
      // como na regra do Kysely.
      ImportExpression(node) {
        const source = importSource(node);
        const message =
          typeof source === 'string' ? messages.get(source) : undefined;
        if (message !== undefined) context.report({ node, message });
      },
    });
  },
};

export default {
  meta: { name: 'test-imports' },
  rules: {
    'no-restricted-dynamic-import': noRestrictedDynamicImport,
  },
};
