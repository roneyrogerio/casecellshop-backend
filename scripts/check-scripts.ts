// Confere que o package.json só mudou nos blocos de dependências em relação à
// base (AI-05). Os scripts são o que o CI e o hook de parada executam: mudar
// "test" para rodar só os unitários deixaria tudo verde sem rodar a
// integração. As outras chaves também configuram a verificação (prettier,
// knip, jscpd e engines são lidos do package.json). Mudança legítima vem num
// commit ci: ou build: da sessão principal, que é a dona do oráculo.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function scriptsOf(packageJson: string): Record<string, string> {
  const parsed = JSON.parse(packageJson) as {
    scripts?: Record<string, string>;
  };
  return parsed.scripts ?? {};
}

export function scriptsDiffer(base: string, head: string): boolean {
  const a = scriptsOf(base);
  const b = scriptsOf(head);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].some((key) => a[key] !== b[key]);
}

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
  process.exitCode = offenders.length > 0 ? 1 : 0;
}
