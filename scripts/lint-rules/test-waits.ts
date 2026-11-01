// FND-13: regras de lint das esperas e das portas dos testes de integração. Formato
// de plugin do ESLint, carregado pelo jsPlugins do .oxlintrc.json só para
// test/integration/ e test/helpers/. A leitura é pela árvore de sintaxe, como no
// plugin do Kysely: comentário e string não contam, e o prazo é lido como
// expressão (A3 da Revisão 1 do PR C).
import type { RuleTester } from 'oxlint/plugins-dev';

type Rule = Parameters<RuleTester['run']>[1];
type Context = Parameters<Extract<Rule, { create: unknown }>['create']>[0];
type Visitor = ReturnType<Extract<Rule, { create: unknown }>['create']>;

// Esqueleto: as regras ainda não reprovam nada; os testes do test-writer vêm antes.
const pending = {
  meta: { type: 'problem' as const },
  create(_context: Context): Visitor {
    return {};
  },
};

export default {
  meta: { name: 'test-waits' },
  rules: {
    'no-fixed-step': pending,
    'wait-guard': pending,
    'no-port-before-up': pending,
  },
};
