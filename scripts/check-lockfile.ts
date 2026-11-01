// Confere a origem de cada pacote do package-lock.json (AI-05): todo pacote com
// `resolved` vem do registro oficial do npm, por HTTPS, e traz o hash sha512.
// Um `resolved` de outro host, de git ou de arquivo trocaria uma ferramenta da
// verificação sem mudar o nome dela, e o `npm audit` não vê isso.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';

interface LockEntry {
  resolved?: unknown;
  integrity?: unknown;
}

export function lockfileViolations(lockText: string): string[] {
  const lock = JSON.parse(lockText) as {
    packages?: Record<string, LockEntry>;
  };
  const violations: string[] = [];
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    // A raiz ("") e um link de workspace não têm pacote baixado.
    if (entry.resolved === undefined) continue;
    const resolved =
      typeof entry.resolved === 'string'
        ? entry.resolved
        : JSON.stringify(entry.resolved);
    if (!resolved.startsWith(REGISTRY))
      violations.push(`${name}: resolved fora de ${REGISTRY} (${resolved})`);
    if (
      typeof entry.integrity !== 'string' ||
      !entry.integrity.startsWith('sha512-')
    )
      violations.push(`${name}: integrity ausente ou não é sha512`);
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const violations = lockfileViolations(
    readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'),
  );
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
