// Confere a origem de cada pacote do package-lock.json (AI-05): toda entrada, fora
// a raiz, fica sob node_modules/, vem do registro oficial do npm, por HTTPS, e traz
// o hash sha512; link e pasta local reprovam.
// Um `resolved` de outro host, de git ou de arquivo trocaria uma ferramenta da
// verificação sem mudar o nome dela, e o `npm audit` não vê isso.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';

interface LockEntry {
  name?: unknown;
  resolved?: unknown;
  integrity?: unknown;
  link?: unknown;
  [block: string]: unknown;
}

const DEPENDENCY_BLOCKS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

// Os apelidos declarados no lockfile: a chave da dependência e os nomes reais
// do "npm:<nome>@<faixa>" (string-width-cjs → string-width). O npm ci instala
// pelo name da entrada mesmo sem a declaração, então o name sozinho deixaria
// quem grava o lockfile trocar o pacote de um nome conhecido (A12 do #27).
function declaredAliases(entries: LockEntry[]): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>();
  for (const entry of entries)
    for (const block of DEPENDENCY_BLOCKS) {
      const deps = entry[block];
      if (deps === null || typeof deps !== 'object') continue;
      for (const [key, spec] of Object.entries(deps)) {
        if (typeof spec !== 'string' || !spec.startsWith('npm:')) continue;
        const target = spec.slice('npm:'.length);
        // O @ da versão vem depois do nome; o do escopo é o primeiro caractere.
        const at = target.lastIndexOf('@');
        const real = at > 0 ? target.slice(0, at) : target;
        aliases.set(key, (aliases.get(key) ?? new Set()).add(real));
      }
    }
  return aliases;
}

// O nome do pacote pela chave: o que vem depois do último node_modules/, com o
// escopo quando houver (node_modules/a/node_modules/@s/b é @s/b).
function packageName(key: string): string {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

// O resolved do registro aponta o tarball do próprio pacote: o caminho é o que o
// new URL devolve, sem .., ./, escape de ponto nem barra dupla, e começa por
// /<nome>/-/. Senão um nome conhecido traria o tarball de outro pacote do
// registro (A12 do #26).
function tarballProblem(resolved: string, name: string): string | undefined {
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return 'resolved não é uma URL';
  }
  if (url.href !== resolved || url.pathname.includes('//'))
    return 'resolved fora da forma normalizada';
  if (!url.pathname.startsWith(`/${name}/-/`))
    return `resolved não é um tarball de ${name}`;
  return undefined;
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
  const aliases = declaredAliases(
    Object.values(lock.packages).map((raw) => (raw ?? {}) as LockEntry),
  );
  for (const [name, raw] of Object.entries(lock.packages)) {
    const entry = (raw ?? {}) as LockEntry;
    // Só a raiz ("") não é pacote baixado. O projeto não usa workspaces: um link
    // ou uma pasta fora de node_modules/ trocaria um pacote por código local com
    // o mesmo nome, e o npm instala também o node_modules/ aninhado numa pasta.
    if (name === '') continue;
    // O npm trata como link qualquer valor verdadeiro, e não só o true (A11 do #26).
    if (entry.link) {
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
    else {
      // Um apelido de dependência (string-width-cjs instalado como string-width)
      // traz o nome real no campo name da entrada, como o npm grava; ele só
      // vale quando alguma entrada declara o apelido.
      const key = packageName(name);
      const real =
        typeof entry.name === 'string' && aliases.get(key)?.has(entry.name)
          ? entry.name
          : key;
      const problem = tarballProblem(resolved, real);
      if (problem) reasons.push(`${problem} (${resolved})`);
    }
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
