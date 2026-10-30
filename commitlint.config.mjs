// Regras do CONVENTIONS.md, "Commits". A descrição começa em minúscula, mas pode
// ter nomes próprios depois (Jaeger, TypeScript), então o 'subject-case' veta só
// as caixas que começam em maiúscula, em vez de exigir tudo em minúscula.

// Cabeçalhos já publicados no PR #2, antes de o commitlint existir, que passam
// do limite. Reescrever o histórico exigiria push forçado, decisão do mantenedor;
// por isso ficam fora da conferência, um a um e pelo cabeçalho inteiro, para
// nenhum commit novo escapar.
const LEGACY_HEADERS = new Map([
  // 83 caracteres (header-max-length); também não começa por verbo no presente.
  ['bb4e6a0', 'docs(specs): exportador de traces desligado por padrão e as decisões do implementer'],
  // 74 caracteres (header-max-length).
  ['3cf3452', 'docs(specs): propõe o contrato em zod e as versões atuais (AD-010, AD-011)'],
  // 73 caracteres (header-max-length).
  ['838aadb', 'docs(architecture): rascunha o diagnóstico e a arquitetura alvo (DOC-DIA)'],
]);

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => [...LEGACY_HEADERS.values()].includes(message.split('\n')[0])],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'test', 'refactor', 'docs', 'build', 'ci', 'chore']],
    'header-max-length': [2, 'always', 72],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],
  },
};
