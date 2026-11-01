// AI-19: regras de lint das formas do Kysely que deixam o tsc sem enxergar uma
// coluna, ou que montam SQL fora do builder (AD-017). Formato de plugin do ESLint,
// carregado pelo jsPlugins do .oxlintrc.json; as proibições de propriedade
// (sql.raw e as outras) ficam no no-restricted-properties da mesma configuração.
// A leitura é pela árvore de sintaxe: texto em comentário ou string não conta, e
// um regex no meio do código não confunde nada (A5 do #12).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RuleTester } from 'oxlint/plugins-dev';

// O oxlint não exporta os tipos de regra; vêm do RuleTester, que os recebe.
type Rule = Parameters<RuleTester['run']>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>['create']>[0];

// Só os campos que as regras leem; a árvore é a ESTree do oxlint.
interface Node {
  type: string;
  range: [number, number];
  parent?: Node;
  [key: string]: unknown;
}

type Handlers = Record<string, (node: Node) => void>;
type Visitor = ReturnType<Extract<Rule, { create: unknown }>['create']>;

// Os visitantes leem a árvore pela forma mínima acima; a conversão fica só aqui.
const visit = (handlers: Handlers): Visitor => handlers as unknown as Visitor;

const child = (node: Node, key: string): Node | undefined =>
  node[key] as Node | undefined;

const nameOf = (node: Node | undefined): string | undefined =>
  node?.type === 'Identifier' ? (node['name'] as string) : undefined;

// O nome da propriedade lida: k.sql, k['sql'] ou o método de pool.query().
function propertyName(member: Node): string | undefined {
  const property = child(member, 'property');
  if (!member['computed']) return nameOf(property);
  return property?.type === 'Literal' && typeof property['value'] === 'string'
    ? property['value']
    : undefined;
}

// A tag `sql`, com ou sem o tipo genérico; k.sql`…` é caso da no-sql-alias.
function isSqlTag(node: Node): boolean {
  return nameOf(child(node, 'tag')) === 'sql';
}

// O texto fixo do fragmento, sem os valores interpolados.
function fixedText(node: Node): string[] {
  const quasis = (child(node, 'quasi')?.['quasis'] ?? []) as Node[];
  return quasis.map(
    (quasi) => (quasi['value'] as { cooked?: string }).cooked ?? '',
  );
}

const CALLBACK_METHODS = new Set(['set', 'values', 'doUpdateSet']);
const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);

const noCallbackValues = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    // Uma função guardada num nome do arquivo tem o mesmo defeito da escrita
    // no argumento (A12 do #11); a declaração pode vir depois do uso.
    const functions = new Set<string>();
    const pending: { name: string; node: Node; method: string }[] = [];
    const message = (method: string) =>
      `${method} com callback deixa passar uma coluna desconhecida no tsc; use a forma de objeto`;
    return visit({
      FunctionDeclaration(node) {
        const name = nameOf(child(node, 'id'));
        if (name) functions.add(name);
      },
      VariableDeclarator(node) {
        const name = nameOf(child(node, 'id'));
        const init = child(node, 'init');
        if (name && init && FUNCTION_TYPES.has(init.type)) functions.add(name);
      },
      CallExpression(node) {
        const callee = child(node, 'callee');
        if (callee?.type !== 'MemberExpression') return;
        const method = propertyName(callee);
        if (!method || !CALLBACK_METHODS.has(method)) return;
        const argument = (node['arguments'] as Node[])[0];
        if (!argument) return;
        if (FUNCTION_TYPES.has(argument.type))
          context.report({ node, message: message(method) });
        const name = nameOf(argument);
        if (name) pending.push({ name, node, method });
      },
      'Program:exit'() {
        for (const { name, node, method } of pending)
          if (functions.has(name))
            context.report({ node, message: message(method) });
      },
    });
  },
};

// O sql com outro nome escaparia das outras regras, que olham a tag `sql` (A10 do #11).
const ALIAS_MESSAGE =
  'o sql do Kysely por outro nome escapa da conferência; importe e use como sql';

function isKyselyDynamicImport(node: Node | undefined): boolean {
  const inner =
    node?.type === 'AwaitExpression' ? child(node, 'argument') : node;
  const source =
    inner?.type === 'ImportExpression' ? child(inner, 'source') : undefined;
  return source?.['value'] === 'kysely';
}

const noSqlAlias = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    const namespaces = new Set<string>();
    const report = (node: Node) =>
      context.report({ node, message: ALIAS_MESSAGE });
    return visit({
      ImportDeclaration(node) {
        if (child(node, 'source')?.['value'] !== 'kysely') return;
        for (const specifier of node['specifiers'] as Node[]) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            const local = nameOf(child(specifier, 'local'));
            if (local) namespaces.add(local);
          } else if (
            specifier.type === 'ImportSpecifier' &&
            nameOf(child(specifier, 'imported')) === 'sql' &&
            nameOf(child(specifier, 'local')) !== 'sql'
          ) {
            report(specifier);
          }
        }
      },
      // const { sql: s } = k, ou de um import('kysely') dinâmico.
      VariableDeclarator(node) {
        const id = child(node, 'id');
        const init = child(node, 'init');
        if (id?.type !== 'ObjectPattern') return;
        const fromKysely =
          namespaces.has(nameOf(init) ?? '') || isKyselyDynamicImport(init);
        if (!fromKysely) return;
        for (const property of id['properties'] as Node[]) {
          if (property.type !== 'Property') continue;
          const key = nameOf(child(property, 'key'));
          const value = nameOf(child(property, 'value'));
          if (key === 'sql' && value !== 'sql') report(property);
        }
      },
      MemberExpression(node) {
        const object = child(node, 'object');
        if (
          namespaces.has(nameOf(object) ?? '') &&
          propertyName(node) === 'sql'
        )
          report(node);
      },
      Identifier(node) {
        if (node['name'] !== 'sql') return;
        const parent = node.parent;
        if (!parent) return;
        const assigned =
          parent.type === 'VariableDeclarator' &&
          child(parent, 'init') === node;
        const argument =
          (parent.type === 'CallExpression' ||
            parent.type === 'NewExpression') &&
          (parent['arguments'] as Node[]).includes(node);
        const bracket =
          parent.type === 'MemberExpression' &&
          parent['computed'] === true &&
          child(parent, 'object') === node;
        if (assigned || argument || bracket) report(node);
      },
    });
  },
};

const COMMAND = /^\s*(?:select|insert|update|delete|with)\b/i;

const noSqlCommand = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    return visit({
      TaggedTemplateExpression(node) {
        if (isSqlTag(node) && COMMAND.test(fixedText(node)[0] ?? ''))
          context.report({
            node,
            message: 'comando inteiro dentro de sql`…`; escreva pelo builder',
          });
      },
    });
  },
};

// As colunas de todas as tabelas dos arquivos gerados em typesDir (FND-09): as
// chaves de cada interface, fora a DB, que lista as tabelas.
export function readGeneratedColumns(typesDir: string): Set<string> {
  const columns = new Set<string>();
  for (const name of readdirSync(typesDir)) {
    if (!name.endsWith('.ts')) continue;
    const content = readFileSync(path.join(typesDir, name), 'utf8');
    for (const [, table, body] of content.matchAll(
      /export interface (\w+)\s*\{([^}]*)\}/g,
    )) {
      if (table === 'DB' || body === undefined) continue;
      for (const [, , key] of body.matchAll(/^\s*(["']?)(\w+)\1\??\s*:/gm))
        if (key) columns.add(key);
    }
  }
  return columns;
}

// Pelo lugar deste arquivo, e não pelo cwd: o lint roda de qualquer pasta.
const TYPES_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'db',
  'types',
);
let generatedColumns: Set<string> | undefined;

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

const noSqlColumn = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    generatedColumns ??= readGeneratedColumns(TYPES_DIR);
    const columns = generatedColumns;
    return visit({
      TaggedTemplateExpression(node) {
        if (!isSqlTag(node)) return;
        const cited = new Set<string>();
        for (const part of fixedText(node))
          for (const [word] of part.matchAll(IDENTIFIER))
            if (columns.has(word)) cited.add(word);
        if (cited.size > 0)
          context.report({
            node,
            message: `coluna dentro de sql\`…\` (${[...cited].join(', ')}), fora da conferência do tsc; use eb.ref`,
          });
      },
    });
  },
};

// Chamada, e não propriedade: o req.query do Express é legítimo. A configuração
// desliga a regra em src/db/, onde mora o runInTransaction (FND-10).
const DIRECT_METHODS = new Set(['query', 'transaction', 'startTransaction']);

const noDirectQuery = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    return visit({
      CallExpression(node) {
        const callee = child(node, 'callee');
        const method =
          callee?.type === 'MemberExpression'
            ? propertyName(callee)
            : nameOf(callee) === 'startTransaction'
              ? 'startTransaction'
              : undefined;
        if (method && DIRECT_METHODS.has(method))
          context.report({
            node,
            message: `o .${method}() fica só em src/db/; a transação abre pelo runInTransaction`,
          });
      },
    });
  },
};

export default {
  meta: { name: 'kysely' },
  rules: {
    'no-callback-values': noCallbackValues,
    'no-sql-alias': noSqlAlias,
    'no-sql-command': noSqlCommand,
    'no-sql-column': noSqlColumn,
    'no-direct-query': noDirectQuery,
  },
};
