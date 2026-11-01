import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './repo-root.ts';

// Leitura dos workflows (.github/workflows/) e do dependabot.yml para os testes de test/repo/ que conferem os
// passos do CI e a configuração do GitHub.
export interface CiStep {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

export interface CiJob {
  name?: string;
  needs?: string | string[];
  if?: string;
  environment?: unknown;
  permissions?: unknown;
  'timeout-minutes'?: unknown;
  strategy?: {
    'fail-fast'?: unknown;
    matrix?: { node?: string[] };
  };
  steps?: CiStep[];
}

export interface CiWorkflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: unknown;
  jobs?: Record<string, CiJob>;
}

export const workflowsDir = join(repoRoot, '.github', 'workflows');

export function parseYaml<T>(text: string): T {
  return parse(text) as T;
}

export function parseWorkflow(text: string): CiWorkflow {
  return parseYaml<CiWorkflow>(text);
}

// Devolve `undefined` quando o arquivo ainda não existe, para o teste reprovar por asserção, e não por exceção.
export function readRepoYaml<T>(...segments: string[]): T | undefined {
  const path = join(repoRoot, ...segments);
  return existsSync(path)
    ? parseYaml<T>(readFileSync(path, 'utf8'))
    : undefined;
}

export function readWorkflowFile(name: string): CiWorkflow | undefined {
  return readRepoYaml<CiWorkflow>('.github', 'workflows', name);
}

export function workflowFileNames(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
}

// Controle negativo: o YAML de propósito errado nasce de uma linha de base com uma edição só, e a edição tem de mudar
// o texto, senão o controle passaria no vazio.
export function mutated(base: string, from: string, to: string): string {
  expect(base, `a linha de base não contém: ${from}`).toContain(from);
  return base.replace(from, to);
}

// Toda action fixada por SHA de 40 caracteres; tag, ramo e SHA curto não valem. O comentário `# vX.Y.Z` some no parse.
export function unpinnedUses(steps: CiStep[]): string[] {
  return steps
    .map((step) => step.uses)
    .filter(
      (uses): uses is string =>
        uses !== undefined && !/^[^@\s]+@[0-9a-f]{40}$/.test(uses),
    );
}

// AI-05: no topo só vale `{}`, `read-all` ou permissões `read`; a de escrita fica no job.
export function writeGrants(permissions: unknown): string[] {
  if (typeof permissions === 'string')
    return permissions.includes('write') ? [permissions] : [];
  if (permissions === null || typeof permissions !== 'object') return [];
  return Object.entries(permissions)
    .filter(([, level]) => level === 'write')
    .map(([scope]) => `${scope}: write`);
}

export function topPermissionViolations(workflow: CiWorkflow): string[] {
  const { permissions } = workflow;
  if (permissions === undefined) return ['não declara permissions no topo'];
  if (typeof permissions === 'string' && permissions !== 'read-all')
    return [`permissions: ${permissions} no topo`];
  return writeGrants(permissions).map((grant) => `${grant} no topo`);
}

export function jobOf(workflow: CiWorkflow, id: string): CiJob | undefined {
  return workflow.jobs?.[id];
}

export function stepsOfJob(workflow: CiWorkflow, id: string): CiStep[] {
  return jobOf(workflow, id)?.steps ?? [];
}

export function readCi(): CiWorkflow {
  return parseWorkflow(readFileSync(join(workflowsDir, 'ci.yml'), 'utf8'));
}

export function stepsOfWorkflow(workflow: CiWorkflow): CiStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

// O PR pode redefinir um script do próprio package.json; por isso o CI roda o binário (AI-05).
export function runsBinary(workflow: CiWorkflow, binary: string): CiStep[] {
  const escaped = binary.replace(/[.]/g, '\\.');
  const pattern = new RegExp(
    `(^|\\s)(?:\\./)?node_modules/\\.bin/${escaped}(\\s|$)`,
  );
  return stepsOfWorkflow(workflow).filter((step) =>
    pattern.test(step.run ?? ''),
  );
}

// Os passos do ci.yml que rodam o binário da ferramenta direto (AI-05); nenhum a chama por `npm run`.
export function expectCiRunsBinary(tool: string): CiStep[] {
  const ci = readCi();
  const steps = runsBinary(ci, tool);
  expect(steps.length).toBeGreaterThan(0);
  expect(runsToolThroughNpm(ci, tool)).toHaveLength(0);
  return steps;
}

// O leitor do ci.yml acha o binário (`binaryCall`), recusa o script do package.json (`scriptCall`) e o `npx`, e
// vê o `npm run <ferramenta>` como chamada por npm.
export function expectBinaryReader(
  tool: string,
  binaryCall: string,
  scriptCall: string,
): void {
  expect(runsBinary(workflowOf(binaryCall), tool)).toHaveLength(1);
  expect(runsBinary(workflowOf(scriptCall), tool)).toHaveLength(0);
  expect(runsBinary(workflowOf(`npx ${tool}`), tool)).toHaveLength(0);
  expect(runsToolThroughNpm(workflowOf(`npm run ${tool}`), tool)).toHaveLength(
    1,
  );
}

// Os arquivos de configuração existem na raiz e são JSON válido.
export function expectValidJsonFiles(...names: string[]): void {
  for (const name of names) {
    const file = join(repoRoot, name);

    expect(existsSync(file), name).toBe(true);
    expect(() => {
      JSON.parse(readFileSync(file, 'utf8'));
    }, name).not.toThrow();
  }
}

// Um só script do package.json chama a ferramenta (`<ferramenta> ...`), e o verify e o verify:full rodam esse script.
export function expectToolScriptInVerify(tool: string): {
  name: string;
  body: string;
} {
  const { scripts } = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };
  const entries = Object.entries(scripts).filter(([, body]) =>
    new RegExp(`^${tool}(\\s|$)`).test(body.trim()),
  );

  expect(entries).toHaveLength(1);
  const [name, body] = entries[0] ?? ['', ''];
  for (const script of ['verify', 'verify:full']) {
    const steps = (scripts[script] ?? '')
      .split('&&')
      .map((step) => step.trim());
    expect(steps, script).toContain(`npm run ${name}`);
  }
  return { name, body };
}

// Passos que citam a ferramenta e a chamam por `npm run`.
export function runsToolThroughNpm(
  workflow: CiWorkflow,
  tool: string,
): CiStep[] {
  return stepsOfWorkflow(workflow).filter((step) => {
    const run = step.run ?? '';
    return new RegExp(tool).test(run) && /npm\s+(?:run|exec|x)\b/.test(run);
  });
}

export function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

// `if` de um passo que roda mesmo depois de uma falha, mas não depois do cancelamento (o upload do relatório).
export const NOT_CANCELLED = /^(?:\$\{\{\s*)?!cancelled\(\)(?:\s*\}\})?$/;

// Valor de env ou with como texto; um objeto aninhado vira JSON e nunca casa com o esperado.
export function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function tokensOf(run: string): string[] {
  return run.split(/\s+/);
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const JOB_TOKEN = /^\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}$/;

// AI-43 e AI-46: a zizmor-action fixada por SHA, com a versão do zizmor exata, advanced-security false (o achado
// reprova o job pelo código de saída) e o token de leitura do job para as auditorias que consultam a API.
export function zizmorStepViolations(steps: CiStep[]): string[] {
  const found = steps.filter((step) =>
    (step.uses ?? '').startsWith('zizmorcore/zizmor-action@'),
  );
  const [step] = found;
  if (found.length !== 1 || step === undefined)
    return [`${found.length} passos da zizmor-action, esperado 1`];
  const violations: string[] = [];
  if (!/@[0-9a-f]{40}$/.test(step.uses ?? ''))
    violations.push('a action não está fixada por SHA de 40 caracteres');
  const { version, token } = step.with ?? {};
  if (!SEMVER.test(String(version)))
    violations.push(`version ${String(version)} não é X.Y.Z exato`);
  if (String(step.with?.['advanced-security']) !== 'false')
    violations.push('advanced-security não é false');
  if (!JOB_TOKEN.test(String(token)))
    violations.push('falta o token do job (github.token)');
  return violations;
}

export function workflowOf(run: string): CiWorkflow {
  return parseWorkflow(
    `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
  );
}
