// Confere que o bloco "scripts" do package.json não mudou em relação à base
// (AI-05). Os scripts são o que o CI e o hook de parada executam: mudar
// "test" para rodar só os unitários deixaria tudo verde sem rodar a
// integração. Mudança legítima nos scripts vem num commit ci: ou build: da
// sessão principal, que é a dona do oráculo.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function scriptsOf(packageJson: string): Record<string, string> {
  const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

export function scriptsDiffer(base: string, head: string): boolean {
  const a = scriptsOf(base);
  const b = scriptsOf(head);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].some((key) => a[key] !== b[key]);
}

// Um commit pode mudar os scripts se for ci: ou build:, ou se foi feito pela
// sessão principal (trailer Assisted-by: main:), que é a dona do oráculo. Um
// commit do implementer leva o trailer dele e é barrado.
export function mayChangeScripts(message: string): boolean {
  const subject = message.split('\n')[0] ?? '';
  return /^(ci|build)(\(.+\))?!?:/.test(subject) || /^Assisted-by: main:/m.test(message);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const base = process.env.BASE_REF ?? 'main';
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' });
  const show = (ref: string) => {
    try {
      return git('show', `${ref}:package.json`);
    } catch {
      return '{}';
    }
  };
  const commits = git('rev-list', '--reverse', `origin/${base}..HEAD`, '--', 'package.json').split('\n').filter(Boolean);
  const offenders = commits.filter(
    (sha) => scriptsDiffer(show(`${sha}~1`), show(sha)) && !mayChangeScripts(git('log', '-1', '--format=%B', sha)),
  );
  for (const sha of offenders) {
    console.error(`${sha.slice(0, 7)} muda o bloco "scripts" do package.json sem ser ci:/build: nem da sessão principal (o oráculo é dela).`);
  }
  process.exitCode = offenders.length > 0 ? 1 : 0;
}
