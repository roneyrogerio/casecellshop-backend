// FND-09: os tipos do banco vêm só do kysely-codegen, rodado sobre o banco migrado.
// Stub da fatia 2: a sessão principal escreve o corpo depois dos testes.
import type { MigrationFolder } from '../src/db/migrate.ts';

export interface CheckDbTypesOptions {
  databaseUrl: string;
  folders?: readonly MigrationFolder[];
  // Pasta dos arquivos de tipos; o padrão é src/db/types.
  outDir?: string;
  // Grava os arquivos em vez de conferir.
  write?: boolean;
}

// Devolve as divergências, uma frase por arquivo; vazio quando tudo bate.
export function checkDbTypes(_options: CheckDbTypesOptions): Promise<string[]> {
  return Promise.reject(new Error('não implementado'));
}
