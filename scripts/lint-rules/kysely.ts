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

// Membros que devolvem o sql por outro nome: o sql do Kysely não os usa como API.
const ALIAS_METHODS = new Set(['bind', 'call', 'apply']);

// O texto da origem de um import('…'), em string ou em template sem valor.
function importSource(node: Node): unknown {
  const source = child(node, 'source');
  if (source?.type === 'Literal') return source['value'];
  const quasis = (source?.['quasis'] ?? []) as Node[];
  const [only] = quasis;
  return source?.type === 'TemplateLiteral' && quasis.length === 1 && only
    ? (only['value'] as { cooked?: string }).cooked
    : undefined;
}

// Pais em que o identificador, onde quer que esteja, é nome e não valor:
// declarar uma variável sql local não leva o do Kysely adiante.
const NAME_ONLY_PARENTS = new Set([
  'RestElement',
  'ArrayPattern',
  'BreakStatement',
  'ContinueStatement',
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
]);

// Pais em que o identificador é nome só nestas chaves; em outra (o corpo de
// uma seta, a classe estendida) é o valor.
const NAME_KEYS: Record<string, string[]> = {
  FunctionDeclaration: ['id', 'params'],
  FunctionExpression: ['id', 'params'],
  ArrowFunctionExpression: ['params'],
  ClassDeclaration: ['id'],
  ClassExpression: ['id'],
  CatchClause: ['param'],
  LabeledStatement: ['label'],
  VariableDeclarator: ['id'],
  AssignmentPattern: ['left'],
};

// Asserções de tipo levam o valor adiante: (sql as any).raw escaparia do
// no-restricted-properties, que olha o objeto sql.
const TS_VALUE_WRAPPERS = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);

function holds(parent: Node, key: string, node: Node): boolean {
  const value = parent[key];
  return Array.isArray(value) ? value.includes(node) : value === node;
}

// O sql só passa como tag de um fragmento, como objeto de um membro não
// computado (as propriedades proibidas ficam no no-restricted-properties) ou
// onde o identificador é nome, e não valor.
function sqlUseAllowed(node: Node, parent: Node): boolean {
  const is = (key: string) => holds(parent, key, node);
  const nameKeys = NAME_KEYS[parent.type];
  if (nameKeys) return nameKeys.some(is);
  if (NAME_ONLY_PARENTS.has(parent.type)) return true;
  if (TS_VALUE_WRAPPERS.has(parent.type)) return false;
  switch (parent.type) {
    case 'TaggedTemplateExpression':
      return is('tag');
    case 'MemberExpression':
      return !(parent['computed'] && is('object'));
    case 'Property':
      // Na desestruturação o valor é declaração; num objeto literal, o valor
      // leva o sql adiante (o { sql } abreviado também) e a chave é nome.
      if (parent.parent?.type === 'ObjectPattern') return true;
      if (is('value')) return false;
      return is('key') && !parent['computed'];
    case 'MethodDefinition':
    case 'PropertyDefinition':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
      return is('key') && !parent['computed'];
    case 'ExportSpecifier':
      return !is('local');
    default:
      // Posições de tipo (typeof sql, nomes qualificados) não levam o valor.
      return parent.type.startsWith('TS');
  }
}

// Os namespaces de import * as k from 'kysely'. Os imports ficam no nível do
// módulo, mas podem vir depois do uso no texto: por isso são lidos no início
// do Program, antes de qualquer identificador.
function kyselyNamespaces(program: Node): Set<string> {
  const namespaces = new Set<string>();
  for (const statement of program['body'] as Node[]) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (child(statement, 'source')?.['value'] !== 'kysely') continue;
    for (const specifier of statement['specifiers'] as Node[]) {
      const local = nameOf(child(specifier, 'local'));
      if (specifier.type === 'ImportNamespaceSpecifier' && local)
        namespaces.add(local);
    }
  }
  return namespaces;
}

// O namespace passa onde o sql passa e também desestruturado numa declaração
// (const { sql } = k), onde o sql renomeado reprova no VariableDeclarator.
function namespaceUseAllowed(node: Node, parent: Node): boolean {
  if (
    parent.type === 'VariableDeclarator' &&
    holds(parent, 'init', node) &&
    child(parent, 'id')?.type === 'ObjectPattern'
  )
    return true;
  return sqlUseAllowed(node, parent);
}

const noSqlAlias = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    let namespaces = new Set<string>();
    const report = (node: Node) =>
      context.report({ node, message: ALIAS_MESSAGE });
    return visit({
      Program(node) {
        namespaces = kyselyNamespaces(node);
      },
      // O sql renomeado reprova de qualquer módulo, porque um módulo nosso pode
      // reexportar o do Kysely e a regra não segue o import entre arquivos (A14
      // do #21).
      ImportDeclaration(node) {
        for (const specifier of node['specifiers'] as Node[]) {
          if (
            specifier.type === 'ImportSpecifier' &&
            nameOf(child(specifier, 'imported')) === 'sql' &&
            nameOf(child(specifier, 'local')) !== 'sql'
          ) {
            report(specifier);
          }
        }
      },
      // export * from 'kysely' entrega o sql a quem importa deste módulo, por
      // qualquer nome.
      ExportAllDeclaration(node) {
        if (child(node, 'source')?.['value'] === 'kysely') report(node);
      },
      // Todo import('kysely') reprova: o namespace dinâmico chega ao sql por
      // caminhos que a árvore de um arquivo não acompanha, como o .then((k) =>
      // k.sql) ou uma atribuição depois da declaração (A6 do #27).
      ImportExpression(node) {
        if (importSource(node) === 'kysely') report(node);
      },
      // const { sql: s } = k: o sql renomeado na desestruturação do namespace.
      VariableDeclarator(node) {
        const id = child(node, 'id');
        if (id?.type !== 'ObjectPattern') return;
        if (!namespaces.has(nameOf(child(node, 'init')) ?? '')) return;
        for (const property of id['properties'] as Node[]) {
          if (property.type !== 'Property') continue;
          const key = nameOf(child(property, 'key'));
          const value = nameOf(child(property, 'value'));
          if (key === 'sql' && value !== 'sql') report(property);
        }
      },
      // k.sql pelo namespace; bind, call e apply devolvem o sql por outro nome.
      // O computado (k['sql'], sql['bind']) já cai no Identifier, que não
      // aceita colchete (A13 do #21).
      MemberExpression(node) {
        if (node['computed']) return;
        const object = nameOf(child(node, 'object')) ?? '';
        const property = propertyName(node) ?? '';
        if (
          (namespaces.has(object) && property === 'sql') ||
          (object === 'sql' && ALIAS_METHODS.has(property))
        )
          report(node);
      },
      // Lista do que passa, e não do que reprova: qualquer outro lugar onde o
      // valor sql vai (atribuição, parâmetro padrão, objeto, retorno,
      // reexportação) o guarda com outro nome (A1 do #21).
      // O namespace segue a mesma lista: guardado, espalhado, passado ou sob uma
      // asserção, ele leva o sql adiante com outro nome (A7 do #27).
      Identifier(node) {
        const name = node['name'] as string;
        const parent = node.parent;
        if (!parent) return;
        if (name === 'sql' && !sqlUseAllowed(node, parent)) report(node);
        else if (namespaces.has(name) && !namespaceUseAllowed(node, parent))
          report(node);
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
