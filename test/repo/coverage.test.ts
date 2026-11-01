import { existsSync, readFileSync } from 'node:fs';
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
import { repoRoot } from '../helpers/repo-root.ts';

// AI-37: o CI mede a cobertura de src/ (v8) em todos os testes e reprova abaixo do piso do coverage-floor.json, que o
// vitest.config.ts importa. O valor do piso é medido no PR que o criou; aqui só se confere que ele existe, que é
// positivo, que o config o usa sem repetir número e que o CI o aplica.
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

  // O piso é um dado (AI-49): o config só o repassa, e o valor mora num lugar só.
  it('AI-37 o thresholds do config carregado é igual ao conteúdo do coverage-floor.json', () => {
    const file = join(repoRoot, 'coverage-floor.json');

    expect(existsSync(file), 'coverage-floor.json na raiz').toBe(true);
    expect(coverage?.thresholds).toEqual(
      JSON.parse(readFileSync(file, 'utf8')),
    );
  });

  it('AI-37 o vitest.config.ts importa o coverage-floor.json como JSON e não repete número de piso', () => {
    const text = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');

    expect(text).toMatch(
      /import\s+floor\s+from\s+'\.\/coverage-floor\.json'\s+with\s*\{\s*type:\s*'json'\s*\}/,
    );
    expect(text).toMatch(/thresholds\s*:\s*floor\b/);
    expect(text).not.toMatch(/thresholds\s*:\s*\{/);
    expect(text).not.toMatch(
      /\b(?:lines|functions|branches|statements)\s*:\s*\d/,
    );
  });
});

// A cobertura roda só na perna do Node do .nvmrc (matrix.node == 'nvmrc'): num passo à parte com `if`, ou numa
// expressão do `run`, como o --exclude da perna do piso.
const ONLY_NVMRC_FLAG =
  /\$\{\{[^}]*(?:matrix\.node\s*==\s*'nvmrc'|matrix\.node\s*!=\s*'24\.12\.0')\s*&&\s*'[^']*--coverage[^']*'[^}]*\}\}/;
const ONLY_NVMRC_IF =
  /matrix\.node\s*==\s*'nvmrc'|matrix\.node\s*!=\s*'24\.12\.0'/;

// O trecho condicional à perna do .nvmrc que leva as flags da cobertura (só o texto entre as aspas simples).
const REPORT_FLAGS =
  /\$\{\{\s*matrix\.node\s*==\s*'nvmrc'\s*&&\s*'([^']*)'\s*\|\|\s*''\s*\}\}/g;

function legFlags(run: string): { inside: string; outside: string } {
  return {
    inside: [...run.matchAll(REPORT_FLAGS)].map((m) => m[1] ?? '').join(' '),
    outside: run.replace(REPORT_FLAGS, ''),
  };
}

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

  // AI-49: a conferência da medida lê o relatório json-summary; ele sai fora do repositório, em $RUNNER_TEMP, e só na
  // perna que mede a cobertura.
  it('AI-49 o passo do npm test grava o json-summary em $RUNNER_TEMP/coverage, dentro do trecho da perna do .nvmrc', () => {
    const [step] = coverageSteps(stepsOfJob(readCi(), 'test'));
    const { inside, outside } = legFlags(step?.run ?? '');

    expect(inside).toContain('--coverage.reporter=json-summary');
    expect(inside).toContain(
      '--coverage.reportsDirectory="$RUNNER_TEMP/coverage"',
    );
    expect(outside).not.toMatch(/json-summary|reportsDirectory/);
  });

  it('AI-49 o leitor do trecho reconhece o json-summary condicional e recusa o incondicional', () => {
    const conditional = legFlags(
      `npm test -- \${{ matrix.node == 'nvmrc' && '--coverage --coverage.reporter=json-summary' || '' }}`,
    );
    const always = legFlags(
      `npm test -- --coverage.reporter=json-summary \${{ matrix.node == 'nvmrc' && '--coverage' || '' }}`,
    );

    expect(conditional.inside).toContain('json-summary');
    expect(conditional.outside).not.toContain('json-summary');
    expect(always.outside).toContain('json-summary');
  });

  it('AI-37 o @vitest/coverage-v8 está nas devDependencies com versão exata', () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };

    expect(pkg.devDependencies?.['@vitest/coverage-v8']).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
});
