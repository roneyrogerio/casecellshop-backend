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

// O escopo da medida é fixo: um escopo menor sobe a medida sem tocar no piso. Só estas quatro chaves; qualquer outra
// (ignoreClassMethods, excludeAfterRemap, allowExternal...) pode mudar o que entra na conta.
const SCOPE_KEYS = ['provider', 'include', 'exclude', 'thresholds'];
const SCOPE_INCLUDE = ['src/**/*.ts'];
const SCOPE_EXCLUDE = ['src/**/*.test.ts', 'src/db/types/**', 'src/main/**'];

// A ordem não importa; a repetição conta como diferença (compara as listas ordenadas, como multiconjuntos).
function listDiffs(
  name: string,
  actual: unknown,
  expected: string[],
): string[] {
  if (!Array.isArray(actual)) return [`${name} não é uma lista`];
  const rest = Array.from(actual as unknown[]);
  const diffs: string[] = [];
  for (const pattern of expected) {
    const at = rest.indexOf(pattern);
    if (at === -1) diffs.push(`${name} sem ${pattern}`);
    else rest.splice(at, 1);
  }
  for (const extra of rest) diffs.push(`${name} a mais: ${String(extra)}`);
  return diffs;
}

// Devolve o que difere do escopo esperado; lista vazia é o escopo certo.
function coverageScopeDiffs(actual: unknown): string[] {
  if (typeof actual !== 'object' || actual === null) {
    return ['coverage ausente'];
  }
  const keys = Object.keys(actual);
  return [
    ...SCOPE_KEYS.filter((key) => !keys.includes(key)).map(
      (key) => `chave faltando: ${key}`,
    ),
    ...keys
      .filter((key) => !SCOPE_KEYS.includes(key))
      .map((key) => `chave a mais: ${key}`),
    ...listDiffs(
      'include',
      (actual as { include?: unknown }).include,
      SCOPE_INCLUDE,
    ),
    ...listDiffs(
      'exclude',
      (actual as { exclude?: unknown }).exclude,
      SCOPE_EXCLUDE,
    ),
  ];
}

describe('AI-37 o escopo da cobertura é fixo', () => {
  const loaded = coverage as Record<string, unknown>;
  const exclude = loaded['exclude'] as string[];

  it('AI-37 o coverage do config carregado tem só provider, include, exclude e thresholds, com o include e o exclude esperados', () => {
    expect(coverageScopeDiffs(coverage)).toEqual([]);
  });

  it('AI-37 a ordem do include e do exclude não importa', () => {
    expect(
      coverageScopeDiffs({ ...loaded, exclude: [...exclude].reverse() }),
    ).toEqual([]);
  });

  // Controles negativos: a conferência acha cada desvio, e o diz.
  it.each([
    {
      change: 'um exclude a mais (src/erp/**)',
      copy: { ...loaded, exclude: [...exclude, 'src/erp/**'] },
      diff: 'exclude a mais: src/erp/**',
    },
    {
      change: 'um exclude a menos (sem src/main/**)',
      copy: { ...loaded, exclude: exclude.filter((p) => p !== 'src/main/**') },
      diff: 'exclude sem src/main/**',
    },
    {
      change: 'um exclude repetido',
      copy: { ...loaded, exclude: [...exclude, 'src/db/types/**'] },
      diff: 'exclude a mais: src/db/types/**',
    },
    {
      change: 'o include mais estreito (src/http/**/*.ts)',
      copy: { ...loaded, include: ['src/http/**/*.ts'] },
      diff: 'include a mais: src/http/**/*.ts',
    },
    {
      change: 'um include a mais (src/**/*.ts repetido)',
      copy: { ...loaded, include: ['src/**/*.ts', 'src/**/*.ts'] },
      diff: 'include a mais: src/**/*.ts',
    },
    {
      change: 'o include como texto, e não como lista',
      copy: { ...loaded, include: 'src/**/*.ts' },
      diff: 'include não é uma lista',
    },
    {
      change: 'a chave ignoreClassMethods',
      copy: { ...loaded, ignoreClassMethods: ['x'] },
      diff: 'chave a mais: ignoreClassMethods',
    },
    {
      change: 'a chave excludeAfterRemap',
      copy: { ...loaded, excludeAfterRemap: true },
      diff: 'chave a mais: excludeAfterRemap',
    },
    {
      change: 'a chave allowExternal',
      copy: { ...loaded, allowExternal: true },
      diff: 'chave a mais: allowExternal',
    },
    {
      change: 'sem a chave thresholds',
      copy: Object.fromEntries(
        Object.entries(loaded).filter(([key]) => key !== 'thresholds'),
      ),
      diff: 'chave faltando: thresholds',
    },
  ])(
    'AI-37 controle negativo: a conferência do escopo reprova $change',
    ({ copy, diff }) => {
      expect(coverageScopeDiffs(copy)).toContain(diff);
    },
  );

  it('AI-37 controle negativo: a conferência reprova um coverage ausente', () => {
    expect(coverageScopeDiffs(undefined)).not.toEqual([]);
  });
});

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
