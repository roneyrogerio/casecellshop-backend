// AI-19: reprova em src/ as formas do Kysely que deixam o tsc sem enxergar uma
// coluna, ou que montam SQL fora do builder. Stub da fatia 3: a sessão principal
// escreve o corpo depois dos testes.

export interface SourceFile {
  // Caminho relativo à raiz do repositório, como src/erp/sim/index.ts.
  path: string;
  content: string;
}

// As colunas de todas as tabelas dos arquivos gerados em typesDir (FND-09).
export function readGeneratedColumns(_typesDir: string): Set<string> {
  throw new Error('não implementado');
}

// Uma frase por ocorrência, com arquivo e linha; vazio quando não há violação.
export function findKyselyViolations(_files: readonly SourceFile[], _columns: ReadonlySet<string>): string[] {
  throw new Error('não implementado');
}
