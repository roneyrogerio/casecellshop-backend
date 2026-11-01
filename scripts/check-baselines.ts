// Confere, contra a base do PR, que o piso de cobertura só sobe (AI-37) e que a
// linha de base do jscpd só perde repetições (AI-36), pelo AI-49. A guarda de
// caminho já nega os dois arquivos aos agentes; este passo pega também um commit
// da sessão principal que os afrouxe, como o --update-baseline que absorve em
// silêncio uma repetição nova.
//
// Dois modos: sem argumento, compara os arquivos do PR com os da base (job
// checks); com --measured <relatório>, compara a cobertura medida pelo Vitest
// com o piso da base (job test), o que vale qualquer que seja o config ou a
// linha de comando que rodou a medição.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

const FLOOR_FILE = 'coverage-floor.json';
const METRICS = ['lines', 'functions', 'branches', 'statements'] as const;

// O piso é um dado, lido por um esquema fechado: uma chave a mais que o Vitest
// aceitaria (perFile, autoUpdate, um glob) mudaria o que o thresholds confere, e
// no Vitest um piso negativo é o máximo de itens sem cobertura, e não uma
// porcentagem.
const percent = z.number().gt(0).lte(100);
const floorSchema = z.strictObject({
  lines: percent,
  functions: percent,
  branches: percent,
  statements: percent,
});
type Floor = z.infer<typeof floorSchema>;

// O json-summary do Vitest traz o total e um item por arquivo; só o total conta.
// O pct vira "Unknown" quando não há item medido, e aí não há o que comparar.
const measured = z.object({ pct: z.number() });
const summarySchema = z.object({
  total: z.object({
    lines: measured,
    functions: measured,
    branches: measured,
    statements: measured,
  }),
});

function parseJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { data: T } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'JSON inválido' };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { data: result.data }
    : { problem: z.prettifyError(result.error) };
}

// O piso lido, ou a violação que o impede de ser lido.
function floorOf(side: 'da base' | 'do PR', text: string): Floor | string {
  const parsed = parseJson(text, floorSchema);
  return 'data' in parsed
    ? parsed.data
    : `${FLOOR_FILE} ${side} fora do esquema: ${parsed.problem}`;
}

// Sem o arquivo no PR (texto vazio), o Vitest ficaria sem piso.
export function coverageFloorViolations(
  baseJson: string,
  headJson: string,
): string[] {
  if (headJson.trim() === '') return [`${FLOOR_FILE} removido do PR`];
  const base = floorOf('da base', baseJson);
  const head = floorOf('do PR', headJson);
  if (typeof base === 'string' || typeof head === 'string')
    return [base, head].filter((side) => typeof side === 'string');
  return METRICS.filter((metric) => head[metric] < base[metric]).map(
    (metric) =>
      `piso de ${metric} caiu de ${String(base[metric])} para ${String(head[metric])}`,
  );
}

// A mesma régua do Vitest (reprova só pct < piso), com o piso da base. Sem o
// relatório (texto vazio), não há medida, e passar seria aprovar sem conferir.
export function measuredCoverageViolations(
  baseFloorJson: string,
  summaryJson: string,
): string[] {
  const floor = floorOf('da base', baseFloorJson);
  if (typeof floor === 'string') return [floor];
  if (summaryJson.trim() === '') return ['relatório de cobertura ausente'];
  const summary = parseJson(summaryJson, summarySchema);
  if ('problem' in summary)
    return [`relatório de cobertura fora do formato: ${summary.problem}`];
  const { total } = summary.data;
  return METRICS.filter((metric) => total[metric].pct < floor[metric]).map(
    (metric) =>
      `cobertura de ${metric} medida em ${String(total[metric].pct)}%, abaixo do piso da base (${String(floor[metric])})`,
  );
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

function fromDisk(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

function diffViolations(ref: string): string[] {
  const violations: string[] = [];
  const checks: [string, (base: string, head: string) => string[]][] = [
    [FLOOR_FILE, coverageFloorViolations],
    ['.jscpd-baseline.json', baselineViolations],
  ];
  for (const [file, check] of checks) {
    const base = fromBase(ref, file);
    if (base === undefined) continue;
    violations.push(...check(base, fromDisk(join(process.cwd(), file))));
  }
  return violations;
}

function main(argv: string[]): number {
  let measuredReport: string | undefined;
  try {
    const { values } = parseArgs({
      args: argv,
      options: { measured: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    measuredReport = values.measured;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const ref = process.env.BASE_REF ?? 'main';
  // Sem a ref, não há com o que comparar; passar seria aprovar sem conferir. Só
  // a falta do arquivo na base (o PR que o cria) passa.
  if (!refExists(ref)) {
    console.error(`a ref origin/${ref} não existe; não há base para comparar`);
    return 1;
  }
  let violations: string[];
  if (measuredReport === undefined) violations = diffViolations(ref);
  else {
    const baseFloor = fromBase(ref, FLOOR_FILE);
    if (baseFloor === undefined) {
      console.log(`${FLOOR_FILE} não existe na base; nada a comparar`);
      return 0;
    }
    violations = measuredCoverageViolations(
      baseFloor,
      fromDisk(measuredReport),
    );
  }
  for (const violation of violations) console.error(violation);
  return violations.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  process.exitCode = main(process.argv.slice(2));
