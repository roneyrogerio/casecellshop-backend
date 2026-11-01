// Conventional Commits pelo padrão da comunidade (@commitlint/config-conventional),
// sem regras próprias: o tipo em inglês, a descrição começando em minúscula e sem
// ponto final, o cabeçalho até 100 caracteres. O tipo é o que permite conferir no
// CI que um commit test: só mexe em testes e um feat: não mexe neles.
//
// AI-45: os commits do Dependabot ficam de fora. Ele escreve o corpo com as notas
// de versão em linhas longas e não segue a regra de idioma; o PR dele passa pelo
// mesmo CI e pela aprovação do dono.
const DEPENDABOT_SIGNOFF =
  /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m;

export default {
  extends: ['@commitlint/config-conventional'],
  ignores: [(message) => DEPENDABOT_SIGNOFF.test(message)],
};
