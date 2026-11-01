// FND-13: regras de lint das esperas e das portas dos testes de integração. Formato
// de plugin do ESLint, carregado pelo jsPlugins do .oxlintrc.json só para
// test/integration/ e test/helpers/. A leitura é pela árvore de sintaxe, como no
// plugin do Kysely: comentário e string não contam, e o prazo é lido como
// expressão (A3 da Revisão 1 do PR C).
import type { RuleTester } from 'oxlint/plugins-dev';

type Rule = Parameters<RuleTester['run']>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>['create']>[0];
type Visitor = ReturnType<Extract<Rule, { create: unknown }>['create']>;

// Só os campos que as regras leem; a árvore é a ESTree do oxlint.
interface Node {
  type: string;
  range: [number, number];
  parent?: Node;
  [key: string]: unknown;
}

type Handlers = Record<string, (node: Node) => void>;

// Os visitantes leem a árvore pela forma mínima acima; a conversão fica só aqui.
const visit = (handlers: Handlers): Visitor => handlers as unknown as Visitor;

const child = (node: Node | undefined, key: string): Node | undefined =>
  node?.[key] as Node | undefined;

const args = (call: Node): Node[] => (call['arguments'] ?? []) as Node[];

const nameOf = (node: Node | undefined): string | undefined =>
  node?.type === 'Identifier' ? (node['name'] as string) : undefined;

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string';

// Os filhos de um nó, em qualquer chave, sem subir pelo parent.
function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'parent') return [];
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

function some(node: Node, test: (node: Node) => boolean): boolean {
  return test(node) || children(node).some((inner) => some(inner, test));
}

// O nome chamado: f() ou x.f(), sem colchete.
function calleeName(call: Node): string | undefined {
  const callee = child(call, 'callee');
  if (callee?.type === 'MemberExpression' && !callee['computed'])
    return nameOf(child(callee, 'property'));
  return nameOf(callee);
}

// As esperas do Vitest que repetem uma conferência até um prazo: a conferência no
// primeiro argumento e o { timeout } no segundo.
const WAITS: Record<string, Set<string>> = {
  vi: new Set(['waitFor', 'waitUntil']),
  expect: new Set(['poll']),
};

function isVitestWait(call: Node): boolean {
  const callee = child(call, 'callee');
  if (callee?.type !== 'MemberExpression' || callee['computed']) return false;
  const object = nameOf(child(callee, 'object')) ?? '';
  const method = nameOf(child(callee, 'property')) ?? '';
  return WAITS[object]?.has(method) ?? false;
}

const isCall = (node: Node | undefined): node is Node =>
  node?.type === 'CallExpression';

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

// ---------------------------------------------------------------- no-fixed-step

// O avanço que o relógio dos testes aceita dentro de uma espera: só até a próxima
// espera pendente, e só com o sistema parado (FND-13, "Relógio controlado").
const ALLOWED_ADVANCE = new Set(['advanceIdle', 'advanceToNext']);

function isAllowedReference(node: Node | undefined): boolean {
  if (node?.type === 'MemberExpression' && !node['computed'])
    return ALLOWED_ADVANCE.has(nameOf(child(node, 'property')) ?? '');
  return ALLOWED_ADVANCE.has(nameOf(node) ?? '');
}

const isAllowedCall = (node: Node | undefined): boolean =>
  isCall(node) &&
  args(node).length === 0 &&
  isAllowedReference(child(node, 'callee'));

// O primeiro argumento do waitAdvancing: a referência a advanceIdle ou
// advanceToNext, ou uma função que só a chama.
function isAllowedAdvance(node: Node | undefined): boolean {
  if (isAllowedReference(node)) return true;
  if (!node || !FUNCTION_TYPES.has(node.type)) return false;
  const body = child(node, 'body');
  if (body?.type !== 'BlockStatement') return isAllowedCall(body);
  const statements = (body['body'] ?? []) as Node[];
  const [only] = statements;
  return (
    statements.length === 1 &&
    only?.type === 'ExpressionStatement' &&
    isAllowedCall(child(only, 'expression'))
  );
}

// A espera real que envolve o nó: a conferência de um vi.waitFor, ou qualquer
// argumento de um waitAdvancing.
function insideWait(node: Node): boolean {
  for (let current = node; current.parent; current = current.parent) {
    const parent = current.parent;
    if (!isCall(parent)) continue;
    const position = args(parent).indexOf(current);
    if (position < 0) continue;
    if (isVitestWait(parent) && position === 0) return true;
    if (calleeName(parent) === 'waitAdvancing') return true;
  }
  return false;
}

const noFixedStep = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    return visit({
      CallExpression(node) {
        if (calleeName(node) === 'waitAdvancing') {
          const [advance] = args(node);
          if (!isAllowedAdvance(advance))
            context.report({
              node: advance ?? node,
              message:
                'o waitAdvancing só avança pelo advanceIdle ou pelo advanceToNext (FND-13)',
            });
        }
        const callee = child(node, 'callee');
        if (
          callee?.type === 'MemberExpression' &&
          !callee['computed'] &&
          nameOf(child(callee, 'property')) === 'advance' &&
          insideWait(node)
        )
          context.report({
            node,
            message:
              'avançar o relógio por passo fixo dentro de uma espera real passa por cima de uma chamada em voo (FND-13)',
          });
      },
    });
  },
};

// ---------------------------------------------------------------- wait-guard

const GUARD = 'WAIT_GUARD_MS';

const isGuard = (node: Node | undefined): boolean => nameOf(node) === GUARD;

const isFactor = (node: Node | undefined): boolean =>
  node?.type === 'Literal' &&
  typeof node['value'] === 'number' &&
  node['value'] >= 1;

// O prazo é o próprio WAIT_GUARD_MS ou ele vezes um literal ≥ 1: uma divisão, uma
// subtração ou um Math.min o encurtariam por baixo do nome (A11 da Revisão 3).
function isGuardExpression(node: Node | undefined): boolean {
  if (isGuard(node)) return true;
  if (node?.type !== 'BinaryExpression' || node['operator'] !== '*')
    return false;
  const left = child(node, 'left');
  const right = child(node, 'right');
  return (
    (isGuard(left) && isFactor(right)) || (isFactor(left) && isGuard(right))
  );
}

// O nome declarado por um parâmetro e o padrão dele, se houver: x, x = v,
// { x = v } e { x = v } = {}.
function parameterDefault(
  parameter: Node,
  name: string,
): { found: boolean; fallback?: Node | undefined } {
  if (nameOf(parameter) === name) return { found: true };
  if (parameter.type === 'AssignmentPattern') {
    const left = child(parameter, 'left');
    if (nameOf(left) === name)
      return { found: true, fallback: child(parameter, 'right') };
    return left ? parameterDefault(left, name) : { found: false };
  }
  if (parameter.type === 'ObjectPattern')
    for (const property of (parameter['properties'] ?? []) as Node[]) {
      const value = child(property, 'value');
      const result = value
        ? parameterDefault(value, name)
        : { found: false as const };
      if (result.found) return result;
    }
  return { found: false };
}

// O prazo cita o WAIT_GUARD_MS, ou vem de um parâmetro da função que envolve a
// espera cujo padrão o cita: quem chama pode encurtar o prazo só de propósito,
// como o controle negativo do stop() do banco de migração.
function guarded(node: Node | undefined): boolean {
  if (!node) return false;
  if (isGuardExpression(node)) return true;
  const name = nameOf(node);
  if (!name) return false;
  for (let current = node.parent; current; current = current.parent) {
    if (!FUNCTION_TYPES.has(current.type)) continue;
    for (const parameter of (current['params'] ?? []) as Node[]) {
      const { found, fallback } = parameterDefault(parameter, name);
      if (found) return isGuardExpression(fallback);
    }
  }
  return false;
}

function timeoutOf(options: Node | undefined): Node | undefined {
  if (options?.type !== 'ObjectExpression') return undefined;
  for (const property of (options['properties'] ?? []) as Node[]) {
    if (property.type !== 'Property' || property['computed']) continue;
    const key = child(property, 'key');
    if (nameOf(key) === 'timeout' || key?.['value'] === 'timeout')
      return child(property, 'value');
  }
  return undefined;
}

const waitGuard = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    const report = (node: Node) =>
      context.report({
        node,
        message:
          'o prazo real da espera usa o WAIT_GUARD_MS, igual ao testTimeout: um prazo menor decide o teste pela carga da máquina (FND-13)',
      });
    return visit({
      CallExpression(node) {
        if (isVitestWait(node)) {
          if (!guarded(timeoutOf(args(node)[1]))) report(node);
        } else if (nameOf(child(node, 'callee')) === 'observe') {
          if (!guarded(args(node)[1])) report(node);
        }
      },
    });
  },
};

// ---------------------------------------------------------------- no-port-before-up

const COMPOSE_UP = 'upComposeProject';

const isZero = (node: Node | undefined): boolean =>
  node?.type === 'Literal' && node['value'] === 0;

// O port de um listen({ port, host }).
function portOf(options: Node): Node | undefined {
  if (options.type !== 'ObjectExpression') return undefined;
  for (const property of (options['properties'] ?? []) as Node[])
    if (nameOf(child(property, 'key')) === 'port')
      return child(property, 'value');
  return undefined;
}

// Num arquivo que sobe o compose, a porta do host vem do Docker (porta 0) e é lida
// depois do up; escolhê-la antes deixa outro processo ocupá-la até o up.
const noPortBeforeUp = {
  meta: { type: 'problem' as const },
  create(context: Context): Visitor {
    let composeFile = false;
    const report = (node: Node, what: string) => {
      if (composeFile)
        context.report({
          node,
          message: `${what} antes do up do compose; o Docker escolhe a porta (porta 0) e o teste a lê depois (FND-13)`,
        });
    };
    return visit({
      Program(node) {
        composeFile = some(
          node,
          (inner) => isCall(inner) && calleeName(inner) === COMPOSE_UP,
        );
      },
      Identifier(node) {
        if (node['name'] === 'freePort') report(node, 'um freePort');
      },
      CallExpression(node) {
        if (calleeName(node) !== 'listen') return;
        const [first] = args(node);
        if (!first || isZero(first) || isZero(portOf(first)))
          report(node, 'um listen sem porta fixa');
      },
      ImportDeclaration(node) {
        if (child(node, 'source')?.['value'] !== 'node:net') return;
        if (node['importKind'] === 'type') return;
        const specifiers = (node['specifiers'] ?? []) as Node[];
        const value =
          specifiers.length === 0 ||
          specifiers.some((specifier) => specifier['importKind'] !== 'type');
        if (value) report(node, 'um import de valor do node:net');
      },
    });
  },
};

export default {
  meta: { name: 'test-waits' },
  rules: {
    'no-fixed-step': noFixedStep,
    'wait-guard': waitGuard,
    'no-port-before-up': noPortBeforeUp,
  },
};
