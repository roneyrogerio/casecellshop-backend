// AI-18: tabela critério × teste para o resumo do CI. Esboço: as funções ainda
// não fazem nada, para os testes falharem pela asserção.

export type VitestReport = {
  testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
};

// IDs dos critérios do spec.md, na ordem em que aparecem (itens `- **ID**`).
export function criteriaIds(_specText: string): string[] {
  throw new Error('não implementado');
}

// O ID que abre o nome do teste, ou null quando o nome não começa por um ID.
export function testIdOf(_title: string): string | null {
  throw new Error('não implementado');
}

// A tabela em Markdown, com a lista à parte dos IDs que não estão no spec.md.
export function buildReport(_specText: string, _report: VitestReport): string {
  throw new Error('não implementado');
}
