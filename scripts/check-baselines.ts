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

const ENTRY = /^(lines|functions|branches|statements)\s*:\s*(\d+(?:\.\d+)?)$/;

interface Floor {
  values: Map<string, number>;
  // Por que o piso está fora da forma fixa; ausente quando está nela.
  problem?: string;
}

// O piso tem forma fixa (AI-49): thresholds citado uma vez só, num objeto de uma
// linha com exatamente as quatro chaves e um número literal em cada. Ler outra
// forma por expressão regular deixaria um bloco de glob, um ...spread ou um
// comentário com thresholds: esconder um piso menor (A4 do #26); por isso
// qualquer outra forma reprova, e o arquivo sem thresholds não tem piso.
function floorOf(config: string): Floor {
  const values = new Map<string, number>();
  // Uma chave computada (['thresh' + 'olds']: …) poria o piso de verdade fora
  // do texto, com uma isca num comentário no lugar (A15 do #27).
  if (/\]\s*:/.test(config))
    return { values, problem: 'chave computada no arquivo' };
  const mentions = config.match(/\bthresholds\b/g)?.length ?? 0;
  if (mentions === 0) return { values };
  if (mentions > 1)
    return { values, problem: `thresholds aparece ${mentions} vezes` };
  const coverage = coverageBlock(config);
  if (typeof coverage === 'string') return { values, problem: coverage };
  const at = config.search(/\bthresholds\b/);
  if (at < coverage.start || at >= coverage.end)
    return { values, problem: 'thresholds fora do bloco coverage' };
  // Um spread no bloco poderia trazer outro thresholds por cima do literal.
  if (config.slice(coverage.start, coverage.end).includes('...'))
    return { values, problem: '... no bloco coverage' };
  const block = /\bthresholds\s*:\s*\{([^{}\n]*)\}/.exec(config)?.[1];
  if (block === undefined)
    return { values, problem: 'thresholds não é um objeto de uma linha' };
  const entries = block
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const [, key, value] = ENTRY.exec(entry) ?? [];
    if (!key || !value || values.has(key))
      return { values, problem: `entrada fora da forma fixa: ${entry}` };
    values.set(key, Number(value));
  }
  const missing = METRICS.filter((metric) => !values.has(metric));
  if (missing.length > 0)
    return { values, problem: `piso de ${missing.join(', ')} removido` };
  return { values };
}

// O trecho entre as chaves do bloco coverage:, que aparece uma vez só, ou o
// motivo de não haver um. As chaves de um glob ('*.{ts,js}') se equilibram.
function coverageBlock(
  config: string,
): { start: number; end: number } | string {
  const keys = [...config.matchAll(/\bcoverage\s*:\s*/g)];
  if (keys.length !== 1) return `o bloco coverage aparece ${keys.length} vezes`;
  const [key] = keys;
  const start = (key?.index ?? 0) + (key?.[0].length ?? 0);
  if (config[start] !== '{') return 'coverage não é um objeto literal';
  let depth = 0;
  for (let index = start; index < config.length; index += 1) {
    if (config[index] === '{') depth += 1;
    else if (config[index] === '}') depth -= 1;
    if (depth === 0) return { start, end: index + 1 };
  }
  return 'o bloco coverage não fecha';
}

export function coverageFloorViolations(
  baseConfig: string,
  headConfig: string,
): string[] {
  const baseFloor = floorOf(baseConfig);
  const headFloor = floorOf(headConfig);
  const violations: string[] = [];
  if (baseFloor.problem)
    violations.push(`piso da base fora da forma fixa: ${baseFloor.problem}`);
  if (headFloor.problem)
    violations.push(`piso do PR fora da forma fixa: ${headFloor.problem}`);
  if (violations.length > 0) return violations;
  const base = baseFloor.values;
  const head = headFloor.values;
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
