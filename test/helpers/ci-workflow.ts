import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// Leitura do .github/workflows/ci.yml para os testes de test/repo/ que conferem os passos do CI.
export interface CiStep {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  'continue-on-error'?: unknown;
  with?: Record<string, unknown>;
}

export interface CiWorkflow {
  jobs?: Record<string, { steps?: CiStep[] }>;
}

export const repoRoot = join(import.meta.dirname, '..', '..');

function parseWorkflow(text: string): CiWorkflow {
  return parse(text) as CiWorkflow;
}

export function readCi(): CiWorkflow {
  return parseWorkflow(
    readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8'),
  );
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

export function workflowOf(run: string): CiWorkflow {
  return parseWorkflow(
    `jobs:\n  a:\n    steps:\n      - run: ${JSON.stringify(run)}\n`,
  );
}
