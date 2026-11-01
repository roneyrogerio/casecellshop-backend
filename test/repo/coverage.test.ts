import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';
import {
  readCi,
  stepsOfJob,
  stepsOfWorkflow,
  workflowOf,
  type CiStep,
} from '../helpers/ci-workflow.ts';

// AI-37: o CI mede a cobertura de src/ (v8) em todos os testes e reprova abaixo do piso do vitest.config.ts.
// O valor do piso é medido no PR que o criou; aqui só se confere que ele existe, que é positivo e que o CI o aplica.
interface CoverageConfig {
  provider?: unknown;
  include?: unknown;
  thresholds?: Record<string, unknown>;
}

const coverage = (config as { test?: { coverage?: CoverageConfig } }).test
  ?.coverage;

describe('AI-37 o vitest.config.ts declara a cobertura', () => {
  it('AI-37 o provider da cobertura é o v8', () => {
    expect(coverage?.provider).toBe('v8');
  });

  it('AI-37 o include da cobertura cobre src/', () => {
    const include = Array.isArray(coverage?.include) ? coverage.include : [];

    expect(
      include.some((pattern) => /^(\.\/)?src(\/|$)/.test(String(pattern))),
    ).toBe(true);
  });

  it.each(['lines', 'functions', 'branches', 'statements'])(
    'AI-37 o piso de %s é um número maior que 0 e até 100',
    (metric) => {
      const value = coverage?.thresholds?.[metric];

      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThan(0);
      expect(value as number).toBeLessThanOrEqual(100);
    },
  );
});

// A cobertura roda só na perna do Node do .nvmrc (matrix.node == 'nvmrc'): num passo à parte com `if`, ou numa
// expressão do `run`, como o --exclude da perna do piso.
const ONLY_NVMRC_FLAG =
  /\$\{\{[^}]*(?:matrix\.node\s*==\s*'nvmrc'|matrix\.node\s*!=\s*'24\.12\.0')\s*&&\s*'[^']*--coverage[^']*'[^}]*\}\}/;
const ONLY_NVMRC_IF =
  /matrix\.node\s*==\s*'nvmrc'|matrix\.node\s*!=\s*'24\.12\.0'/;

function coverageSteps(steps: CiStep[]): CiStep[] {
  return steps.filter((step) => (step.run ?? '').includes('--coverage'));
}

function isRestrictedToNvmrc(step: CiStep): boolean {
  const run = step.run ?? '';
  if (ONLY_NVMRC_IF.test(step.if ?? '')) return true;
  // Sem o trecho condicional, nenhum --coverage pode sobrar no comando.
  return (
    ONLY_NVMRC_FLAG.test(run) &&
    !run.replace(new RegExp(ONLY_NVMRC_FLAG, 'g'), '').includes('--coverage')
  );
}

// Todos os testes, os de integração inclusive: nenhum filtro de projeto no comando que mede a cobertura.
function coversAllTests(step: CiStep): boolean {
  return !/--project\b/.test(step.run ?? '');
}

describe('AI-37 o ci.yml mede a cobertura só na perna do .nvmrc', () => {
  const sample = (run: string): CiStep[] => stepsOfWorkflow(workflowOf(run));

  it('AI-37 o leitor reconhece a flag condicional à perna do .nvmrc e recusa a incondicional', () => {
    const [conditional] = sample(
      "npm test -- ${{ matrix.node == 'nvmrc' && '--coverage' || '' }}",
    );
    const [always] = sample('npm test -- --coverage');
    const [both] = sample(
      "npm test -- --coverage ${{ matrix.node == 'nvmrc' && '--coverage' || '' }}",
    );

    expect(coverageSteps([conditional ?? {}])).toHaveLength(1);
    expect(isRestrictedToNvmrc(conditional ?? {})).toBe(true);
    expect(isRestrictedToNvmrc(always ?? {})).toBe(false);
    expect(isRestrictedToNvmrc(both ?? {})).toBe(false);
    expect(
      isRestrictedToNvmrc({
        run: 'npm test -- --coverage',
        if: "matrix.node == 'nvmrc'",
      }),
    ).toBe(true);
  });

  it('AI-37 o CI roda os testes com --coverage, no job test', () => {
    expect(coverageSteps(stepsOfJob(readCi(), 'test')).length).toBeGreaterThan(
      0,
    );
  });

  it('AI-37 o --coverage vale só na perna do Node do .nvmrc, e não na do piso (24.12.0)', () => {
    const steps = coverageSteps(stepsOfJob(readCi(), 'test'));

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(isRestrictedToNvmrc(step)).toBe(true);
  });

  it('AI-37 a cobertura vale para todos os testes, os de integração inclusive (sem --project)', () => {
    const steps = coverageSteps(stepsOfJob(readCi(), 'test'));

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(coversAllTests(step)).toBe(true);
  });

  it('AI-37 o @vitest/coverage-v8 está nas devDependencies com versão exata', () => {
    const pkg = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'package.json'),
        'utf8',
      ),
    ) as { devDependencies?: Record<string, string> };

    expect(pkg.devDependencies?.['@vitest/coverage-v8']).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});
