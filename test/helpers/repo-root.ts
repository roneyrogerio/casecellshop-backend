// Raiz do repositório, sem a barra final, para os testes montarem caminhos a partir dela.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(
  new URL('../..', import.meta.url),
).replace(/\/$/, '');

// Binário de uma ferramenta instalada no projeto (node_modules/.bin/<nome>).
export function repoBin(name: string): string {
  return join(repoRoot, 'node_modules', '.bin', name);
}
