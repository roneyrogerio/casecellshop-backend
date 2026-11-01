// Tipos e leitura mínima da árvore, comuns às regras locais de lint
// (kysely.ts, test-waits.ts e test-imports.ts).
import type { RuleTester } from 'oxlint/plugins-dev';

// O oxlint não exporta os tipos de regra; vêm do RuleTester, que os recebe.
type Rule = Parameters<RuleTester['run']>[1];
export type Context = Parameters<
  Extract<Rule, { create: unknown }>['create']
>[0];
export type Visitor = ReturnType<Extract<Rule, { create: unknown }>['create']>;

// Só os campos que as regras leem; a árvore é a ESTree do oxlint.
export interface Node {
  type: string;
  range: [number, number];
  parent?: Node;
  [key: string]: unknown;
}

type Handlers = Record<string, (node: Node) => void>;

// Os visitantes leem a árvore pela forma mínima acima; a conversão fica só aqui.
export const visit = (handlers: Handlers): Visitor =>
  handlers as unknown as Visitor;

export const child = (node: Node | undefined, key: string): Node | undefined =>
  node?.[key] as Node | undefined;

export const nameOf = (node: Node | undefined): string | undefined =>
  node?.type === 'Identifier' ? (node['name'] as string) : undefined;

// O texto da origem de um import('…'), em string ou em template sem valor; um
// nome calculado (import(nome)) não tem texto fixo e devolve undefined.
export function importSource(node: Node): unknown {
  const source = child(node, 'source');
  if (source?.type === 'Literal') return source['value'];
  const quasis = (source?.['quasis'] ?? []) as Node[];
  const [only] = quasis;
  return source?.type === 'TemplateLiteral' && quasis.length === 1 && only
    ? (only['value'] as { cooked?: string }).cooked
    : undefined;
}
