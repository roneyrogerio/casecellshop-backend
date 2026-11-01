// Raiz do repositório, sem a barra final, para os testes de `test/repo/` montarem caminhos a partir dela.
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(
  new URL('../..', import.meta.url),
).replace(/\/$/, '');
