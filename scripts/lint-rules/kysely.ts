// AI-19: regras de lint das formas do Kysely que deixam o tsc sem enxergar uma
// coluna, ou que montam SQL fora do builder (AD-017). Formato de plugin do ESLint,
// carregado pelo jsPlugins do .oxlintrc.json.

// Esqueleto: as regras existem e ainda não acusam nada, para os testes falharem
// pela asserção, e não pelo carregamento.
const placeholder = {
  create() {
    return {};
  },
};

export function readGeneratedColumns(_typesDir: string): Set<string> {
  throw new Error('não implementado');
}

export default {
  meta: { name: 'kysely' },
  rules: {
    'no-callback-values': placeholder,
    'no-sql-alias': placeholder,
    'no-sql-command': placeholder,
    'no-sql-column': placeholder,
    'no-direct-query': placeholder,
  },
};
