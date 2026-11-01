import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  apiFuzzJobViolations,
  FUZZ_STEP,
  FUZZ_UPLOAD_IF,
  REPORT_DIR_STEP,
  reportDirAfterFuzz,
  SHARED_FUZZ_CASES,
  type FuzzCase,
  type FuzzJob,
} from '../helpers/api-fuzz-job.ts';
import {
  jobOf,
  mutated,
  parseWorkflow,
  readCi,
  stepsOfJob,
  stepsOfWorkflow,
  writeGrants,
  type CiJob,
  type CiStep,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-42: o CI tem quatro jobs, e o ruleset exige só o `ci-ok`. `checks` roda uma vez o que não depende do Node,
// `test` é a matriz do FND-12, `workflows` confere os workflows (AI-43) e `ci-ok` agrega os outros três. Cada
// conferência devolve as violações; a lista vazia é o que o ci.yml deve ter, e os controles negativos montam um YAML
// de propósito errado para provar que ela enxerga o erro. FND-16: um quinto job, `api-fuzz`, roda a versão leve do
// fuzzing em paralelo, e o `ci-ok` espera por ele.

afterAll(cleanupTempDirs);

const JOB_IDS = ['checks', 'ci-ok', 'test', 'workflows'];
// FND-16: o fuzzing leve do PR é um quinto job, em paralelo aos outros, e o ci-ok espera por ele.
const CI_JOB_IDS = ['api-fuzz', ...JOB_IDS].sort();
const PULL_REQUEST_ONLY = /github\.event_name\s*==\s*'pull_request'/;
const NVMRC_ONLY = /matrix\.node\s*==\s*'nvmrc'/;

interface Check {
  label: string;
  job: 'checks' | 'test';
  pattern: RegExp;
  // `any`: o critério deixa rodar sempre ou só no pull_request (a conferência do lockfile não depende da base).
  only?: 'pull_request' | 'nvmrc' | 'any';
}

// Cada passo que o critério distribui entre os jobs. `pattern` reconhece o `run:` inteiro do passo.
const CHECKS: Check[] = [
  { label: 'lint', job: 'checks', pattern: /^npm run lint$/ },
  {
    label: 'prettier',
    job: 'checks',
    pattern: /^node_modules\/\.bin\/prettier --check\b/,
  },
  { label: 'typecheck', job: 'checks', pattern: /^npm run typecheck$/ },
  { label: 'knip', job: 'checks', pattern: /^node_modules\/\.bin\/knip\b/ },
  { label: 'jscpd', job: 'checks', pattern: /^node_modules\/\.bin\/jscpd\b/ },
  { label: 'npm audit', job: 'checks', pattern: /^npm audit --omit=dev$/ },
  {
    label: 'npm audit signatures',
    job: 'checks',
    pattern: /^npm audit signatures$/,
  },
  {
    label: 'openapi --check',
    job: 'checks',
    pattern: /^npm run openapi -- --check$/,
  },
  {
    label: 'lint:openapi',
    job: 'checks',
    pattern: /^npm run lint:openapi$/,
  },
  {
    label: 'check:instructions',
    job: 'checks',
    pattern: /^npm run check:instructions$/,
  },
  {
    label: 'migrações',
    job: 'checks',
    pattern: /^node scripts\/check-migrations\.ts$/,
    only: 'pull_request',
  },
  {
    label: 'scripts do package.json',
    job: 'checks',
    pattern: /^node scripts\/check-scripts\.ts$/,
    only: 'pull_request',
  },
  {
    label: 'origem e integridade do lockfile',
    job: 'checks',
    pattern: /^node scripts\/check-lockfile\.ts$/,
    only: 'any',
  },
  {
    label: 'pisos e linha de base',
    job: 'checks',
    pattern: /^node scripts\/check-baselines\.ts$/,
    only: 'pull_request',
  },
  {
    label: 'commitlint',
    job: 'checks',
    pattern: /(^|\s)commitlint\s/,
    only: 'pull_request',
  },
  { label: 'vitest', job: 'test', pattern: /^npm test(\s|$)/ },
  {
    label: 'tabela critério × teste',
    job: 'test',
    pattern: /^node scripts\/criteria-report\.ts\b/,
    only: 'nvmrc',
  },
  {
    label: 'tipos do banco',
    job: 'test',
    pattern: /^node scripts\/check-db-types\.ts$/,
    only: 'nvmrc',
  },
];

function matching(steps: CiStep[], check: Check): CiStep[] {
  return steps.filter((step) => check.pattern.test((step.run ?? '').trim()));
}

// Cada passo está no job certo, só nele e uma vez só; e a condição de cada um é a que o critério pede.
function placementViolations(workflow: CiWorkflow): string[] {
  const violations: string[] = [];
  for (const check of CHECKS) {
    for (const id of JOB_IDS.filter((candidate) => candidate !== check.job)) {
      if (matching(stepsOfJob(workflow, id), check).length > 0)
        violations.push(
          `${check.label}: roda no job ${id}, e não no ${check.job}`,
        );
    }
    const found = matching(stepsOfJob(workflow, check.job), check);
    if (found.length !== 1) {
      violations.push(
        `${check.label}: ${found.length} passos no job ${check.job}, esperado 1`,
      );
      continue;
    }
    const condition = found[0]?.if ?? '';
    if (check.only === 'pull_request' && !PULL_REQUEST_ONLY.test(condition))
      violations.push(`${check.label}: não é restrito ao pull_request`);
    if (check.only === 'nvmrc' && !NVMRC_ONLY.test(condition))
      violations.push(`${check.label}: não é restrito ao Node do .nvmrc`);
    if (check.only === undefined && condition !== '')
      violations.push(
        `${check.label}: tem condição (${condition}), e deve rodar sempre`,
      );
  }
  return violations;
}

// Checkout, setup-node e npm ci abrem o job; todo o resto vem depois deles.
function openingViolations(workflow: CiWorkflow, id: string): string[] {
  const steps = stepsOfJob(workflow, id);
  const [checkout, setup, install] = steps;
  const violations: string[] = [];
  if (!(checkout?.uses ?? '').startsWith('actions/checkout@'))
    violations.push(`${id}: o primeiro passo não é o checkout`);
  if (!(setup?.uses ?? '').startsWith('actions/setup-node@'))
    violations.push(`${id}: o segundo passo não é o setup-node`);
  if ((install?.run ?? '').trim() !== 'npm ci')
    violations.push(`${id}: o terceiro passo não é o npm ci`);
  return violations;
}

const DEFINED = (value: unknown): boolean =>
  value !== undefined && value !== '';

// O job `checks` roda uma vez, no Node do .nvmrc, sem matriz, com o histórico inteiro (migrações e commitlint).
function checksJobViolations(workflow: CiWorkflow): string[] {
  const job = jobOf(workflow, 'checks');
  if (job === undefined) return ['falta o job checks'];
  const violations: string[] = [];
  if (job.name !== 'Checagens') violations.push(`nome ${String(job.name)}`);
  if (job.strategy !== undefined) violations.push('tem strategy (matriz)');
  const [checkout, setup] = job.steps ?? [];
  if (String(checkout?.with?.['fetch-depth']) !== '0')
    violations.push('o checkout não baixa o histórico (fetch-depth: 0)');
  if (setup?.with?.['node-version-file'] !== '.nvmrc')
    violations.push('o setup-node não lê o .nvmrc');
  if (DEFINED(setup?.with?.['node-version']))
    violations.push('o setup-node também recebe node-version');
  return violations;
}

function testJobViolations(workflow: CiWorkflow): string[] {
  const job = jobOf(workflow, 'test');
  if (job === undefined) return ['falta o job test'];
  const violations: string[] = [];
  if (job.name !== 'Node ${{ matrix.node }}')
    violations.push(`nome ${String(job.name)}`);
  if (
    JSON.stringify(job.strategy?.matrix?.node) !==
    JSON.stringify(['nvmrc', '24.12.0'])
  )
    violations.push('a matriz não é [nvmrc, 24.12.0]');
  if (job.strategy?.['fail-fast'] !== false)
    violations.push('fail-fast não é false');
  const run = (job.steps ?? []).find((step) =>
    (step.run ?? '').startsWith('npm test'),
  );
  if (!/--reporter[= ]github-actions(\s|$)/.test(run?.run ?? ''))
    violations.push('o npm test não usa o reporter github-actions');
  return violations;
}

// Qualquer forma de repetir teste que falhou: --retry do Vitest, uma action de retry, `retries`.
function retryViolations(workflow: CiWorkflow): string[] {
  return stepsOfWorkflow(workflow)
    .map((step) => JSON.stringify(step))
    .filter((text) => /retr(?:y|ies)/i.test(text));
}

// AI-05: o que confere algo do PR roda o binário ou o arquivo de scripts/, nunca por npm run, npm exec ou npx,
// porque o package.json do PR poderia redefinir o script que o confere.
const PR_CHECK_TOOLS =
  /check[-:](?:migrations|scripts|lockfile|baselines|db-types|unused|duplication)|criteria-report|format:check|\b(?:knip|jscpd|prettier)\b/;
const THROUGH_PACKAGE_MANAGER = /\b(?:npm\s+(?:run|run-script|exec|x)|npx)\b/;

function prChecksThroughNpm(workflow: CiWorkflow): string[] {
  return ['checks', 'test']
    .flatMap((id) => stepsOfJob(workflow, id))
    .map((step) => step.run ?? '')
    .filter(
      (run) => PR_CHECK_TOOLS.test(run) && THROUGH_PACKAGE_MANAGER.test(run),
    );
}

// --- ci-ok -----------------------------------------------------------------------------------------------------

const ALWAYS = /^(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?$/;
const NEEDS_AS_JSON = /^\$\{\{\s*toJSON\(needs\)\s*\}\}$/;

function needsOf(job: CiJob): string[] {
  const needs = job.needs ?? [];
  return typeof needs === 'string' ? [needs] : needs;
}

function otherJobIds(workflow: CiWorkflow): string[] {
  return Object.keys(workflow.jobs ?? {}).filter((id) => id !== 'ci-ok');
}

function ciOkStep(workflow: CiWorkflow): CiStep | undefined {
  const steps = stepsOfJob(workflow, 'ci-ok').filter((step) => step.run);
  return steps.length === 1 ? steps[0] : undefined;
}

// A forma do job: depende de todos os outros (calculados do YAML, para um job novo esquecido reprovar), roda com
// always() e tem um passo de shell que não interpola o contexto no `run:`.
function ciOkViolations(workflow: CiWorkflow): string[] {
  const job = jobOf(workflow, 'ci-ok');
  if (job === undefined) return ['falta o job ci-ok'];
  const violations: string[] = [];
  if (job.name !== 'ci-ok') violations.push(`nome ${String(job.name)}`);
  const missing = otherJobIds(workflow).filter(
    (id) => !needsOf(job).includes(id),
  );
  if (missing.length > 0)
    violations.push(`needs não tem ${missing.join(', ')}`);
  if (!ALWAYS.test((job.if ?? '').trim()))
    violations.push(`if é ${JSON.stringify(job.if)}, e não always()`);
  const step = ciOkStep(workflow);
  if (step === undefined) return [...violations, 'não tem um único passo run'];
  const run = step.run ?? '';
  if (run.includes('${{'))
    violations.push('interpola uma expressão no run (passe por env)');
  for (const word of ['failure', 'cancelled'])
    if (!run.includes(word)) violations.push(`o run não cita ${word}`);
  return violations;
}

// O passo recebe o contexto `needs` por env, como o GitHub o entrega: JSON com o resultado de cada job.
function envOfCiOk(
  step: CiStep,
  results: Record<string, string>,
): Record<string, string> | null {
  const needs = Object.fromEntries(
    Object.entries(results).map(([id, result]) => [
      id,
      { result, outputs: {} },
    ]),
  );
  const env: Record<string, string> = {};
  let received = false;
  for (const [name, raw] of Object.entries(step.env ?? {})) {
    const value = String(raw);
    if (NEEDS_AS_JSON.test(value)) {
      env[name] = JSON.stringify(needs, null, 2);
      received = true;
    } else if (value.includes('${{')) {
      throw new Error(`expressão do env não suportada pelo teste: ${value}`);
    } else {
      env[name] = value;
    }
  }
  return received ? env : null;
}

function runStep(step: CiStep, env: Record<string, string>): number | null {
  const dir = makeTempDir('ci-ok-');
  writeFileIn(dir, 'step.sh', step.run ?? '');
  // O shell padrão do GitHub no Linux: bash -e {0}.
  return runCommand(
    'bash',
    ['--noprofile', '--norc', '-e', join(dir, 'step.sh')],
    { env: { PATH: process.env.PATH ?? '', ...env } },
  ).status;
}

// failure e cancelled de qualquer job reprovam; success e skipped (que o critério não lista) passam.
function ciOkBehaviorViolations(workflow: CiWorkflow): string[] {
  const step = ciOkStep(workflow);
  if (step === undefined) return ['não tem um único passo run'];
  const ids = otherJobIds(workflow);
  const allSuccess = Object.fromEntries(ids.map((id) => [id, 'success']));
  const cases = [
    { label: 'tudo success', results: allSuccess, passes: true },
    ...ids.flatMap((id) => [
      {
        label: `${id} failure`,
        results: { ...allSuccess, [id]: 'failure' },
        passes: false,
      },
      {
        label: `${id} cancelled`,
        results: { ...allSuccess, [id]: 'cancelled' },
        passes: false,
      },
      {
        label: `${id} skipped`,
        results: { ...allSuccess, [id]: 'skipped' },
        passes: true,
      },
    ]),
  ];
  const violations: string[] = [];
  for (const { label, results, passes } of cases) {
    const env = envOfCiOk(step, results);
    if (env === null) return ['o passo não recebe o contexto needs pelo env'];
    const status = runStep(step, env);
    if ((status === 0) !== passes)
      violations.push(
        `${label}: saiu com ${String(status)}, esperado ${passes ? '0' : 'diferente de 0'}`,
      );
  }
  return violations;
}

// --- linhas de base em memória ----------------------------------------------------------------------------------

const ciOkJob = (needs: string): string => `  ci-ok:
    name: ci-ok
    needs: [${needs}]
    if: always()
    steps:
      - env:
          RESULTS: \${{ toJSON(needs) }}
        run: |
          if echo "$RESULTS" | grep -Eq '"result": *"(failure|cancelled)"'; then
            echo "Um job falhou ou foi cancelado."
            exit 1
          fi
`;

const GOOD_CI_OK = `
jobs:
  checks:
    steps:
      - run: npm run lint
  test:
    steps:
      - run: npm test
${ciOkJob('checks, test')}`;

function variant(edit: (text: string) => string): CiWorkflow {
  const text = edit(GOOD_CI_OK);
  expect(text, 'a edição do controle negativo não mudou nada').not.toBe(
    GOOD_CI_OK,
  );
  return parseWorkflow(text);
}

describe('AI-42 as conferências do ci-ok enxergam o que procuram (controle negativo)', () => {
  it('AI-42 o ci-ok correto passa na forma e no comportamento do passo de shell', () => {
    const good = parseWorkflow(GOOD_CI_OK);

    expect(ciOkViolations(good)).toEqual([]);
    expect(ciOkBehaviorViolations(good)).toEqual([]);
  });

  it('AI-42 um ci-ok sem always() reprova, com a condição ausente ou outra', () => {
    expect(
      ciOkViolations(variant((t) => t.replace('    if: always()\n', ''))),
    ).not.toEqual([]);
    expect(
      ciOkViolations(variant((t) => t.replace('always()', 'success()'))),
    ).not.toEqual([]);
  });

  it('AI-42 um ci-ok sem um dos jobs em needs reprova, e um job novo esquecido também', () => {
    expect(
      ciOkViolations(
        variant((t) => t.replace('needs: [checks, test]', 'needs: [checks]')),
      ),
    ).not.toEqual([]);
    expect(
      ciOkViolations(
        variant((t) => `${t}  extra:\n    steps:\n      - run: echo\n`),
      ),
    ).toEqual(['needs não tem extra']);
  });

  it('AI-42 um ci-ok que não reprova cancelled reprova, mesmo citando a palavra num comentário', () => {
    const onlyFailure = variant((t) =>
      t.replace('(failure|cancelled)', '(failure)'),
    );
    const mentionsOnly = variant((t) =>
      t
        .replace('(failure|cancelled)', '(failure)')
        .replace('then\n', 'then # cancelled\n'),
    );

    expect(ciOkViolations(onlyFailure)).toContain('o run não cita cancelled');
    expect(ciOkViolations(mentionsOnly)).toEqual([]);
    expect(ciOkBehaviorViolations(onlyFailure)).toEqual([
      'checks cancelled: saiu com 0, esperado diferente de 0',
      'test cancelled: saiu com 0, esperado diferente de 0',
    ]);
    expect(ciOkBehaviorViolations(mentionsOnly)).not.toEqual([]);
  });

  it('AI-42 um ci-ok que só reprova cancelled, ou que reprova sempre, reprova no comportamento', () => {
    expect(
      ciOkBehaviorViolations(
        variant((t) => t.replace('(failure|cancelled)', '(cancelled)')),
      ),
    ).toHaveLength(2);
    expect(
      ciOkBehaviorViolations(
        variant((t) =>
          t.replace('(failure|cancelled)', '(success|failure|cancelled)'),
        ),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('AI-42 um ci-ok que interpola o contexto no run, em vez de passar por env, reprova', () => {
    const interpolated = variant((t) =>
      t.replace('"$RESULTS"', '"${{ toJSON(needs) }}"'),
    );

    expect(ciOkViolations(interpolated)).toContain(
      'interpola uma expressão no run (passe por env)',
    );
  });
});

describe('AI-42 as conferências de retry e de npm run enxergam o que procuram (controle negativo)', () => {
  const build = (run: string, uses?: string): CiWorkflow => ({
    jobs: { test: { steps: [uses === undefined ? { run } : { uses, run }] } },
  });

  it('AI-42 um --retry, um retries ou uma action de retry reprovam; o npm test sem eles passa', () => {
    expect(retryViolations(build('npm test -- --retry=2'))).toHaveLength(1);
    expect(retryViolations(build('npm test -- --retry 2'))).toHaveLength(1);
    expect(
      retryViolations(build('npm test', 'nick-fields/retry@v3')),
    ).toHaveLength(1);
    expect(retryViolations(build('npm test -- --retries=2'))).toHaveLength(1);
    expect(retryViolations(build('npm test -- --reporter=json'))).toEqual([]);
  });

  it('AI-05 a conferência por npm run enxerga as conferências do PR por npm run, npm exec e npx, e só elas', () => {
    const offenders = [
      'npm run check:unused',
      'npm run check:duplication',
      'npm run format:check',
      'npm run check:migrations',
      'npm run check:scripts',
      'npm run check:lockfile',
      'npm run check:baselines',
      'npm run check:db-types',
      'npx knip',
      'npm exec -- jscpd',
    ];

    for (const run of offenders)
      expect(prChecksThroughNpm(build(run)), run).toEqual([run]);
    for (const run of [
      'npm run lint',
      'npm run typecheck',
      'npm run openapi -- --check',
      'node_modules/.bin/knip --no-progress',
      'node scripts/check-migrations.ts',
      'node scripts/check-lockfile.ts',
      'node scripts/check-baselines.ts',
      'node scripts/criteria-report.ts r.json >> "$GITHUB_STEP_SUMMARY"',
    ])
      expect(prChecksThroughNpm(build(run)), run).toEqual([]);
  });

  it('AI-42 a conferência de posição reprova o passo no job errado, repetido ou ausente', () => {
    const checks = (runs: string[]): CiWorkflow => ({
      jobs: { checks: { steps: runs.map((run) => ({ run })) } },
    });

    const wrongJob = placementViolations({
      jobs: { test: { steps: [{ run: 'npm run lint' }] } },
    });
    const repeated = placementViolations(
      checks(['npm run lint', 'npm run lint']),
    );

    expect(wrongJob).toContain('lint: roda no job test, e não no checks');
    expect(repeated).toContain('lint: 2 passos no job checks, esperado 1');
    expect(placementViolations({})).toContain(
      'lint: 0 passos no job checks, esperado 1',
    );
  });
});

// A estrutura do critério, completa e correta: prova que as conferências aceitam o que elas pedem.
const SHA = 'a'.repeat(40);
const GOOD_STRUCTURE = `
jobs:
  checks:
    name: Checagens
    steps:
      - uses: actions/checkout@${SHA}
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@${SHA}
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit signatures
      - run: npm run lint
      - run: node_modules/.bin/prettier --check .
      - run: npm run typecheck
      - run: node_modules/.bin/knip --no-progress
      - run: node_modules/.bin/jscpd --config .jscpd.json --baseline .jscpd-baseline.json --fail-on-new-clones
      - run: npm audit --omit=dev
      - run: npm run openapi -- --check
      - run: npm run lint:openapi
      - run: npm run check:instructions
      - if: github.event_name == 'pull_request'
        env:
          BASE_REF: \${{ github.base_ref }}
        run: node scripts/check-migrations.ts
      - if: github.event_name == 'pull_request'
        env:
          BASE_REF: \${{ github.base_ref }}
        run: node scripts/check-scripts.ts
      - run: node scripts/check-lockfile.ts
      - if: github.event_name == 'pull_request'
        env:
          BASE_REF: \${{ github.base_ref }}
        run: node scripts/check-baselines.ts
      - if: github.event_name == 'pull_request'
        run: npx commitlint --from \${{ github.event.pull_request.base.sha }} --to \${{ github.event.pull_request.head.sha }} --verbose
  test:
    name: Node \${{ matrix.node }}
    strategy:
      fail-fast: false
      matrix:
        node: [nvmrc, '24.12.0']
    steps:
      - uses: actions/checkout@${SHA}
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@${SHA}
      - run: npm ci
      - run: npm test -- --reporter=default --reporter=github-actions --reporter=json --outputFile.json="$RUNNER_TEMP/vitest-report.json"
      - if: \${{ !cancelled() && matrix.node == 'nvmrc' }}
        run: node scripts/criteria-report.ts "$RUNNER_TEMP/vitest-report.json" >> "$GITHUB_STEP_SUMMARY"
      - if: matrix.node == 'nvmrc'
        run: node scripts/check-db-types.ts
  workflows:
    name: Workflows
    steps:
      - uses: actions/checkout@${SHA}
        with: { persist-credentials: false }
${ciOkJob('checks, test, workflows')}`;

describe('AI-42 a estrutura completa do critério passa em todas as conferências (controle positivo)', () => {
  const good = parseWorkflow(GOOD_STRUCTURE);

  it('AI-42 as conferências de jobs, posição, abertura, ci-ok, retry e npm run aceitam a estrutura correta', () => {
    expect(Object.keys(good.jobs ?? {}).sort()).toEqual(JOB_IDS);
    expect(checksJobViolations(good)).toEqual([]);
    expect(testJobViolations(good)).toEqual([]);
    expect([
      ...openingViolations(good, 'checks'),
      ...openingViolations(good, 'test'),
    ]).toEqual([]);
    expect(placementViolations(good)).toEqual([]);
    expect(ciOkViolations(good)).toEqual([]);
    expect(ciOkBehaviorViolations(good)).toEqual([]);
    expect(retryViolations(good)).toEqual([]);
    expect(prChecksThroughNpm(good)).toEqual([]);
  });

  it('AI-42 o commitlint fora do pull_request, a matriz sem fail-fast e o npm test sem github-actions reprovam', () => {
    const edit = (change: (text: string) => string): CiWorkflow =>
      parseWorkflow(change(GOOD_STRUCTURE));

    expect(
      placementViolations(
        edit((t) =>
          t.replace(
            "      - if: github.event_name == 'pull_request'\n        run: npx commitlint",
            '      - run: npx commitlint',
          ),
        ),
      ),
    ).toEqual(['commitlint: não é restrito ao pull_request']);
    expect(
      testJobViolations(edit((t) => t.replace('fail-fast: false', ''))),
    ).toEqual(['fail-fast não é false']);
    expect(
      testJobViolations(
        edit((t) => t.replace(' --reporter=github-actions', '')),
      ),
    ).toEqual(['o npm test não usa o reporter github-actions']);
    expect(
      checksJobViolations(
        edit((t) => t.replace('fetch-depth: 0', 'fetch-depth: 1')),
      ),
    ).toEqual(['o checkout não baixa o histórico (fetch-depth: 0)']);
  });
});

describe('AI-42 o ci.yml tem os jobs checks, test, workflows e ci-ok', () => {
  const ci = readCi();

  it('AI-42 o workflow tem exatamente os jobs checks, test, workflows, api-fuzz (FND-16) e ci-ok, e o job commits deixou de existir', () => {
    expect(Object.keys(ci.jobs ?? {}).sort()).toEqual(CI_JOB_IDS);
  });

  it('AI-42 o ci-ok depende dos quatro jobs checks, test, workflows e api-fuzz', () => {
    expect(needsOf(jobOf(ci, 'ci-ok') ?? {}).sort()).toEqual([
      'api-fuzz',
      'checks',
      'test',
      'workflows',
    ]);
  });

  it('AI-42 o job checks se chama Checagens, não tem matriz e roda no Node do .nvmrc', () => {
    expect(checksJobViolations(ci)).toEqual([]);
  });

  it('AI-42 o job test se chama Node ${{ matrix.node }}, com a matriz [nvmrc, 24.12.0], fail-fast false e o reporter github-actions', () => {
    expect(testJobViolations(ci)).toEqual([]);
  });

  it('AI-42 checkout, setup-node e npm ci abrem os jobs checks e test', () => {
    expect([
      ...openingViolations(ci, 'checks'),
      ...openingViolations(ci, 'test'),
    ]).toEqual([]);
  });

  it('AI-42 cada checagem estática roda uma vez só no job checks, e nenhuma roda no test; o vitest, a tabela e os tipos do banco rodam só no test', () => {
    expect(placementViolations(ci)).toEqual([]);
  });

  it('AI-42 o npm audit signatures roda depois do npm ci, que instala o que ele confere', () => {
    const steps = stepsOfJob(ci, 'checks');
    const install = steps.findIndex((step) => step.run === 'npm ci');
    const signatures = steps.findIndex(
      (step) => step.run === 'npm audit signatures',
    );

    expect(install).toBeGreaterThanOrEqual(0);
    expect(signatures).toBeGreaterThan(install);
  });

  it('AI-42 as conferências de migrações, de scripts e de pisos recebem a base pelo env, e não interpolada no run', () => {
    const steps = stepsOfJob(ci, 'checks').filter((step) =>
      /^node scripts\/check-(?:migrations|scripts|baselines)\.ts$/.test(
        (step.run ?? '').trim(),
      ),
    );

    expect(steps).toHaveLength(3);
    for (const step of steps)
      expect(step.env?.BASE_REF).toBe('${{ github.base_ref }}');
  });

  it('AI-49 o check-baselines roda no job checks só em pull_request, com a base pelo env, pelo node e sem github.base_ref no run', () => {
    const steps = stepsOfJob(ci, 'checks').filter((step) =>
      /check-baselines/.test(step.run ?? ''),
    );

    expect(steps).toHaveLength(1);
    expect((steps[0]?.run ?? '').trim()).toBe(
      'node scripts/check-baselines.ts',
    );
    expect(steps[0]?.if ?? '').toMatch(PULL_REQUEST_ONLY);
    expect(steps[0]?.env?.BASE_REF).toBe('${{ github.base_ref }}');
    expect(steps[0]?.run ?? '').not.toContain('base_ref');
    // No job test só roda a conferência da medida (--measured), e nunca a da queda.
    expect(
      stepsOfJob(ci, 'test').filter(
        (s) =>
          /check-baselines/.test(s.run ?? '') &&
          !(s.run ?? '').includes('--measured'),
      ),
    ).toEqual([]);
  });

  it('AI-05 o check-lockfile roda no job checks pelo node, uma vez só, e não por npm run', () => {
    const steps = stepsOfJob(ci, 'checks').filter((step) =>
      /check-lockfile/.test(step.run ?? ''),
    );

    expect(steps).toHaveLength(1);
    expect((steps[0]?.run ?? '').trim()).toBe('node scripts/check-lockfile.ts');
    expect(prChecksThroughNpm(ci)).toEqual([]);
  });

  it('AI-05 as conferências do lockfile e dos pisos rodam depois do checkout e do npm ci (o job abre com eles)', () => {
    const steps = stepsOfJob(ci, 'checks');
    const install = steps.findIndex((step) => step.run === 'npm ci');
    const positions = ['check-lockfile', 'check-baselines'].map((name) =>
      steps.findIndex((step) => (step.run ?? '').includes(name)),
    );

    expect(install).toBeGreaterThanOrEqual(0);
    for (const position of positions) expect(position).toBeGreaterThan(install);
  });

  it('AI-49 a conferência de posição reprova o check-baselines sem o if de pull_request, e o check-lockfile ausente', () => {
    const withoutIf = parseWorkflow(
      GOOD_STRUCTURE.replace(
        "      - if: github.event_name == 'pull_request'\n        env:\n          BASE_REF: ${{ github.base_ref }}\n        run: node scripts/check-baselines.ts",
        '      - env:\n          BASE_REF: ${{ github.base_ref }}\n        run: node scripts/check-baselines.ts',
      ),
    );
    const withoutLockfile = parseWorkflow(
      GOOD_STRUCTURE.replace(
        '      - run: node scripts/check-lockfile.ts\n',
        '',
      ),
    );

    expect(placementViolations(withoutIf)).toEqual([
      'pisos e linha de base: não é restrito ao pull_request',
    ]);
    expect(placementViolations(withoutLockfile)).toEqual([
      'origem e integridade do lockfile: 0 passos no job checks, esperado 1',
    ]);
  });

  it('AI-42 o commitlint confere os commits do PR, da base ao topo, com --verbose', () => {
    const step = stepsOfJob(ci, 'checks').find((candidate) =>
      /commitlint/.test(candidate.run ?? ''),
    );

    expect(step?.run ?? '').toMatch(/--from\s+\S+\s+--to\s+\S+/);
    expect(step?.run ?? '').toContain('--verbose');
  });

  it('AI-42 o ci-ok depende de todos os outros jobs do arquivo, roda com always() e reprova em failure e cancelled', () => {
    expect(ciOkViolations(ci)).toEqual([]);
  });

  it('AI-42 o passo de shell do ci-ok sai com 0 em success e skipped, e com código diferente de 0 em failure e cancelled de qualquer job', () => {
    expect(ciOkBehaviorViolations(ci)).toEqual([]);
  });

  it('AI-42 nenhum passo do ci.yml repete teste que falhou (retry)', () => {
    expect(retryViolations(ci)).toEqual([]);
  });
});

describe('AI-05 os jobs checks e test conferem o PR pelo binário ou por node, e nunca por npm run', () => {
  const ci = readCi();

  it('AI-05 os dois jobs têm passos, para a conferência não passar no vazio', () => {
    expect(stepsOfJob(ci, 'checks').length).toBeGreaterThan(0);
    expect(stepsOfJob(ci, 'test').length).toBeGreaterThan(0);
  });

  it('AI-05 migrações, scripts, knip, jscpd, prettier, tipos do banco e a tabela não rodam por npm run, npm exec nem npx', () => {
    expect(prChecksThroughNpm(ci)).toEqual([]);
  });
});

// --- api-fuzz no CI do PR (FND-16) -------------------------------------------------------------------------------

interface FuzzWorkflow extends CiWorkflow {
  env?: Record<string, unknown>;
}

// O PR roda a versão leve: o job é a mesma conferência do agendado, mas sem semente nem número de exemplos no
// ambiente (valem os padrões fixos do compose, para a execução ser repetível), em paralelo (sem needs), sem
// condição (um job pulado conta como verde no ci-ok) e com o down pelo perfil fuzz.
function ciFuzzViolations(workflow: FuzzWorkflow): string[] {
  const job = jobOf(workflow, 'api-fuzz');
  const violations = apiFuzzJobViolations(job, 'default');
  if (job === undefined) return violations;
  if (job.name !== 'Fuzzing da API')
    violations.push(`nome ${String(job.name)}`);
  if (job.needs !== undefined)
    violations.push('tem needs: o fuzzing deve rodar em paralelo');
  if (job.if !== undefined)
    violations.push('tem if: um job pulado conta como verde no ci-ok');
  if (
    !/^docker compose --profile fuzz down\b/.test(
      (job.steps?.at(-1)?.run ?? '').trim(),
    )
  )
    violations.push('o último passo não é docker compose --profile fuzz down');
  for (const name of Object.keys(workflow.env ?? {}))
    if (/FUZZ_/.test(name)) violations.push(`o env do workflow define ${name}`);
  return violations;
}

// failure e cancelled do api-fuzz reprovam o ci-ok (o passo de shell, rodado como o GitHub o roda).
function ciOkRejectsFuzzViolations(workflow: CiWorkflow): string[] {
  const step = ciOkStep(workflow);
  if (!otherJobIds(workflow).includes('api-fuzz'))
    return ['falta o job api-fuzz'];
  if (step === undefined) return ['não tem um único passo run'];
  const allSuccess = Object.fromEntries(
    otherJobIds(workflow).map((id) => [id, 'success']),
  );
  const violations: string[] = [];
  for (const [result, passes] of [
    ['success', true],
    ['failure', false],
    ['cancelled', false],
  ] as const) {
    const env = envOfCiOk(step, { ...allSuccess, 'api-fuzz': result });
    if (env === null) return ['o passo não recebe o contexto needs pelo env'];
    if ((runStep(step, env) === 0) !== passes)
      violations.push(`api-fuzz ${result}: o ci-ok não decidiu certo`);
  }
  return violations;
}

const CI_FUZZ_JOB = `  api-fuzz:
    name: Fuzzing da API
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
${REPORT_DIR_STEP}      - name: Fuzzing com o Schemathesis
        run: docker compose --profile fuzz run --rm schemathesis
      - uses: actions/upload-artifact@${SHA}
        if: \${{ !cancelled() }}
        with:
          name: schemathesis-report
          path: schemathesis-report
          retention-days: 7
      - name: Derruba o compose e os volumes
        if: always()
        run: docker compose --profile fuzz down -v
`;

const GOOD_WITH_FUZZ = GOOD_STRUCTURE.replace(
  ciOkJob('checks, test, workflows'),
  () => CI_FUZZ_JOB + ciOkJob('checks, test, workflows, api-fuzz'),
);

// A edição atinge só o job api-fuzz, e não a primeira ocorrência do texto no arquivo.
function fuzzEdited(from: string, to: string): FuzzWorkflow {
  return parseWorkflow(
    GOOD_WITH_FUZZ.replace(CI_FUZZ_JOB, () => mutated(CI_FUZZ_JOB, from, to)),
  );
}

const FUZZ_DOWN = '        run: docker compose --profile fuzz down -v\n';

// Os controles que valem também no agendado estão em test/helpers/api-fuzz-job.ts; aqui ficam os do CI do PR: o
// nome, o paralelismo, a ausência de semente e de número de exemplos, e o `down` pelo perfil fuzz.
const CI_FUZZ_CASES: FuzzCase[] = [
  ...SHARED_FUZZ_CASES,
  ['com outro nome', 'name: Fuzzing da API', 'name: Fuzz'],
  [
    'com needs (não roda em paralelo)',
    '    runs-on: ubuntu-latest\n',
    '    needs: [checks]\n    runs-on: ubuntu-latest\n',
  ],
  [
    'com if no job (pode ser pulado)',
    '    runs-on: ubuntu-latest\n',
    "    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-latest\n",
  ],
  [
    'sem o checkout',
    `      - uses: actions/checkout@${SHA}\n        with:\n          persist-credentials: false\n`,
    '',
  ],
  [
    'com FUZZ_SEED no env do passo',
    FUZZ_STEP,
    `${FUZZ_STEP}        env:\n          FUZZ_SEED: \${{ github.run_id }}\n`,
  ],
  [
    'com FUZZ_SEED fixa no env do passo',
    FUZZ_STEP,
    `${FUZZ_STEP}        env:\n          FUZZ_SEED: '20261101'\n`,
  ],
  [
    'com FUZZ_MAX_EXAMPLES no env do passo',
    FUZZ_STEP,
    `${FUZZ_STEP}        env:\n          FUZZ_MAX_EXAMPLES: 500\n`,
  ],
  [
    'com FUZZ_SEED no env do job',
    '    timeout-minutes: 30\n',
    '    timeout-minutes: 30\n    env:\n      FUZZ_SEED: 1\n',
  ],
  [
    'com FUZZ_MAX_EXAMPLES no env do job',
    '    timeout-minutes: 30\n',
    '    timeout-minutes: 30\n    env:\n      FUZZ_MAX_EXAMPLES: 500\n',
  ],
  [
    'com a semente exportada no run',
    'run: docker compose --profile fuzz run --rm schemathesis',
    'run: |\n          export FUZZ_SEED=1\n          docker compose --profile fuzz run --rm schemathesis',
  ],
  [
    'com --seed no run',
    'run --rm schemathesis',
    'run --rm schemathesis --seed 1',
  ],
  [
    'com --max-examples no run',
    'run --rm schemathesis',
    'run --rm schemathesis --max-examples 500',
  ],
  [
    'sem o upload do relatório',
    `      - uses: actions/upload-artifact@${SHA}\n${FUZZ_UPLOAD_IF}        with:\n          name: schemathesis-report\n          path: schemathesis-report\n          retention-days: 7\n`,
    '',
  ],
  [
    'sem o docker compose down no fim',
    `      - name: Derruba o compose e os volumes\n        if: always()\n${FUZZ_DOWN}`,
    '',
  ],
  [
    'com o down sem o perfil fuzz',
    'docker compose --profile fuzz down -v',
    'docker compose down -v',
  ],
  [
    'com o down sem remover os volumes',
    'docker compose --profile fuzz down -v',
    'docker compose --profile fuzz down',
  ],
  ['com o down sem if', `        if: always()\n${FUZZ_DOWN}`, FUZZ_DOWN],
];

describe('FND-16 as conferências do api-fuzz do CI enxergam o que procuram (controle negativo)', () => {
  it('FND-16 a estrutura correta, com o ci-ok esperando o api-fuzz, passa em todas as conferências (controle positivo)', () => {
    const good = parseWorkflow(GOOD_WITH_FUZZ);

    expect(Object.keys(good.jobs ?? {}).sort()).toEqual(CI_JOB_IDS);
    expect(ciFuzzViolations(good)).toEqual([]);
    expect(ciOkViolations(good)).toEqual([]);
    expect(ciOkBehaviorViolations(good)).toEqual([]);
    expect(ciOkRejectsFuzzViolations(good)).toEqual([]);
    expect(retryViolations(good)).toEqual([]);
  });

  it('FND-16 sem o job api-fuzz, reprova', () => {
    const without = parseWorkflow(
      GOOD_WITH_FUZZ.replace(CI_FUZZ_JOB, () => '').replace(
        'checks, test, workflows, api-fuzz',
        () => 'checks, test, workflows',
      ),
    );

    expect(ciFuzzViolations(without)).toEqual(['falta o job api-fuzz']);
    expect(ciOkRejectsFuzzViolations(without)).toEqual([
      'falta o job api-fuzz',
    ]);
  });

  it('FND-16 o api-fuzz do CI que cria o schemathesis-report depois do fuzzing reprova', () => {
    const late = parseWorkflow(
      GOOD_WITH_FUZZ.replace(CI_FUZZ_JOB, () =>
        reportDirAfterFuzz(CI_FUZZ_JOB),
      ),
    );

    expect(ciFuzzViolations(late)).toEqual([
      'o diretório do relatório é criado depois do fuzzing',
    ]);
  });

  it.each(CI_FUZZ_CASES)(
    'FND-16 o api-fuzz do CI %s reprova',
    (_l, from, to) => {
      expect(ciFuzzViolations(fuzzEdited(from, to))).not.toEqual([]);
    },
  );

  it('FND-16 o env do workflow com FUZZ_SEED reprova', () => {
    const withEnv = parseWorkflow(
      mutated(GOOD_WITH_FUZZ, '\njobs:\n', '\nenv:\n  FUZZ_SEED: 1\njobs:\n'),
    ) as FuzzWorkflow;

    expect(ciFuzzViolations(withEnv)).not.toEqual([]);
  });

  it('FND-16 o api-fuzz com permissão de escrita reprova nas permissões do arquivo (AI-05)', () => {
    const write = fuzzEdited(
      '      contents: read\n',
      '      contents: write\n',
    );

    expect(
      Object.values(write.jobs ?? {}).flatMap((job) =>
        writeGrants(job.permissions),
      ),
    ).toEqual(['contents: write']);
  });

  it('FND-16 o ci-ok sem api-fuzz em needs reprova', () => {
    const missing = parseWorkflow(
      mutated(
        GOOD_WITH_FUZZ,
        'checks, test, workflows, api-fuzz',
        'checks, test, workflows',
      ),
    );

    expect(ciOkViolations(missing)).toEqual(['needs não tem api-fuzz']);
  });

  it('FND-16 o ci-ok que não reprova quando o api-fuzz falha ou é cancelado reprova no comportamento', () => {
    const lenient = parseWorkflow(
      mutated(
        GOOD_WITH_FUZZ,
        `if echo "$RESULTS" | grep -Eq '"result": *"(failure|cancelled)"'; then`,
        `if false; then`,
      ),
    );

    expect(ciOkRejectsFuzzViolations(lenient)).toEqual([
      'api-fuzz failure: o ci-ok não decidiu certo',
      'api-fuzz cancelled: o ci-ok não decidiu certo',
    ]);
  });
});

describe('FND-16 o ci.yml roda a versão leve do fuzzing num job próprio, em paralelo, e o ci-ok espera por ele', () => {
  const ci = readCi();

  it('FND-16 o job api-fuzz (Fuzzing da API) sobe o serviço schemathesis do perfil fuzz, guarda o relatório e derruba o compose com os volumes em qualquer resultado', () => {
    expect(ciFuzzViolations(ci)).toEqual([]);
  });

  it('FND-16 o job api-fuzz roda em paralelo aos outros: não depende de nenhum job e nenhum job depende dele além do ci-ok', () => {
    const others = Object.entries(ci.jobs ?? {}).filter(
      ([id]) => id !== 'api-fuzz' && id !== 'ci-ok',
    );

    expect(jobOf(ci, 'api-fuzz')).toBeDefined();
    expect(jobOf(ci, 'api-fuzz')?.needs).toBeUndefined();
    for (const [id, job] of others)
      expect(needsOf(job), id).not.toContain('api-fuzz');
  });

  it('FND-16 o PR não passa semente nem número de exemplos: vale o padrão fixo do compose, e a execução é repetível', () => {
    const job: FuzzJob | undefined = jobOf(ci, 'api-fuzz');
    const knobs = [
      ...Object.keys((ci as FuzzWorkflow).env ?? {}),
      ...Object.keys(job?.env ?? {}),
      ...(job?.steps ?? []).flatMap((step) => Object.keys(step.env ?? {})),
    ].filter((name) => /FUZZ_/.test(name));

    expect(job).toBeDefined();
    expect(knobs).toEqual([]);
  });

  it('FND-16 o ci-ok espera o api-fuzz e reprova quando ele termina em failure ou cancelled', () => {
    expect(needsOf(jobOf(ci, 'ci-ok') ?? {})).toContain('api-fuzz');
    expect(ciOkRejectsFuzzViolations(ci)).toEqual([]);
  });
});

// --- AI-49: a conferência da medida ---------------------------------------------------------------------------

const COVERAGE_FLAGS =
  '--coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reportsDirectory="$RUNNER_TEMP/coverage"';
const TEST_STEP = `      - run: npm test -- --reporter=default \${{ matrix.node == 'nvmrc' && '${COVERAGE_FLAGS}' || '' }}\n`;
const MEASURED_IF =
  "if: matrix.node == 'nvmrc' && github.event_name == 'pull_request'";
const MEASURED_PATH = '$RUNNER_TEMP/coverage/coverage-summary.json';
const MEASURED_STEP = `      - name: Cobertura medida contra o piso da base
        ${MEASURED_IF}
        env:
          BASE_REF: \${{ github.base_ref }}
        run: node scripts/check-baselines.ts --measured "${MEASURED_PATH}"
`;

function measuredWorkflow(steps: string): string {
  return `jobs:\n  test:\n    steps:\n      - run: npm ci\n${steps}`;
}

const GOOD_MEASURED = measuredWorkflow(TEST_STEP + MEASURED_STEP);

// O passo da medida lê o relatório que o passo do npm test grava: depois dele, só na perna do .nvmrc e no pull_request,
// com a base pelo env, e o caminho do --measured é o reportsDirectory (fora do repositório) mais /coverage-summary.json.
function measuredStepViolations(workflow: CiWorkflow): string[] {
  const steps = stepsOfJob(workflow, 'test');
  const measured = steps.filter((step) =>
    /check-baselines/.test(step.run ?? ''),
  );
  const [step] = measured;
  const testIndex = steps.findIndex((s) =>
    (s.run ?? '').includes('--coverage'),
  );
  if (measured.length !== 1 || step === undefined)
    return [`${measured.length} passos da medida, esperado 1`];
  const violations: string[] = [];
  const run = step.run ?? '';
  const condition = step.if ?? '';
  if (steps.indexOf(step) <= testIndex)
    violations.push('não vem depois do passo com --coverage');
  if (!NVMRC_ONLY.test(condition))
    violations.push('sem a condição da perna do .nvmrc');
  if (!PULL_REQUEST_ONLY.test(condition))
    violations.push('sem a condição de pull_request');
  if (step.env?.BASE_REF !== '${{ github.base_ref }}')
    violations.push('a base não vem pelo env BASE_REF');
  if (run.includes('base_ref')) violations.push('interpola base_ref no run');
  const testRun = steps[testIndex]?.run ?? '';
  if (!testRun.includes('--coverage.reporter=json-summary'))
    violations.push('o npm test não grava o reporter json-summary');
  const dir = /--coverage\.reportsDirectory=("?)(\S+?)\1(?:\s|'|$)/.exec(
    testRun,
  )?.[2];
  if (dir === undefined || !dir.startsWith('$RUNNER_TEMP/'))
    violations.push('o reportsDirectory não fica em $RUNNER_TEMP');
  const path = /--measured\s+"?([^"\s]+)"?/.exec(run)?.[1];
  if (path !== `${dir ?? ''}/coverage-summary.json`)
    violations.push('o caminho do --measured não é o reportsDirectory');
  return violations;
}

describe('AI-49 o job test confere a cobertura medida contra o piso da base', () => {
  it('AI-49 o ci.yml tem o passo da medida depois do npm test, na perna do .nvmrc e no pull_request, lendo o relatório do reportsDirectory', () => {
    expect(measuredStepViolations(readCi())).toEqual([]);
  });

  it('AI-49 o passo da medida roda pelo node, com a base pelo env e sem github.base_ref no run', () => {
    const [step] = stepsOfJob(readCi(), 'test').filter((s) =>
      /check-baselines/.test(s.run ?? ''),
    );

    expect((step?.run ?? '').trim()).toMatch(
      /^node scripts\/check-baselines\.ts --measured \S+$/,
    );
    expect(step?.env?.BASE_REF).toBe('${{ github.base_ref }}');
    expect(step?.run ?? '').not.toContain('base_ref');
  });

  it('AI-49 controle: a estrutura correta passa na conferência da medida', () => {
    expect(measuredStepViolations(parseWorkflow(GOOD_MEASURED))).toEqual([]);
  });

  const CASES: [label: string, from: string, to: string, expected: string][] = [
    [
      'o passo da medida ausente',
      MEASURED_STEP,
      '',
      '0 passos da medida, esperado 1',
    ],
    [
      'sem a condição da perna do .nvmrc',
      MEASURED_IF,
      "if: github.event_name == 'pull_request'",
      'sem a condição da perna do .nvmrc',
    ],
    [
      'sem a condição de pull_request',
      MEASURED_IF,
      "if: matrix.node == 'nvmrc'",
      'sem a condição de pull_request',
    ],
    [
      'o reportsDirectory dentro do repositório (coverage)',
      '--coverage.reportsDirectory="$RUNNER_TEMP/coverage"',
      '--coverage.reportsDirectory="coverage"',
      'o reportsDirectory não fica em $RUNNER_TEMP',
    ],
    [
      'sem o reporter json-summary',
      ' --coverage.reporter=json-summary',
      '',
      'o npm test não grava o reporter json-summary',
    ],
    [
      'o caminho do --measured diferente do reportsDirectory',
      `--measured "${MEASURED_PATH}"`,
      '--measured "$RUNNER_TEMP/outro/coverage-summary.json"',
      'o caminho do --measured não é o reportsDirectory',
    ],
    [
      'o caminho do --measured sem o nome coverage-summary.json',
      `--measured "${MEASURED_PATH}"`,
      '--measured "$RUNNER_TEMP/coverage/index.json"',
      'o caminho do --measured não é o reportsDirectory',
    ],
    [
      'sem a base pelo env',
      '        env:\n          BASE_REF: ${{ github.base_ref }}\n',
      '',
      'a base não vem pelo env BASE_REF',
    ],
    [
      'a base interpolada no run',
      `--measured "${MEASURED_PATH}"`,
      `--measured "${MEASURED_PATH}" --base \${{ github.base_ref }}`,
      'interpola base_ref no run',
    ],
  ];

  it.each(CASES)(
    'AI-49 controle negativo: %s reprova a conferência da medida',
    (_label, from, to, expected) => {
      const violations = measuredStepViolations(
        parseWorkflow(mutated(GOOD_MEASURED, from, to)),
      );

      expect(violations).toContain(expected);
    },
  );

  it('AI-49 controle negativo: o passo da medida antes do npm test reprova a conferência', () => {
    const violations = measuredStepViolations(
      parseWorkflow(measuredWorkflow(MEASURED_STEP + TEST_STEP)),
    );

    expect(violations).toContain('não vem depois do passo com --coverage');
  });
});
