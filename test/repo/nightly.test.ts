import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutated,
  parseYaml,
  readCi,
  readRepoYaml,
  same,
  stepsOfJob,
  stepsOfWorkflow,
  topPermissionViolations,
  unpinnedUses,
  workflowsDir,
  writeGrants,
  zizmorStepViolations,
  type CiJob,
  type CiStep,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';

// AI-46: o nightly.yml roda todo dia num minuto fora da hora cheia e por workflow_dispatch. O `main-full` repete o CI
// na main, o `flaky-hunt` roda a suíte embaralhada em três pernas, o `workflows` roda o zizmor na main e o `report`,
// depois dos três e em qualquer resultado, abre ou comenta a issue quando algum falha ou é cancelado e a fecha quando
// todos passam. AI-05: o topo só lê, e a escrita fica só no `report`. Cada conferência devolve as violações; a lista
// vazia é o que o arquivo deve ter, e os controles negativos montam um YAML de propósito errado.

interface NightlyJob extends CiJob {
  strategy?: {
    'fail-fast'?: unknown;
    matrix?: { node?: string[]; seed?: unknown };
  };
}

interface NightlyWorkflow extends CiWorkflow {
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown };
  jobs?: Record<string, NightlyJob>;
}

const SHA = 'c'.repeat(40);
const JOB_IDS = ['flaky-hunt', 'main-full', 'report', 'workflows'];
// O report espera todos os outros jobs, e roda em qualquer resultado deles.
const REPORT_NEEDS = ['main-full', 'flaky-hunt', 'workflows'];
const SEEDS = 3;

// Cada conferência que o `main-full` herda do job `checks` do ci.yml (AI-42), menos as que só valem em pull_request.
type Check = readonly [label: string, pattern: RegExp, run: string];

const MAIN_FULL_CHECKS: Check[] = [
  [
    'check-lockfile',
    /^node scripts\/check-lockfile\.ts$/,
    'node scripts/check-lockfile.ts',
  ],
  ['npm audit signatures', /^npm audit signatures$/, 'npm audit signatures'],
  ['lint', /^npm run lint$/, 'npm run lint'],
  [
    'prettier',
    /^node_modules\/\.bin\/prettier --check\b/,
    'node_modules/.bin/prettier --check .',
  ],
  ['typecheck', /^npm run typecheck$/, 'npm run typecheck'],
  [
    'knip',
    /^node_modules\/\.bin\/knip\b/,
    'node_modules/.bin/knip --no-progress',
  ],
  [
    'jscpd',
    /^node_modules\/\.bin\/jscpd\b/,
    'node_modules/.bin/jscpd --config .jscpd.json --baseline .jscpd-baseline.json --fail-on-new-clones',
  ],
  ['npm audit', /^npm audit --omit=dev$/, 'npm audit --omit=dev'],
  [
    'openapi --check',
    /^npm run openapi -- --check$/,
    'npm run openapi -- --check',
  ],
  ['lint:openapi', /^npm run lint:openapi$/, 'npm run lint:openapi'],
  [
    'check:instructions',
    /^npm run check:instructions$/,
    'npm run check:instructions',
  ],
  [
    'tipos do banco',
    /^node scripts\/check-db-types\.ts$/,
    'node scripts/check-db-types.ts',
  ],
];

const TEST_RUN = /^npm test(\s|$)/;
const PR_ONLY_STEP = /check-migrations|check-scripts|commitlint/;
const NOT_CANCELLED = /^(?:\$\{\{\s*)?!cancelled\(\)(?:\s*\}\})?$/;
const GITHUB_TOKEN =
  /^\$\{\{\s*(?:github\.token|secrets\.GITHUB_TOKEN)\s*\}\}$/;
const DAILY_CRON = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
// npm, npx ou node chamados como comando; "number" e "nodes" em texto não casam.
const RUNS_NODE_TOOL = /(^|[\s;&|(])(?:npm|npx|node|yarn|pnpm)(?=\s|$)/m;
// AI-05: o que confere algo do repositório roda o binário ou o arquivo de scripts/, nunca por npm run ou npx.
const REPO_CHECK_TOOLS =
  /check[-:](?:migrations|scripts|db-types|unused|duplication)|criteria-report|format:check|\b(?:knip|jscpd|prettier)\b/;
const THROUGH_PACKAGE_MANAGER = /\b(?:npm\s+(?:run|run-script|exec|x)|npx)\b/;

function needsOf(job: CiJob | undefined): string[] {
  const needs = job?.needs ?? [];
  return typeof needs === 'string' ? [needs] : needs;
}

// Valor de env ou with como texto; um objeto aninhado vira JSON e nunca casa com o esperado.
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function tokensOf(run: string): string[] {
  return run.split(/\s+/);
}

// --- gatilhos --------------------------------------------------------------------------------------------------

function triggerViolations(workflow: NightlyWorkflow): string[] {
  const triggers = workflow.on ?? {};
  const violations: string[] = [];
  const names = Object.keys(triggers).sort();
  if (names.join() !== 'schedule,workflow_dispatch')
    violations.push(
      `gatilhos [${names.join(', ')}], esperado schedule e workflow_dispatch`,
    );
  const schedule = triggers.schedule;
  if (!Array.isArray(schedule) || schedule.length !== 1)
    return [...violations, 'schedule não tem exatamente um cron'];
  const cron = String((schedule[0] as { cron?: unknown } | undefined)?.cron);
  const match = DAILY_CRON.exec(cron);
  if (match === null)
    violations.push(`cron ${cron} não é diário (minuto hora * * *)`);
  else if (Number(match[1]) === 0 || Number(match[1]) > 59)
    violations.push(`cron ${cron} cai na hora cheia ou fora do intervalo`);
  return violations;
}

// --- permissões (AI-05) -----------------------------------------------------------------------------------------

function permissionViolations(workflow: NightlyWorkflow): string[] {
  const violations = topPermissionViolations(workflow);
  if (!same(workflow.permissions, { contents: 'read' }))
    violations.push('o topo não é só contents: read');
  for (const id of ['main-full', 'flaky-hunt', 'workflows'])
    for (const grant of writeGrants(workflow.jobs?.[id]?.permissions))
      violations.push(`${id} roda código e tem ${grant}`);
  if (!same(workflow.jobs?.report?.permissions, { issues: 'write' }))
    violations.push('o job report não tem só issues: write');
  return violations;
}

// --- report ----------------------------------------------------------------------------------------------------

// Roda em qualquer resultado: com `failure()` ele não roda quando tudo passa e não fecha a issue; sem `always()`,
// um job que depende de outro que falhou é pulado.
function reportConditionViolations(job: NightlyJob): string[] {
  const condition = (job.if ?? '').trim();
  if (
    /\balways\(\)/.test(condition) &&
    !/\b(?:failure|success)\(\)/.test(condition)
  )
    return [];
  return [`if ${JSON.stringify(job.if)} não roda em qualquer resultado`];
}

// A decisão lê o resultado dos needs pelo env (nunca pela expressão no run), trata `failure` e `cancelled` como
// falha (o tempo esgotado chega como `cancelled`), fecha a issue quando tudo passa, e procura só a issue aberta pela
// conta do Actions.
function reportDecisionViolations(step: CiStep): string[] {
  const run = step.run ?? '';
  const violations: string[] = [];
  if (
    !/gh issue list\b/.test(run) ||
    !/--author[ =]app\/github-actions\b/.test(run)
  )
    violations.push('a busca da issue não filtra --author app/github-actions');
  if (!/gh issue close\b/.test(run))
    violations.push('não fecha a issue quando todos passam (gh issue close)');
  for (const result of ['failure', 'cancelled'])
    if (!new RegExp(`\\b${result}\\b`).test(run))
      violations.push(`a decisão não trata o resultado ${result}`);
  if (!Object.values(step.env ?? {}).some((v) => String(v).includes('needs')))
    violations.push('os resultados dos needs não chegam pelo env');
  return violations;
}

function reportEnvViolations(step: CiStep): string[] {
  const violations: string[] = [];
  const env = step.env ?? {};
  if (!GITHUB_TOKEN.test(text(env.GH_TOKEN)))
    violations.push('o GH_TOKEN não vem do github.token pelo env');
  if (text(env.GH_REPO) === '') violations.push('falta o GH_REPO no env');
  if (!Object.values(env).some((v) => String(v).includes('github.run_id')))
    violations.push('o link da execução (github.run_id) não vem pelo env');
  return violations;
}

function reportViolations(workflow: NightlyWorkflow): string[] {
  const job = workflow.jobs?.report;
  if (job === undefined) return ['falta o job report'];
  const violations = reportConditionViolations(job);
  for (const id of REPORT_NEEDS)
    if (!needsOf(job).includes(id)) violations.push(`needs não tem ${id}`);
  const steps = job.steps ?? [];
  for (const step of steps)
    if (/^actions\/(?:checkout|cache|setup-)/.test(step.uses ?? ''))
      violations.push(`o report baixa ou instala: ${step.uses}`);
  if (steps.some((step) => RUNS_NODE_TOOL.test(step.run ?? '')))
    violations.push('o report roda npm, npx ou node');
  const gh = steps.find((step) => /\bgh issue\b/.test(step.run ?? ''));
  if (gh === undefined) return [...violations, 'sem passo com gh issue'];
  const run = gh.run ?? '';
  if (run.includes('${{'))
    violations.push('interpola uma expressão no run (passe por env)');
  if (!/gh issue create\b/.test(run)) violations.push('não abre a issue');
  if (!/gh issue (?:comment|edit)\b/.test(run))
    violations.push('não atualiza a issue que já existe');
  return [
    ...violations,
    ...reportDecisionViolations(gh),
    ...reportEnvViolations(gh),
  ];
}

// --- passos de abertura de main-full e flaky-hunt ----------------------------------------------------------------

function checkoutViolations(step: CiStep | undefined, id: string): string[] {
  const violations: string[] = [];
  if (!(step?.uses ?? '').startsWith('actions/checkout@'))
    violations.push(`${id}: o primeiro passo não é o checkout`);
  if (step?.with?.ref !== 'main')
    violations.push(`${id}: o checkout não pede a ref main`);
  if (String(step?.with?.['persist-credentials']) !== 'false')
    violations.push(`${id}: o checkout guarda a credencial`);
  return violations;
}

function openingViolations(workflow: NightlyWorkflow, id: string): string[] {
  const [checkout, setup, install] = stepsOfJob(workflow, id);
  const violations = checkoutViolations(checkout, id);
  if (String(checkout?.with?.['fetch-depth']) !== '0')
    violations.push(`${id}: o checkout não baixa o histórico`);
  if (!(setup?.uses ?? '').startsWith('actions/setup-node@'))
    violations.push(`${id}: o segundo passo não é o setup-node`);
  if (setup?.with?.['node-version-file'] !== '.nvmrc')
    violations.push(`${id}: o setup-node não lê o .nvmrc`);
  if ((install?.run ?? '').trim() !== 'npm ci')
    violations.push(`${id}: o terceiro passo não é o npm ci`);
  return violations;
}

// --- main-full -------------------------------------------------------------------------------------------------

function mainFullViolations(workflow: NightlyWorkflow): string[] {
  const job = workflow.jobs?.['main-full'];
  if (job === undefined) return ['falta o job main-full'];
  const violations = openingViolations(workflow, 'main-full');
  if (job.name !== 'CI completo na main')
    violations.push(`nome ${String(job.name)}`);
  const steps = job.steps ?? [];
  for (const [label, pattern] of MAIN_FULL_CHECKS) {
    const found = steps.filter((step) => pattern.test((step.run ?? '').trim()));
    if (found.length !== 1)
      violations.push(`${label}: ${found.length} passos, esperado 1`);
    else if (found[0]?.if !== undefined)
      violations.push(`${label}: tem condição, e deve rodar sempre`);
  }
  const tests = steps.filter((step) => TEST_RUN.test((step.run ?? '').trim()));
  if (tests.length !== 1) violations.push(`${tests.length} passos npm test`);
  else if (!tokensOf(tests[0]?.run ?? '').includes('--coverage'))
    violations.push('o npm test não mede a cobertura (--coverage)');
  if (steps.some((step) => PR_ONLY_STEP.test(step.run ?? '')))
    violations.push('roda uma conferência que só vale em pull_request');
  return violations;
}

// --- workflows (zizmor na main) ----------------------------------------------------------------------------------

// A mesma zizmor-action do ci.yml, no mesmo SHA: uma action fixada pode ganhar um alerta sem commit nosso, e é o
// agendado que o pega. Checkout da main, sem guardar a credencial; o token de leitura vem da regra do zizmorStepViolations.
function zizmorJobViolations(
  workflow: NightlyWorkflow,
  ciZizmorUses: string | undefined,
): string[] {
  const steps = workflow.jobs?.workflows?.steps;
  if (steps === undefined) return ['falta o job workflows'];
  const zizmor = steps.find((step) =>
    (step.uses ?? '').startsWith('zizmorcore/zizmor-action@'),
  );
  const violations = [
    ...checkoutViolations(steps[0], 'workflows'),
    ...zizmorStepViolations(steps),
  ];
  if (ciZizmorUses === undefined || zizmor?.uses !== ciZizmorUses)
    violations.push(`a zizmor-action não é a do ci.yml (${ciZizmorUses})`);
  return violations;
}

// --- flaky-hunt ------------------------------------------------------------------------------------------------

function seedVariable(run: string): string | undefined {
  // Entre aspas duplas: o shellcheck do actionlint reprova a variável sem aspas (SC2086).
  const pattern = /--sequence\.seed="\$\{?([A-Za-z_]\w*)\}?"(?=\s|$)/;
  return pattern.exec(run)?.[1];
}

function shuffleRunViolations(job: NightlyJob): string[] {
  const steps = job.steps ?? [];
  const test = steps.find((step) =>
    /(^|\n)\s*npm test(\s|$)/.test(step.run ?? ''),
  );
  if (test === undefined) return ['sem passo npm test'];
  const run = test.run ?? '';
  const tokens = tokensOf(run);
  const violations: string[] = [];
  for (const flag of ['--sequence.shuffle.files', '--sequence.shuffle.tests'])
    if (!tokens.includes(flag) && !tokens.includes(`${flag}=true`))
      violations.push(`falta ${flag}`);
  for (const reporter of ['default', 'github-actions', 'json'])
    if (!tokens.includes(`--reporter=${reporter}`))
      violations.push(`falta --reporter=${reporter}`);
  const output = tokens.find((token) => token.startsWith('--outputFile.json='));
  if (output === undefined) violations.push('falta --outputFile.json=');
  else if (output.includes('$') && !/^--outputFile\.json="[^"]+"$/.test(output))
    violations.push(
      'o caminho do --outputFile.json deve ir entre aspas duplas',
    );
  if (run.includes('${{')) violations.push('interpola uma expressão no run');
  const name = seedVariable(run);
  if (name === undefined)
    return [...violations, 'a semente não vem de uma variável do env'];
  const value = text(test.env?.[name]);
  if (!value.includes('matrix.seed'))
    violations.push(`${name} não depende de matrix.seed`);
  if (!/github\.run_(?:id|number)/.test(value))
    violations.push(`${name} não depende da execução (github.run_id)`);
  const printed = new RegExp(`(?:echo|printf)[^\\n]*\\$\\{?${name}\\b`);
  if (!steps.some((step) => printed.test(step.run ?? '')))
    violations.push('a semente não é impressa no log');
  return violations;
}

function artifactViolations(job: NightlyJob): string[] {
  const steps = job.steps ?? [];
  const upload = steps.find((step) =>
    (step.uses ?? '').startsWith('actions/upload-artifact@'),
  );
  if (upload === undefined) return ['sem passo upload-artifact'];
  const violations: string[] = [];
  const testIndex = steps.findIndex((step) =>
    /(^|\n)\s*npm test(\s|$)/.test(step.run ?? ''),
  );
  if (testIndex < 0 || testIndex > steps.indexOf(upload))
    violations.push('o upload não vem depois do npm test');
  if (!NOT_CANCELLED.test((upload.if ?? '').trim()))
    violations.push(`if ${JSON.stringify(upload.if)} não é !cancelled()`);
  const days = Number(upload.with?.['retention-days']);
  if (!Number.isInteger(days) || days < 1 || days > 7)
    violations.push(`retention-days ${String(days)} fora de 1 a 7`);
  if (!String(upload.with?.name).includes('matrix.seed'))
    violations.push('o nome do artefato não muda por perna (matrix.seed)');
  if (text(upload.with?.path) === '')
    violations.push('o artefato não tem path');
  return violations;
}

function flakyHuntViolations(workflow: NightlyWorkflow): string[] {
  const job = workflow.jobs?.['flaky-hunt'];
  if (job === undefined) return ['falta o job flaky-hunt'];
  const violations = openingViolations(workflow, 'flaky-hunt');
  if (job.name !== 'Testes embaralhados (${{ matrix.seed }})')
    violations.push(`nome ${String(job.name)}`);
  if (job.strategy?.['fail-fast'] !== false)
    violations.push('fail-fast não é false');
  const seeds = job.strategy?.matrix?.seed;
  if (!Array.isArray(seeds) || new Set(seeds).size !== SEEDS)
    violations.push(`a matriz não tem ${SEEDS} sementes diferentes`);
  return [
    ...violations,
    ...shuffleRunViolations(job),
    ...artifactViolations(job),
  ];
}

// --- o arquivo todo --------------------------------------------------------------------------------------------

function workflowViolations(workflow: NightlyWorkflow): string[] {
  const steps = stepsOfWorkflow(workflow);
  const violations = unpinnedUses(steps).map((uses) => `sem SHA: ${uses}`);
  if (
    Object.keys(workflow.jobs ?? {})
      .sort()
      .join() !== JOB_IDS.join()
  )
    violations.push(`jobs [${Object.keys(workflow.jobs ?? {}).join(', ')}]`);
  if (steps.some((step) => /retr(?:y|ies)/i.test(JSON.stringify(step))))
    violations.push('repete teste que falhou (retry)');
  if (steps.some((step) => (step.run ?? '').includes('${{')))
    violations.push('um run interpola uma expressão (passe por env)');
  const throughNpm = steps
    .map((step) => step.run ?? '')
    .filter(
      (run) => REPO_CHECK_TOOLS.test(run) && THROUGH_PACKAGE_MANAGER.test(run),
    );
  if (throughNpm.length > 0)
    violations.push('uma conferência roda por npm run ou npx');
  const concurrency = workflow.concurrency;
  if (concurrency?.group === undefined)
    violations.push('falta o concurrency.group');
  if (
    ![undefined, false].includes(
      concurrency?.['cancel-in-progress'] as undefined,
    )
  )
    violations.push('o concurrency cancela a execução em andamento');
  return violations;
}

const GOOD_ZIZMOR_USES = `zizmorcore/zizmor-action@${SHA}`;

const ALL_CHECKS = (workflow: NightlyWorkflow): string[] => [
  ...triggerViolations(workflow),
  ...permissionViolations(workflow),
  ...reportViolations(workflow),
  ...mainFullViolations(workflow),
  ...flakyHuntViolations(workflow),
  ...zizmorJobViolations(workflow, GOOD_ZIZMOR_USES),
  ...workflowViolations(workflow),
];

// A zizmor-action do job `workflows` do ci.yml, de onde o nightly.yml tira o SHA.
function ciZizmorUses(): string | undefined {
  return stepsOfJob(readCi(), 'workflows').find((step) =>
    (step.uses ?? '').startsWith('zizmorcore/zizmor-action@'),
  )?.uses;
}

// --- linha de base em memória ----------------------------------------------------------------------------------

const CHECKOUT = `      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          ref: main
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@${SHA} # v7.1.0
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
`;

const UPLOAD = `      - uses: actions/upload-artifact@${SHA} # v4.6.2
        if: \${{ !cancelled() }}
        with:
          name: vitest-shuffle-\${{ matrix.seed }}
          path: \${{ runner.temp }}/vitest-shuffle.json
          retention-days: 7
`;

const GOOD = `
on:
  schedule:
    - cron: '23 6 * * *'
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: \${{ github.workflow }}
  cancel-in-progress: false
jobs:
  main-full:
    name: CI completo na main
    runs-on: ubuntu-latest
    steps:
${CHECKOUT}${MAIN_FULL_CHECKS.map(([, , run]) => `      - run: ${run}\n`).join('')}      - run: npm test -- --coverage
  flaky-hunt:
    name: Testes embaralhados (\${{ matrix.seed }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        seed: [1, 2, 3]
    steps:
${CHECKOUT}      - name: Testes embaralhados
        env:
          SHUFFLE_SEED: \${{ matrix.seed }}\${{ github.run_id }}
        run: |
          echo "Semente: $SHUFFLE_SEED"
          npm test -- --sequence.shuffle.files --sequence.shuffle.tests --sequence.seed="$SHUFFLE_SEED" --reporter=default --reporter=github-actions --reporter=json --outputFile.json="$RUNNER_TEMP/vitest-shuffle.json"
${UPLOAD}  workflows:
    name: Zizmor na main
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
        with:
          ref: main
          persist-credentials: false
      - uses: zizmorcore/zizmor-action@${SHA} # v0.8.0
        with:
          version: 1.31.1
          advanced-security: false
          token: \${{ github.token }}
  report:
    name: Abrir, comentar ou fechar a issue
    needs: [main-full, flaky-hunt, workflows]
    if: \${{ always() }}
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - name: Abre, comenta ou fecha a issue
        env:
          GH_TOKEN: \${{ github.token }}
          GH_REPO: \${{ github.repository }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
          RESULTS: \${{ toJSON(needs) }}
        run: |
          title="Execução agendada falhou"
          number=$(gh issue list --state open --author app/github-actions --search "$title in:title" --json number --jq '.[0].number // empty')
          if echo "$RESULTS" | grep -Eq '"result": *"(failure|cancelled)"'; then
            if [ -n "$number" ]; then
              gh issue comment "$number" --body "Falhou de novo: $RUN_URL"
            else
              gh issue create --title "$title" --body "Falhou: $RUN_URL"
            fi
          elif [ -n "$number" ]; then
            gh issue close "$number" --comment "Passou: $RUN_URL"
          fi
`;

function edited(from: string, to: string): NightlyWorkflow {
  return parseYaml<NightlyWorkflow>(mutated(GOOD, from, to));
}

// Os três primeiros jobs (main-full, flaky-hunt e workflows) abrem com o mesmo checkout; a edição da ocorrência de
// índice 1 atinge o flaky-hunt, e a de índice 2, o workflows.
function editedNth(from: string, to: string, nth: number): NightlyWorkflow {
  let at = -1;
  for (let seen = 0; seen <= nth; seen += 1) {
    at = GOOD.indexOf(from, at + 1);
    expect(
      at,
      `a linha de base não tem a ocorrência ${nth} de: ${from}`,
    ).toBeGreaterThan(-1);
  }
  return parseYaml<NightlyWorkflow>(
    GOOD.slice(0, at) + to + GOOD.slice(at + from.length),
  );
}

type Case = readonly [label: string, from: string, to: string];

const TRIGGER_CASES: Case[] = [
  [
    'com pull_request',
    '  workflow_dispatch:\n',
    '  workflow_dispatch:\n  pull_request:\n',
  ],
  [
    'com push',
    '  workflow_dispatch:\n',
    '  workflow_dispatch:\n  push:\n    branches: [main]\n',
  ],
  ['sem workflow_dispatch', '  workflow_dispatch:\n', ''],
  ['sem schedule', "  schedule:\n    - cron: '23 6 * * *'\n", ''],
  ['com o cron na hora cheia', "'23 6 * * *'", "'0 6 * * *'"],
  ['com o cron de hora em hora', "'23 6 * * *'", "'23 * * * *'"],
  [
    'com dois crons',
    "    - cron: '23 6 * * *'\n",
    "    - cron: '23 6 * * *'\n    - cron: '41 18 * * *'\n",
  ],
];

const MAIN_FULL_NAME = '    name: CI completo na main\n';
const FLAKY_NAME = '    name: Testes embaralhados (${{ matrix.seed }})\n';
const WORKFLOWS_NAME = '    name: Zizmor na main\n';
const REPORT_PERMISSIONS = '    permissions:\n      issues: write\n';

const PERMISSION_CASES: Case[] = [
  [
    'com contents: write no topo',
    'permissions:\n  contents: read\n',
    'permissions:\n  contents: write\n',
  ],
  ['sem permissions no topo', 'permissions:\n  contents: read\n', ''],
  [
    'com o main-full escrevendo contents',
    MAIN_FULL_NAME,
    `${MAIN_FULL_NAME}    permissions:\n      contents: write\n`,
  ],
  [
    'com o main-full escrevendo issues',
    MAIN_FULL_NAME,
    `${MAIN_FULL_NAME}    permissions:\n      issues: write\n`,
  ],
  [
    'com o main-full em write-all',
    MAIN_FULL_NAME,
    `${MAIN_FULL_NAME}    permissions: write-all\n`,
  ],
  [
    'com o flaky-hunt escrevendo issues',
    FLAKY_NAME,
    `${FLAKY_NAME}    permissions:\n      issues: write\n`,
  ],
  [
    'com o flaky-hunt escrevendo actions',
    FLAKY_NAME,
    `${FLAKY_NAME}    permissions:\n      actions: write\n`,
  ],
  [
    'com o workflows escrevendo issues',
    WORKFLOWS_NAME,
    `${WORKFLOWS_NAME}    permissions:\n      issues: write\n`,
  ],
  [
    'com o workflows escrevendo security-events',
    WORKFLOWS_NAME,
    `${WORKFLOWS_NAME}    permissions:\n      security-events: write\n`,
  ],
  [
    'com o report escrevendo contents',
    '      issues: write\n',
    '      issues: write\n      contents: write\n',
  ],
  [
    'com o report escrevendo pull-requests',
    '      issues: write\n',
    '      issues: write\n      pull-requests: write\n',
  ],
  [
    'com o report sem issues: write',
    '      issues: write\n',
    '      issues: read\n',
  ],
  ['com o report sem permissions', REPORT_PERMISSIONS, ''],
];

const REPORT_STEP = '      - name: Abre, comenta ou fecha a issue\n';
const NEEDS = '    needs: [main-full, flaky-hunt, workflows]\n';
const ALWAYS = '    if: ${{ always() }}\n';

const REPORT_CASES: Case[] = [
  [
    'com checkout',
    REPORT_STEP,
    `      - uses: actions/checkout@${SHA}\n${REPORT_STEP}`,
  ],
  [
    'com setup-node',
    REPORT_STEP,
    `      - uses: actions/setup-node@${SHA}\n${REPORT_STEP}`,
  ],
  ['com npm ci', REPORT_STEP, `      - run: npm ci\n${REPORT_STEP}`],
  [
    'com node',
    REPORT_STEP,
    `      - run: node scripts/criteria-report.ts\n${REPORT_STEP}`,
  ],
  ['sem o main-full em needs', NEEDS, '    needs: [flaky-hunt, workflows]\n'],
  ['sem o flaky-hunt em needs', NEEDS, '    needs: [main-full, workflows]\n'],
  [
    'sem o workflows (zizmor) em needs',
    NEEDS,
    '    needs: [main-full, flaky-hunt]\n',
  ],
  ['que só roda em failure()', ALWAYS, '    if: ${{ failure() }}\n'],
  [
    'que roda em qualquer resultado mas só com failure()',
    '${{ always() }}',
    '${{ always() && failure() }}',
  ],
  ['sem if', ALWAYS, ''],
  ['sem filtrar a issue pelo autor', ' --author app/github-actions', ''],
  [
    'que filtra a issue por outro autor',
    '--author app/github-actions',
    '--author roneyrogerio',
  ],
  [
    'que não fecha a issue quando tudo passa',
    'gh issue close',
    'gh issue view',
  ],
  ['que não trata o cancelled como falha', '(failure|cancelled)', '(failure)'],
  ['que não trata o failure como falha', '(failure|cancelled)', '(cancelled)'],
  [
    'sem os resultados dos needs no env',
    '          RESULTS: ${{ toJSON(needs) }}\n',
    '',
  ],
  ['sem o GH_TOKEN', '          GH_TOKEN: ${{ github.token }}\n', ''],
  [
    'com o GH_TOKEN fixo',
    'GH_TOKEN: ${{ github.token }}',
    'GH_TOKEN: ghp_0123456789abcdef0123456789abcdef0123',
  ],
  ['sem o GH_REPO', '          GH_REPO: ${{ github.repository }}\n', ''],
  [
    'sem o link da execução',
    '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}',
    '${{ github.server_url }}',
  ],
  [
    'com expressão no run',
    'Falhou de novo: $RUN_URL',
    'Falhou de novo: ${{ github.run_id }}',
  ],
  ['que só abre a issue', 'gh issue comment', 'gh issue view'],
  ['que só atualiza a issue', 'gh issue create', 'gh issue list'],
];

const SEED_RUN = '--sequence.seed="$SHUFFLE_SEED"';
const SEED_ENV =
  '          SHUFFLE_SEED: ${{ matrix.seed }}${{ github.run_id }}\n';
const CHECKOUT_USES = `actions/checkout@${SHA}`;

const FLAKY_CASES: Case[] = [
  ['com duas sementes', 'seed: [1, 2, 3]', 'seed: [1, 2]'],
  ['com sementes repetidas', 'seed: [1, 2, 3]', 'seed: [1, 2, 2]'],
  ['sem fail-fast: false', '      fail-fast: false\n', ''],
  ['com fail-fast ligado', 'fail-fast: false', 'fail-fast: true'],
  ['sem embaralhar os arquivos', ' --sequence.shuffle.files', ''],
  ['sem embaralhar os testes', ' --sequence.shuffle.tests', ''],
  ['com a semente fixa', SEED_RUN, '--sequence.seed=42'],
  [
    'com a semente interpolada no run',
    SEED_RUN,
    '--sequence.seed=${{ matrix.seed }}',
  ],
  [
    'com a semente que não muda por execução',
    SEED_ENV,
    '          SHUFFLE_SEED: ${{ matrix.seed }}\n',
  ],
  [
    'com a semente que não muda por perna',
    SEED_ENV,
    '          SHUFFLE_SEED: ${{ github.run_id }}\n',
  ],
  ['sem imprimir a semente', '          echo "Semente: $SHUFFLE_SEED"\n', ''],
  ['com a semente sem aspas no run', SEED_RUN, '--sequence.seed=$SHUFFLE_SEED'],
  [
    'com o caminho do relatório sem aspas',
    '--outputFile.json="$RUNNER_TEMP/vitest-shuffle.json"',
    '--outputFile.json=$RUNNER_TEMP/vitest-shuffle.json',
  ],
  ['sem o reporter github-actions', ' --reporter=github-actions', ''],
  ['sem o relatório JSON', ' --reporter=json', ''],
  ['sem o artefato', UPLOAD, ''],
  [
    'com o artefato retido por 30 dias',
    'retention-days: 7',
    'retention-days: 30',
  ],
  [
    'com o artefato sem retenção declarada',
    '          retention-days: 7\n',
    '',
  ],
  ['com o artefato sem !cancelled()', '        if: ${{ !cancelled() }}\n', ''],
  ['com o artefato só em sucesso', '${{ !cancelled() }}', '${{ success() }}'],
  [
    'com o artefato de nome igual nas três pernas',
    'name: vitest-shuffle-${{ matrix.seed }}',
    'name: vitest-shuffle',
  ],
];

// O checkout do flaky-hunt é o segundo do arquivo.
const FLAKY_CHECKOUT_CASES: Case[] = [
  ['com a ref diferente de main', 'ref: main', 'ref: develop'],
  ['sem o histórico', 'fetch-depth: 0', 'fetch-depth: 1'],
  [
    'com a credencial guardada',
    'persist-credentials: false',
    'persist-credentials: true',
  ],
];

const ZIZMOR_CASES: Case[] = [
  [
    'com a action em outro SHA que o do ci.yml',
    `zizmor-action@${SHA}`,
    `zizmor-action@${'d'.repeat(40)}`,
  ],
  ['com a action por tag', `zizmor-action@${SHA}`, 'zizmor-action@v0.8.0'],
  [
    'com o advanced-security ligado',
    'advanced-security: false',
    'advanced-security: true',
  ],
  ['sem o advanced-security', '          advanced-security: false\n', ''],
  [
    'com o token fixo',
    'token: ${{ github.token }}',
    'token: ghp_0123456789abcdef0123456789abcdef0123',
  ],
  ['sem o token', '          token: ${{ github.token }}\n', ''],
  ['com a version latest', 'version: 1.31.1', 'version: latest'],
  ['sem o job', '  workflows:\n', '  outro:\n'],
];

// O checkout do job workflows é o terceiro do arquivo.
const ZIZMOR_CHECKOUT_CASES: Case[] = [
  ['com a ref diferente de main', 'ref: main', 'ref: develop'],
  [
    'com a credencial guardada',
    'persist-credentials: false',
    'persist-credentials: true',
  ],
];

const MAIN_FULL_CASES: Case[] = [
  ...MAIN_FULL_CHECKS.map(([label, , run]): Case => [
    `sem a conferência ${label}`,
    `      - run: ${run}\n`,
    '',
  ]),
  ['sem a cobertura', 'npm test -- --coverage', 'npm test'],
  ['com a ref diferente de main', 'ref: main', 'ref: ${{ github.sha }}'],
  ['com o nome trocado', MAIN_FULL_NAME, '    name: Nightly\n'],
  [
    'com o commitlint, que só vale em pull_request',
    '      - run: npm test -- --coverage\n',
    '      - run: npx commitlint --from HEAD~1\n      - run: npm test -- --coverage\n',
  ],
  [
    'com a conferência de migrações, que só vale em pull_request',
    '      - run: npm test -- --coverage\n',
    '      - run: node scripts/check-migrations.ts\n      - run: npm test -- --coverage\n',
  ],
  [
    'com o knip por npx, e não pelo binário',
    '      - run: node_modules/.bin/knip --no-progress\n',
    '      - run: npx knip --no-progress\n',
  ],
  [
    'com o lint condicionado',
    '      - run: npm run lint\n',
    "      - if: github.event_name == 'push'\n        run: npm run lint\n",
  ],
];

const WORKFLOW_CASES: Case[] = [
  [
    'com --retry no npm test',
    'npm test -- --coverage',
    'npm test -- --coverage --retry=2',
  ],
  ['com uma action sem SHA', CHECKOUT_USES, 'actions/checkout@v7'],
  [
    'com um job a mais',
    'jobs:\n',
    'jobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo oi\n',
  ],
  [
    'com expressão num run',
    '      - run: npm run lint\n',
    '      - run: echo "${{ github.ref_name }}"\n      - run: npm run lint\n',
  ],
  [
    'com o concurrency cancelando',
    'cancel-in-progress: false',
    'cancel-in-progress: true',
  ],
  [
    'sem o concurrency',
    'concurrency:\n  group: ${{ github.workflow }}\n  cancel-in-progress: false\n',
    '',
  ],
];

describe('AI-46 as conferências do nightly.yml enxergam o que procuram (controle negativo)', () => {
  it('AI-46 o workflow correto passa em todas as conferências (controle positivo)', () => {
    expect(ALL_CHECKS(parseYaml<NightlyWorkflow>(GOOD))).toEqual([]);
  });

  it.each(TRIGGER_CASES)(
    'AI-46 o workflow %s reprova nos gatilhos',
    (_label, from, to) => {
      expect(triggerViolations(edited(from, to))).not.toEqual([]);
    },
  );

  it.each(PERMISSION_CASES)(
    'AI-05 o nightly.yml %s reprova nas permissões',
    (_label, from, to) => {
      expect(permissionViolations(edited(from, to))).not.toEqual([]);
    },
  );

  it.each(REPORT_CASES)('AI-46 o report %s reprova', (_label, from, to) => {
    expect(reportViolations(edited(from, to))).not.toEqual([]);
  });

  it.each(FLAKY_CASES)('AI-46 o flaky-hunt %s reprova', (_label, from, to) => {
    expect(flakyHuntViolations(edited(from, to))).not.toEqual([]);
  });

  it.each(FLAKY_CHECKOUT_CASES)(
    'AI-46 o checkout do flaky-hunt %s reprova',
    (_label, from, to) => {
      expect(
        flakyHuntViolations(
          editedNth(`          ${from}`, `          ${to}`, 1),
        ),
      ).not.toEqual([]);
    },
  );

  it.each(ZIZMOR_CASES)(
    'AI-46 o job workflows (zizmor) %s reprova',
    (_label, from, to) => {
      expect(
        zizmorJobViolations(edited(from, to), GOOD_ZIZMOR_USES),
      ).not.toEqual([]);
    },
  );

  it.each(ZIZMOR_CHECKOUT_CASES)(
    'AI-46 o checkout do job workflows (zizmor) %s reprova',
    (_label, from, to) => {
      expect(
        zizmorJobViolations(
          editedNth(`          ${from}`, `          ${to}`, 2),
          GOOD_ZIZMOR_USES,
        ),
      ).not.toEqual([]);
    },
  );

  it('AI-46 o job workflows sem a zizmor-action do ci.yml para comparar reprova', () => {
    expect(
      zizmorJobViolations(parseYaml<NightlyWorkflow>(GOOD), undefined),
    ).not.toEqual([]);
  });

  it.each(MAIN_FULL_CASES)(
    'AI-46 o main-full %s reprova',
    (_label, from, to) => {
      expect(mainFullViolations(edited(from, to))).not.toEqual([]);
    },
  );

  it.each(WORKFLOW_CASES)(
    'AI-46 o nightly.yml %s reprova',
    (_label, from, to) => {
      expect(workflowViolations(edited(from, to))).not.toEqual([]);
    },
  );
});

describe('AI-46 as checagens do main-full são as do job checks do ci.yml', () => {
  const ciChecks = stepsOfJob(readCi(), 'checks').filter(
    (step) => step.run !== undefined && step.if === undefined,
  );

  it('AI-46 cada checagem do main-full existe no job checks do ci.yml, sem condição', () => {
    const missing = MAIN_FULL_CHECKS.filter(
      ([label, pattern]) =>
        label !== 'tipos do banco' &&
        !ciChecks.some((step) => pattern.test((step.run ?? '').trim())),
    ).map(([label]) => label);

    expect(missing).toEqual([]);
  });

  it('AI-46 toda checagem sem condição do job checks do ci.yml entra no main-full', () => {
    const uncovered = ciChecks
      .map((step) => (step.run ?? '').trim())
      .filter(
        (run) =>
          run !== 'npm ci' &&
          !MAIN_FULL_CHECKS.some(([, pattern]) => pattern.test(run)),
      );

    expect(uncovered).toEqual([]);
  });
});

describe('AI-46 o nightly.yml do repositório', () => {
  const path = join(workflowsDir, 'nightly.yml');
  const workflow = (): NightlyWorkflow =>
    readRepoYaml<NightlyWorkflow>('.github', 'workflows', 'nightly.yml') ?? {};

  it('AI-46 o arquivo .github/workflows/nightly.yml existe', () => {
    expect(existsSync(path)).toBe(true);
  });

  it('AI-46 roda só por schedule, num cron diário fora da hora cheia, e por workflow_dispatch', () => {
    expect(triggerViolations(workflow())).toEqual([]);
  });

  it('AI-05 o topo só lê e só o report escreve, só issues: write', () => {
    expect(permissionViolations(workflow())).toEqual([]);
  });

  it('AI-05 nenhum job que roda código do nightly.yml tem permissão de escrita', () => {
    const writers = Object.entries(workflow().jobs ?? {})
      .filter(([, job]) => writeGrants(job.permissions).length > 0)
      .map(([id]) => id);

    expect(existsSync(path)).toBe(true);
    expect(writers).toEqual(['report']);
  });

  it('AI-46 o report roda em qualquer resultado depois dos três jobs, abre ou comenta a issue na falha e a fecha quando tudo passa, sem checkout nem instalação', () => {
    expect(reportViolations(workflow())).toEqual([]);
  });

  it('AI-46 o job workflows roda o zizmor na main pela mesma zizmor-action do ci.yml, com advanced-security false e o token do job', () => {
    expect(zizmorJobViolations(workflow(), ciZizmorUses())).toEqual([]);
  });

  it('AI-46 o main-full roda na main o CI do PR, a cobertura e os tipos do banco', () => {
    expect(mainFullViolations(workflow())).toEqual([]);
  });

  it('AI-46 o flaky-hunt roda a suíte embaralhada em três pernas e guarda o resultado num artefato curto', () => {
    expect(flakyHuntViolations(workflow())).toEqual([]);
  });

  it('AI-46 fixa toda action por SHA, não interpola contexto no run e não repete teste (retry)', () => {
    expect(workflowViolations(workflow())).toEqual([]);
  });
});
