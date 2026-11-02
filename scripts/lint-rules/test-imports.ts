// FND-13 e FND-14: o import dinâmico de um módulo restrito nos testes. O
// no-restricted-imports do oxlint só confere o import('…') quando a entrada não
// tem importNames, e as restrições dos testes travam só alguns nomes do módulo;
// o import dinâmico traz todos, então esta regra trava o módulo inteiro nessa
// forma. Em src/, trava o import('pino') fora do logging (OBS-07). Formato de
// plugin do ESLint, carregado pelo jsPlugins do .oxlintrc.json.
import { type Context, importSource, visit, type Visitor } from './ast.ts';

interface RestrictedPath {
  name: string;
  message: string;
}

interface RestrictedPattern {
  regex: string;
  message: string;
}

const entry = (key: 'name' | 'regex') => ({
  type: 'object',
  properties: {
    [key]: { type: 'string' },
    message: { type: 'string' },
  },
  required: [key, 'message'],
  additionalProperties: false,
});

// As opções seguem a forma do no-restricted-imports: `paths` pelo nome exato do módulo e `patterns` por expressão
// regular, para pegar também um caminho dentro do pacote (`pino/pino.js`).
const schema = [
  {
    type: 'object',
    properties: {
      paths: { type: 'array', items: entry('name') },
      patterns: { type: 'array', items: entry('regex') },
    },
    additionalProperties: false,
  },
];

type Options =
  { paths?: RestrictedPath[]; patterns?: RestrictedPattern[] } | undefined;

// A mensagem do primeiro nome ou padrão que casa com o módulo, ou nenhuma.
function restrictionOf(
  options: Options,
): (source: string) => string | undefined {
  const byName = new Map(
    (options?.paths ?? []).map(({ name, message }) => [name, message]),
  );
  const byPattern = (options?.patterns ?? []).map(({ regex, message }) => ({
    regex: new RegExp(regex, 'u'),
    message,
  }));
  return (source) =>
    byName.get(source) ??
    byPattern.find(({ regex }) => regex.test(source))?.message;
}

const noRestrictedDynamicImport = {
  meta: { type: 'problem' as const, schema },
  create(context: Context): Visitor {
    // O oxlint já validou as opções contra o esquema acima.
    const messageFor = restrictionOf(context.options[0] as Options);
    return visit({
      // Um nome calculado (import(nome)) não tem texto fixo e fica de fora,
      // como na regra do Kysely.
      ImportExpression(node) {
        const source = importSource(node);
        const message =
          typeof source === 'string' ? messageFor(source) : undefined;
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
