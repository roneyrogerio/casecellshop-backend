// Confere que o package.json só mudou nos blocos de dependências em relação à
// base (AI-05). Os scripts são o que o CI e o hook de parada executam: mudar
// "test" para rodar só os unitários deixaria tudo verde sem rodar a
// integração. As outras chaves também configuram a verificação (prettier,
// knip, jscpd e engines são lidos do package.json). Mudança legítima vem num
// commit ci: ou build: da sessão principal, que é a dona do oráculo. Nos blocos
// de dependências, só versão exata.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEPENDENCY_BLOCKS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

// Com as chaves em ordem: reordenar não muda o que as ferramentas leem.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withoutDependencies(packageJson: string): string {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  for (const key of DEPENDENCY_BLOCKS) delete parsed[key];
  return canonical(parsed);
}

export function packageJsonDiffers(base: string, head: string): boolean {
  return withoutDependencies(base) !== withoutDependencies(head);
}

// Só versão exata: `npm:`, `file:`, `link:`, git, URL, faixa e tag trocariam uma
// ferramenta da verificação sem mudar o nome dela (AI-05).
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function dependencyVersionViolations(packageJson: string): string[] {
  const parsed = JSON.parse(packageJson) as Record<string, unknown>;
  const violations: string[] = [];
  for (const block of DEPENDENCY_BLOCKS) {
    const deps = parsed[block];
    if (deps === null || typeof deps !== 'object') continue;
    for (const [name, version] of Object.entries(deps))
      if (typeof version !== 'string' || !EXACT_VERSION.test(version))
        violations.push(
          `${block}.${name}: "${String(version)}" não é versão exata`,
        );
  }
  return violations;
}

// Um commit pode mudar os scripts se for ci: ou build:, ou se foi feito pela
// sessão principal (trailer Assisted-by: main:), que é a dona do oráculo. Um
// commit do implementer leva o trailer dele e é barrado.
export function mayChangeScripts(message: string): boolean {
  const subject = message.split('\n')[0] ?? '';
  return (
    /^(ci|build)(\(.+\))?!?:/.test(subject) ||
    /^Assisted-by: main:/m.test(message)
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const base = process.env.BASE_REF ?? 'main';
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8' });
  const show = (ref: string) => {
    try {
      return git('show', `${ref}:package.json`);
    } catch {
      return '{}';
    }
  };
  const commits = git(
    'rev-list',
    '--reverse',
    `origin/${base}..HEAD`,
    '--',
    'package.json',
  )
    .split('\n')
    .filter(Boolean);
  const offenders = commits.filter(
    (sha) =>
      packageJsonDiffers(show(`${sha}~1`), show(sha)) &&
      !mayChangeScripts(git('log', '-1', '--format=%B', sha)),
  );
  for (const sha of offenders) {
    console.error(
      `${sha.slice(0, 7)} muda o package.json fora dos blocos de dependências sem ser ci:/build: nem da sessão principal (o oráculo é dela).`,
    );
  }
  const versionViolations = dependencyVersionViolations(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
  );
  for (const violation of versionViolations) console.error(violation);
  process.exitCode =
    offenders.length > 0 || versionViolations.length > 0 ? 1 : 0;
}
