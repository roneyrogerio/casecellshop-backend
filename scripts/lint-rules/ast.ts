// Tipos e leitura mínima da árvore, comuns às regras locais de lint.
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
