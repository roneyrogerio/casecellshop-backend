// Conventional Commits pelo padrão da comunidade (@commitlint/config-conventional),
// sem regras próprias: o tipo em inglês, a descrição começando em minúscula e sem
// ponto final, o cabeçalho até 100 caracteres. O tipo é o que permite conferir no
// CI que um commit test: só mexe em testes e um feat: não mexe neles.
export default {
  extends: ['@commitlint/config-conventional'],
};
