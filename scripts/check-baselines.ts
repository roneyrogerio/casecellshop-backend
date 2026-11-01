// Confere, contra a base do PR, que o piso de cobertura só sobe (AI-37) e que a
// linha de base do jscpd só perde repetições (AI-36), pelo AI-49. A guarda de
// caminho já nega os dois arquivos aos agentes; este passo pega também um commit
// da sessão principal que os afrouxe, como o --update-baseline que absorve em
// silêncio uma repetição nova.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const METRICS = ['lines', 'functions', 'branches', 'statements'] as const;

function thresholdsOf(config: string): Map<string, number> {
  const block = /thresholds\s*:\s*\{([^}]*)\}/.exec(config)?.[1] ?? '';
  const values = new Map<string, number>();
  for (const [, key, value] of block.matchAll(/(\w+)\s*:\s*(\d+(?:\.\d+)?)/g))
    if (key && value) values.set(key, Number(value));
  return values;
}

export function coverageFloorViolations(
  baseConfig: string,
  headConfig: string,
): string[] {
  const base = thresholdsOf(baseConfig);
  const head = thresholdsOf(headConfig);
  const violations: string[] = [];
  for (const metric of METRICS) {
    const before = base.get(metric);
    if (before === undefined) continue;
    const after = head.get(metric);
    if (after === undefined)
      violations.push(`piso de ${metric} removido (era ${before})`);
    else if (after < before)
      violations.push(`piso de ${metric} caiu de ${before} para ${after}`);
  }
  return violations;
}

function fingerprintsOf(json: string): Record<string, number> {
  // Sem arquivo no PR, não há repetição listada.
  if (json.trim() === '') return {};
  return (
    (JSON.parse(json) as { fingerprints?: Record<string, number> })
      .fingerprints ?? {}
  );
}

// Uma impressão nova, ou a mesma repetição com mais ocorrências, é repetição
// que não estava na base.
export function baselineViolations(
  baseJson: string,
  headJson: string,
): string[] {
  const base = fingerprintsOf(baseJson);
  const violations: string[] = [];
  for (const [fingerprint, count] of Object.entries(fingerprintsOf(headJson))) {
    const before = base[fingerprint];
    if (before === undefined)
      violations.push(`repetição ${fingerprint} não estava na linha de base`);
    else if (count > before)
      violations.push(
        `repetição ${fingerprint} passou de ${before} para ${count} na linha de base`,
      );
  }
  return violations;
}

function fromBase(ref: string, file: string): string | undefined {
  try {
    return execFileSync('git', ['show', `origin/${ref}:${file}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    // Primeiro PR com o arquivo: não há base para comparar.
    return undefined;
  }
}

function fromHead(file: string): string | undefined {
  const path = join(process.cwd(), file);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function refExists(ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `origin/${ref}`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ref = process.env.BASE_REF ?? 'main';
  // Sem a ref, não há com o que comparar; passar seria aprovar sem conferir. Só
  // a falta do arquivo na base (o PR que o cria) passa.
  if (!refExists(ref)) {
    console.error(`a ref origin/${ref} não existe; não há base para comparar`);
    process.exit(1);
  }
  const violations: string[] = [];
  const checks: [string, (base: string, head: string) => string[]][] = [
    ['vitest.config.ts', coverageFloorViolations],
    ['.jscpd-baseline.json', baselineViolations],
  ];
  for (const [file, check] of checks) {
    const base = fromBase(ref, file);
    if (base === undefined) continue;
    violations.push(...check(base, fromHead(file) ?? ''));
  }
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
