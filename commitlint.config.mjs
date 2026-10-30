// Regras do formato de commit (skill /marco, "Commits"). A descrição começa em
// minúscula, mas pode ter nomes próprios depois (Jaeger, TypeScript), então o
// 'subject-case' veta só as caixas que começam em maiúscula, em vez de exigir tudo
// em minúscula. O CI confere só os commits do PR, então não há exceções de
// histórico: os três cabeçalhos antigos que passavam do limite já estão na main.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'test', 'refactor', 'docs', 'build', 'ci', 'chore']],
    'header-max-length': [2, 'always', 72],
    'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],
  },
};
