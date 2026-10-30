// Confere que o PR não altera nem apaga migração que já está na base (AI-01).
// O node-pg-migrate não confere o conteúdo do que já rodou, então mudar um .sql
// aplicado divergiria os bancos em silêncio. Só os .sql contam: o .gitkeep de uma
// pasta que ganhou a primeira migração pode sair sem ser violação.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function findMigrationViolations(nameStatus: string): string[] {
  const violations: string[] = [];
  for (const line of nameStatus.split('\n')) {
    const [status, file] = line.split('\t');
    if (!status || !file?.endsWith('.sql') || status === 'A') continue;
    violations.push(`${file} já está na base e foi ${status === 'D' ? 'apagado' : 'alterado'} (${status})`);
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // A base vem do CI pelo ambiente, e não interpolada no comando, para que o nome
  // da branch nunca vire código no shell.
  const base = process.env.BASE_REF ?? 'main';
  const diff = execFileSync('git', ['diff', '--name-status', '--no-renames', `origin/${base}...HEAD`, '--', 'migrations'], {
    encoding: 'utf8',
  });
  const violations = findMigrationViolations(diff);
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
