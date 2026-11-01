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
  link?: unknown;
}

export function lockfileViolations(lockText: string): string[] {
  const lock = JSON.parse(lockText) as {
    lockfileVersion?: unknown;
    packages?: unknown;
  };
  // Sem `packages` (o formato 1, ou um arquivo vazio), não há o que conferir, e
  // aprovar seria deixar passar qualquer origem.
  if (typeof lock.lockfileVersion !== 'number' || lock.lockfileVersion < 2)
    return [
      `lockfileVersion ${String(lock.lockfileVersion)}: precisa ser 2 ou mais`,
    ];
  if (
    lock.packages === null ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  )
    return ['packages ausente ou não é um objeto'];
  const violations: string[] = [];
  for (const [name, raw] of Object.entries(lock.packages)) {
    const entry = (raw ?? {}) as LockEntry;
    // Só a raiz ("") não é pacote baixado. O projeto não usa workspaces: um link
    // ou uma pasta fora de node_modules/ trocaria um pacote por código local com
    // o mesmo nome, e o npm instala também o node_modules/ aninhado numa pasta.
    if (name === '') continue;
    if (entry.link === true) {
      violations.push(`${name}: link para código local, sem workspaces`);
      continue;
    }
    if (!/(^|\/)node_modules\//.test(name)) {
      violations.push(`${name}: pasta fora de node_modules/, sem workspaces`);
      continue;
    }
    const resolved =
      typeof entry.resolved === 'string'
        ? entry.resolved
        : (JSON.stringify(entry.resolved) ?? 'ausente');
    // Uma linha por pacote, com todos os motivos.
    const reasons: string[] = [];
    if (!resolved.startsWith(REGISTRY))
      reasons.push(`resolved fora de ${REGISTRY} (${resolved})`);
    if (
      typeof entry.integrity !== 'string' ||
      !entry.integrity.startsWith('sha512-')
    )
      reasons.push('integrity ausente ou não é sha512');
    if (reasons.length > 0) violations.push(`${name}: ${reasons.join('; ')}`);
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
