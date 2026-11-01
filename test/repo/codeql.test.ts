import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutated,
  parseWorkflow,
  readWorkflowFile,
  stepsOfWorkflow,
  topPermissionViolations,
  unpinnedUses,
  workflowsDir,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';

// AI-44: o codeql.yml roda o CodeQL em configuração avançada, só com javascript-typescript, em todo PR para a main,
// em push na main e uma vez por semana. Só o job dele escreve `security-events` e nenhum script do PR roda ali.
// Cada conferência devolve as violações; a lista vazia é o que o arquivo deve ter.

const SHA = 'c'.repeat(40);

interface Trigger {
  branches?: string[];
}

interface Schedule {
  cron?: string;
}

function triggersOf(workflow: CiWorkflow): Record<string, unknown> {
  return workflow.on ?? {};
}

// Cron semanal: minuto e hora fixos, qualquer dia do mês e mês, e um dia da semana só.
const WEEKLY_CRON = /^\d{1,2} \d{1,2} \* \* (?:[0-7]|[A-Za-z]{3})$/;

function triggerViolations(workflow: CiWorkflow): string[] {
  const triggers = triggersOf(workflow);
  const violations: string[] = [];
  for (const name of ['pull_request', 'push'])
    if (
      JSON.stringify((triggers[name] as Trigger | undefined)?.branches) !==
      JSON.stringify(['main'])
    )
      violations.push(`${name}: branches não é [main]`);
  const schedule = triggers.schedule as Schedule[] | undefined;
  if (!Array.isArray(schedule) || schedule.length !== 1)
    violations.push('schedule não tem exatamente um cron');
  else if (!WEEKLY_CRON.test(schedule[0]?.cron ?? ''))
    violations.push(`cron ${String(schedule[0]?.cron)} não é semanal`);
  if ('pull_request_target' in triggers)
    violations.push('usa pull_request_target');
  return violations;
}

function analyzeOf(workflow: CiWorkflow) {
  return workflow.jobs?.analyze;
}

// A permissão de escrita fica só no job: o topo só lê (AI-05).
function permissionViolations(workflow: CiWorkflow): string[] {
  const violations = topPermissionViolations(workflow);
  if (Object.keys(workflow.jobs ?? {}).join() !== 'analyze')
    violations.push('o arquivo não tem só o job analyze');
  const permissions = analyzeOf(workflow)?.permissions as
    Record<string, string> | undefined;
  if (permissions?.['security-events'] !== 'write')
    violations.push('o job analyze não tem security-events: write');
  if (permissions?.contents !== 'read')
    violations.push('o job analyze não tem contents: read');
  const other = Object.entries(permissions ?? {}).filter(
    ([scope, level]) => level === 'write' && scope !== 'security-events',
  );
  if (other.length > 0)
    violations.push(`escrita demais: ${other.map(([s]) => s).join(', ')}`);
  return violations;
}

const INIT = /^github\/codeql-action\/init@/;
const ANALYZE = /^github\/codeql-action\/analyze@/;

function stepViolations(workflow: CiWorkflow): string[] {
  const steps = stepsOfWorkflow(workflow);
  const violations = unpinnedUses(steps).map((uses) => `sem SHA: ${uses}`);
  if (steps.some((step) => step.run !== undefined))
    violations.push('tem um passo run: (nenhum script do PR roda aqui)');
  const init = steps.filter((step) => INIT.test(step.uses ?? ''));
  if (init.length !== 1) violations.push('não tem um único passo de init');
  if (!steps.some((step) => ANALYZE.test(step.uses ?? '')))
    violations.push('não tem o passo de analyze');
  // Uma linguagem só: a `actions` do CodeQL repetiria o zizmor (AI-43).
  if (init[0]?.with?.languages !== 'javascript-typescript')
    violations.push(`languages é ${String(init[0]?.with?.languages)}`);
  if (init[0]?.with?.['build-mode'] !== 'none')
    violations.push('build-mode não é none');
  return violations;
}

// --- linha de base em memória -----------------------------------------------------------------------------------

const GOOD = `
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  schedule:
    - cron: '17 4 * * 1'
permissions:
  contents: read
jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - uses: github/codeql-action/init@${SHA} # v4.0.0
        with:
          languages: javascript-typescript
          build-mode: none
      - uses: github/codeql-action/analyze@${SHA} # v4.0.0
`;

function edited(from: string, to: string): CiWorkflow {
  return parseWorkflow(mutated(GOOD, from, to));
}

const ALL_CHECKS = (workflow: CiWorkflow): string[] => [
  ...triggerViolations(workflow),
  ...permissionViolations(workflow),
  ...stepViolations(workflow),
];

describe('AI-44 as conferências do codeql.yml enxergam o que procuram (controle negativo)', () => {
  it('AI-44 o workflow correto passa em todas as conferências (controle positivo)', () => {
    expect(ALL_CHECKS(parseWorkflow(GOOD))).toEqual([]);
  });

  it.each([
    [
      'sem o gatilho de pull_request',
      '  pull_request:\n    branches: [main]\n',
    ],
    ['sem o push na main', '  push:\n    branches: [main]\n'],
    ['sem o schedule', "  schedule:\n    - cron: '17 4 * * 1'\n"],
  ])('AI-44 o workflow %s reprova nos gatilhos', (_label, removed) => {
    expect(triggerViolations(edited(removed, ''))).not.toEqual([]);
  });

  it.each([
    [
      'push em outro ramo',
      '  push:\n    branches: [main]',
      '  push:\n    branches: [develop]',
    ],
    ['cron diário', "'17 4 * * 1'", "'17 4 * * *'"],
    [
      'dois crons',
      "    - cron: '17 4 * * 1'",
      "    - cron: '17 4 * * 1'\n    - cron: '17 5 * * 3'",
    ],
    ['pull_request_target', '  pull_request:', '  pull_request_target:'],
  ])('AI-44 %s reprova nos gatilhos', (_label, from, to) => {
    expect(triggerViolations(edited(from, to))).not.toEqual([]);
  });

  it.each([
    [
      'security-events: write no topo',
      'permissions:\n  contents: read\njobs',
      'permissions:\n  contents: read\n  security-events: write\njobs',
    ],
    [
      'write-all no topo',
      'permissions:\n  contents: read\njobs',
      'permissions: write-all\njobs',
    ],
    ['sem permissions no topo', 'permissions:\n  contents: read\njobs', 'jobs'],
    [
      'o job sem security-events: write',
      'security-events: write',
      'security-events: read',
    ],
    [
      'o job com contents: write',
      '      contents: read\n      security',
      '      contents: write\n      security',
    ],
  ])('AI-44 %s reprova nas permissões', (_label, from, to) => {
    expect(permissionViolations(edited(from, to))).not.toEqual([]);
  });

  it.each([
    [
      'a linguagem actions junto',
      'languages: javascript-typescript',
      'languages: javascript-typescript,actions',
    ],
    [
      'só a linguagem actions',
      'languages: javascript-typescript',
      'languages: actions',
    ],
    ['o build-mode autobuild', 'build-mode: none', 'build-mode: autobuild'],
    ['o build-mode ausente', '          build-mode: none\n', ''],
    [
      'um passo run',
      '      - uses: github/codeql-action/analyze',
      '      - run: npm ci\n      - uses: github/codeql-action/analyze',
    ],
    ['o init por tag', `codeql-action/init@${SHA}`, 'codeql-action/init@v4'],
    [
      'o analyze por SHA curto',
      `codeql-action/analyze@${SHA}`,
      `codeql-action/analyze@${'c'.repeat(39)}`,
    ],
  ])('AI-44 %s reprova nos passos', (_label, from, to) => {
    expect(stepViolations(edited(from, to))).not.toEqual([]);
  });
});

describe('AI-44 o codeql.yml roda o CodeQL só em javascript-typescript, sem script do PR', () => {
  const path = join(workflowsDir, 'codeql.yml');
  const codeql = readWorkflowFile('codeql.yml') ?? {};

  it('AI-44 o arquivo .github/workflows/codeql.yml existe', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('AI-44 roda em todo PR para a main, em push na main e uma vez por semana', () => {
    expect(triggerViolations(codeql)).toEqual([]);
  });

  it('AI-44 só o job analyze tem security-events: write, e o topo só lê', () => {
    expect(permissionViolations(codeql)).toEqual([]);
  });

  it('AI-44 usa só a linguagem javascript-typescript com build-mode none, sem passo run e com as actions fixadas por SHA', () => {
    expect(stepViolations(codeql)).toEqual([]);
  });
});
