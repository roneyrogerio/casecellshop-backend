import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  apiFuzzJobViolations,
  FUZZ_STEP,
  FUZZ_UPLOAD_IF,
  REPORT_DIR_STEP,
  reportDirAfterFuzz,
  reportDirBeforeCheckout,
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
  unpinnedUses,
  writeGrants,
  type CiJob,
  type CiStep,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';
import {
  cleanupTempDirs,
  git,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-42: o CI tem quatro jobs, e o ruleset exige só o `ci-ok`. `checks` roda uma vez o que não depende do Node,
// `test` é a matriz do FND-12, `workflows` confere os workflows (AI-43) e `ci-ok` agrega os outros três. Cada
// conferência devolve as violações; a lista vazia é o que o ci.yml deve ter, e os controles negativos montam um YAML
// de propósito errado para provar que ela enxerga o erro. FND-16: um quinto job, `api-fuzz`, roda a versão leve do
// fuzzing em paralelo, e o `ci-ok` espera por ele. AI-53: o job `changes` decide se o PR só muda documentação, e o
// `test` é pulado nesse caso; o `ci-ok` aceita o `test` pulado só com `docs_only == 'true'`.

afterAll(cleanupTempDirs);

// AI-53: o `changes` entra na lista dos jobs do ci.yml.
const JOB_IDS = ['changes', 'checks', 'ci-ok', 'test', 'workflows'];
// FND-16: o fuzzing leve do PR é um job a mais, em paralelo aos outros, e o ci-ok espera por ele.
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

// Checkout, setup-node e npm ci abrem o job; todo o resto vem depois deles. O passo de troca por pastas do AI-53 (que o `test`
// tem logo depois do checkout) fica fora desta conta; a posição dele é conferida por cleanupViolations.
function openingViolations(workflow: CiWorkflow, id: string): string[] {
  const steps = stepsOfJob(workflow, id).filter(
    (step) => step.name !== CLEANUP_NAME,
  );
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
const DOCS_ONLY_ENV = /^\$\{\{\s*needs\.changes\.outputs\.docs_only\s*\}\}$/;

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
  // AI-53: o job pulado conta como verde, então o passo lê o RESULTS com jq e aceita só o que o critério lista:
  // `success`, e `skipped` do test e do api-fuzz com a saída docs_only do changes. A regra não nomeia failure nem
  // cancelled: qualquer outro resultado reprova, e o comportamento prova cada um.
  if (!DOCS_ONLY_ENV.test(String(step.env?.DOCS_ONLY)))
    violations.push(
      'o env DOCS_ONLY não vem de needs.changes.outputs.docs_only',
    );
  for (const word of ['success', 'skipped', 'jq', 'DOCS_ONLY'])
    if (!run.includes(word)) violations.push(`o run não cita ${word}`);
  if (!run.includes('length > 0'))
    violations.push('o run não exige length > 0 no RESULTS');
  return violations;
}

// O passo recebe o contexto `needs` por env, como o GitHub o entrega: JSON com o resultado de cada job, e a saída
// docs_only do `changes` (AI-53). `docsOnly` é o texto que o GitHub poria na saída: 'true', 'false' ou '' (sem saída).
function envOfCiOk(
  step: CiStep,
  results: Record<string, string>,
  docsOnly = 'false',
): Record<string, string> | null {
  const needs = Object.fromEntries(
    Object.entries(results).map(([id, result]) => [
      id,
      { result, outputs: id === 'changes' ? { docs_only: docsOnly } : {} },
    ]),
  );
  const env: Record<string, string> = {};
  let received = false;
  for (const [name, raw] of Object.entries(step.env ?? {})) {
    const value = String(raw);
    if (NEEDS_AS_JSON.test(value)) {
      env[name] = JSON.stringify(needs, null, 2);
      received = true;
    } else if (DOCS_ONLY_ENV.test(value)) {
      env[name] = docsOnly;
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

interface OkCase {
  label: string;
  results: Record<string, string>;
  docsOnly: string;
  passes: boolean;
}

function runOkCases(step: CiStep, cases: OkCase[]): string[] {
  const violations: string[] = [];
  for (const { label, results, docsOnly, passes } of cases) {
    const env = envOfCiOk(step, results, docsOnly);
    if (env === null) return ['o passo não recebe o contexto needs pelo env'];
    const status = runStep(step, env);
    if ((status === 0) !== passes)
      violations.push(
        `${label}: saiu com ${String(status)}, esperado ${passes ? '0' : 'diferente de 0'}`,
      );
  }
  return violations;
}

// failure, cancelled e um resultado desconhecido (neutral) de qualquer job reprovam, e tudo success passa. O skipped
// tem a regra própria do AI-53, em ciOkSkipViolations; o RESULTS sem result ou fora do formato, em ciOkShapeViolations.
function ciOkBehaviorViolations(workflow: CiWorkflow): string[] {
  const step = ciOkStep(workflow);
  if (step === undefined) return ['não tem um único passo run'];
  const ids = otherJobIds(workflow);
  const allSuccess = Object.fromEntries(ids.map((id) => [id, 'success']));
  const docsOnly = 'false';
  return runOkCases(step, [
    { label: 'tudo success', results: allSuccess, docsOnly, passes: true },
    ...ids.flatMap((id) => [
      {
        label: `${id} failure`,
        results: { ...allSuccess, [id]: 'failure' },
        docsOnly,
        passes: false,
      },
      {
        label: `${id} cancelled`,
        results: { ...allSuccess, [id]: 'cancelled' },
        docsOnly,
        passes: false,
      },
      {
        label: `${id} neutral`,
        results: { ...allSuccess, [id]: 'neutral' },
        docsOnly,
        passes: false,
      },
    ]),
  ]);
}

// Os jobs que o docs_only pode pular (AI-53): o `test` e o `api-fuzz`.
const SKIPPABLE = ['test', 'api-fuzz'];

// AI-53: um job pulado só passa quando o `changes` disse docs_only == 'true' e o job é o `test` ou o `api-fuzz`. Com
// 'false' ou sem a saída, qualquer pulado reprova; com 'true', o pulado de outro job (inclusive o `checks` e o
// `changes`) reprova; e a falha ou o cancelamento de outro job reprova mesmo com o `test` pulado.
function ciOkSkipViolations(workflow: CiWorkflow): string[] {
  const step = ciOkStep(workflow);
  if (step === undefined) return ['não tem um único passo run'];
  const ids = otherJobIds(workflow);
  if (!ids.includes('test')) return ['falta o job test'];
  const allSuccess = Object.fromEntries(ids.map((id) => [id, 'success']));
  const skippable = ids.filter((id) => SKIPPABLE.includes(id));
  const skippedAll = {
    ...allSuccess,
    ...Object.fromEntries(skippable.map((id) => [id, 'skipped'])),
  };
  const others = ids.filter((id) => !SKIPPABLE.includes(id));
  return runOkCases(step, [
    {
      label: `${skippable.join(' e ')} skipped com docs_only true`,
      results: skippedAll,
      docsOnly: 'true',
      passes: true,
    },
    ...skippable.map((id) => ({
      label: `só o ${id} skipped com docs_only true`,
      results: { ...allSuccess, [id]: 'skipped' },
      docsOnly: 'true',
      passes: true,
    })),
    ...skippable.flatMap((id) =>
      ['false', ''].map((docsOnly) => ({
        label: `${id} skipped com docs_only ${docsOnly === '' ? 'ausente' : docsOnly}`,
        results: { ...allSuccess, [id]: 'skipped' },
        docsOnly,
        passes: false,
      })),
    ),
    {
      label: 'test success com docs_only false',
      results: allSuccess,
      docsOnly: 'false',
      passes: true,
    },
    ...others.flatMap((id) =>
      ['true', 'false'].map((docsOnly) => ({
        label: `${id} skipped com docs_only ${docsOnly}`,
        results: { ...allSuccess, [id]: 'skipped' },
        docsOnly,
        passes: false,
      })),
    ),
    ...others.flatMap((id) =>
      ['failure', 'cancelled'].map((result) => ({
        label: `test skipped com docs_only true e ${id} ${result}`,
        results: { ...skippedAll, [id]: result },
        docsOnly: 'true',
        passes: false,
      })),
    ),
  ]);
}

// AI-53 (caso de borda): um RESULTS que não é JSON reprova o ci-ok, com docs_only true e com false.
const INVALID_RESULTS: ReadonlyArray<readonly [label: string, raw: string]> = [
  ['RESULTS lixo', 'lixo'],
  ['RESULTS com JSON cortado', '{"checks": {"result": "success"'],
  ['RESULTS vazio', ''],
];

// AI-53 (achado A2): um RESULTS que é JSON mas não descreve os jobs também reprova. A regra aceita só o que lista, então
// um job sem `result`, um `result` desconhecido, um objeto vazio e um job que não é objeto saem com código diferente
// de 0; o `ci-ok` por lista de proibidos aprovava todos eles.
const SHAPE_RESULTS: ReadonlyArray<readonly [label: string, raw: string]> = [
  ['RESULTS {} sem nenhum job', '{}'],
  ['RESULTS com um job sem result', '{"test":{}}'],
  ['RESULTS com result neutral', '{"test":{"result":"neutral"}}'],
  ['RESULTS com result desconhecido', '{"test":{"result":"desconhecido"}}'],
  ['RESULTS com um job que não é objeto', '{"test":1}'],
  [
    'RESULTS com success e um job sem result',
    '{"checks":{"result":"success"},"test":{}}',
  ],
  [
    'RESULTS com success e um job neutral',
    '{"checks":{"result":"success"},"test":{"result":"neutral"}}',
  ],
];

function ciOkInvalidResultsViolations(workflow: CiWorkflow): string[] {
  return ciOkRawResultsViolations(workflow, INVALID_RESULTS);
}

function ciOkShapeViolations(workflow: CiWorkflow): string[] {
  return ciOkRawResultsViolations(workflow, SHAPE_RESULTS);
}

function ciOkRawResultsViolations(
  workflow: CiWorkflow,
  cases: ReadonlyArray<readonly [label: string, raw: string]>,
): string[] {
  const step = ciOkStep(workflow);
  if (step === undefined) return ['não tem um único passo run'];
  const name = Object.entries(step.env ?? {}).find(([, value]) =>
    NEEDS_AS_JSON.test(String(value)),
  )?.[0];
  if (name === undefined)
    return ['o passo não recebe o contexto needs pelo env'];
  const allSuccess = Object.fromEntries(
    otherJobIds(workflow).map((id) => [id, 'success']),
  );
  const violations: string[] = [];
  for (const docsOnly of ['true', 'false']) {
    const valid = envOfCiOk(step, allSuccess, docsOnly);
    if (valid === null) return ['o passo não recebe o contexto needs pelo env'];
    // Sem este controle um jq que falta na máquina (saída 127) passaria por "reprovou".
    if (runStep(step, valid) !== 0 && docsOnly === 'false')
      violations.push('tudo success não saiu com 0');
    for (const [label, raw] of cases) {
      const status = runStep(step, { ...valid, [name]: raw });
      if (status === 0)
        violations.push(
          `${label} com docs_only ${docsOnly}: saiu com 0, esperado diferente de 0`,
        );
    }
  }
  return violations;
}

// --- linhas de base em memória ----------------------------------------------------------------------------------

// AI-53 (achado A2): o ci-ok aceita só o que a regra lista, em vez de reprovar uma lista de proibidos. O `jq -e` dentro
// de `if !` trata o erro do jq (saída 5, como em `{"test":1}`) como "não passou"; a guarda antes exige um objeto com
// pelo menos um job, porque `all` de um objeto vazio é verdadeiro e `{}` aprovaria o ci-ok.
const OK_FILTER = `.value.result == "success" or (.value.result == "skipped" and $docs == "true" and (.key == "test" or .key == "api-fuzz"))`;
const CI_OK_RULE_LINE = `if ! echo "$RESULTS" | jq -e --arg docs "$DOCS_ONLY" 'all(to_entries[]; ${OK_FILTER})' > /dev/null; then`;
const CI_OK_JSON_GUARD = `echo "$RESULTS" | jq -e 'type == "object" and length > 0' > /dev/null || { echo "O RESULTS não é o JSON do needs."; exit 1; }`;

// A mesma regra com a polaridade errada: o `if jq -e` sai com 5 diante de um texto que não é JSON, e o `if` lê isso
// como "nenhum job reprova"; sem a guarda antes, um RESULTS quebrado aprovaria o ci-ok.
const CI_OK_FAIL_OPEN_RULE_LINE = `if echo "$RESULTS" | jq -e --arg docs "$DOCS_ONLY" 'any(to_entries[]; (${OK_FILTER}) | not)' > /dev/null; then`;

const ciOkJob = (needs: string): string => `  ci-ok:
    name: ci-ok
    needs: [${needs}]
    if: always()
    steps:
      - env:
          RESULTS: \${{ toJSON(needs) }}
          DOCS_ONLY: \${{ needs.changes.outputs.docs_only }}
        run: |
          ${CI_OK_JSON_GUARD}
          ${CI_OK_RULE_LINE}
            echo "Um job não passou: falhou, foi cancelado, foi pulado sem o changes dizer que só há documentação ou tem um resultado desconhecido."
            exit 1
          fi
`;

// O ci-ok anterior ao A2, por lista de proibidos: reprova só failure, cancelled e o pulado fora da regra. É o controle
// de comportamento: `{"test":{}}` e `neutral` saem com 0, e as conferências acusam.
const LEGACY_FAILURE_LINE = `if echo "$RESULTS" | jq -e 'any(.[]; .result | test("^(failure|cancelled)$"))' > /dev/null; then`;
const LEGACY_SKIP_LINE = `if echo "$RESULTS" | jq -e --arg docs "$DOCS_ONLY" 'any(to_entries[]; .value.result == "skipped" and ($docs != "true" or (.key != "test" and .key != "api-fuzz")))' > /dev/null; then`;
const LEGACY_JSON_GUARD = `echo "$RESULTS" | jq -e 'type == "object"' > /dev/null || { echo "O RESULTS não é o JSON do needs."; exit 1; }`;

const legacyCiOkJob = (needs: string): string => `  ci-ok:
    name: ci-ok
    needs: [${needs}]
    if: always()
    steps:
      - env:
          RESULTS: \${{ toJSON(needs) }}
          DOCS_ONLY: \${{ needs.changes.outputs.docs_only }}
        run: |
          ${LEGACY_JSON_GUARD}
          ${LEGACY_FAILURE_LINE}
            echo "Um job falhou ou foi cancelado."
            exit 1
          fi
          ${LEGACY_SKIP_LINE}
            echo "Um job foi pulado sem o changes dizer que só há documentação."
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
  changes:
    steps:
      - run: echo changes
${ciOkJob('checks, test, changes')}`;

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
    expect(ciOkSkipViolations(good)).toEqual([]);
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
        variant((t) =>
          t.replace('needs: [checks, test, changes]', 'needs: [checks, test]'),
        ),
      ),
    ).toEqual(['needs não tem changes']);
    expect(
      ciOkViolations(
        variant((t) =>
          t.replace('needs: [checks, test, changes]', 'needs: [checks]'),
        ),
      ),
    ).not.toEqual([]);
    expect(
      ciOkViolations(
        variant((t) => `${t}  extra:\n    steps:\n      - run: echo\n`),
      ),
    ).toEqual(['needs não tem extra']);
  });

  // A regra do ci-ok não nomeia failure nem cancelled (aceita só o que lista), então a forma não os exige; o que prova
  // que cada um reprova é o comportamento do passo.
  const ACCEPTS_SUCCESS = '.value.result == "success" or';

  it('AI-42 um ci-ok que aceita cancelled reprova no comportamento, mesmo citando a palavra num comentário', () => {
    const acceptsCancelled = variant((t) =>
      t.replace(
        ACCEPTS_SUCCESS,
        () => `${ACCEPTS_SUCCESS} .value.result == "cancelled" or`,
      ),
    );
    const mentionsOnly = variant((t) =>
      t
        .replace(
          ACCEPTS_SUCCESS,
          () => `${ACCEPTS_SUCCESS} .value.result == "cancelled" or`,
        )
        .replace('then\n', 'then # cancelled\n'),
    );

    expect(ciOkViolations(acceptsCancelled)).toEqual([]);
    expect(ciOkViolations(mentionsOnly)).toEqual([]);
    expect(ciOkBehaviorViolations(acceptsCancelled)).toEqual([
      'checks cancelled: saiu com 0, esperado diferente de 0',
      'test cancelled: saiu com 0, esperado diferente de 0',
      'changes cancelled: saiu com 0, esperado diferente de 0',
    ]);
    expect(ciOkBehaviorViolations(mentionsOnly)).not.toEqual([]);
  });

  it('AI-42 um ci-ok que aceita failure, ou um resultado desconhecido (neutral), ou que reprova sempre, reprova no comportamento', () => {
    expect(
      ciOkBehaviorViolations(
        variant((t) =>
          t.replace(
            ACCEPTS_SUCCESS,
            () => `${ACCEPTS_SUCCESS} .value.result == "failure" or`,
          ),
        ),
      ),
    ).toEqual([
      'checks failure: saiu com 0, esperado diferente de 0',
      'test failure: saiu com 0, esperado diferente de 0',
      'changes failure: saiu com 0, esperado diferente de 0',
    ]);
    expect(
      ciOkBehaviorViolations(
        variant((t) =>
          t.replace(
            ACCEPTS_SUCCESS,
            () => `${ACCEPTS_SUCCESS} .value.result == "neutral" or`,
          ),
        ),
      ),
    ).toEqual([
      'checks neutral: saiu com 0, esperado diferente de 0',
      'test neutral: saiu com 0, esperado diferente de 0',
      'changes neutral: saiu com 0, esperado diferente de 0',
    ]);
    expect(
      ciOkBehaviorViolations(
        variant((t) =>
          t.replace(ACCEPTS_SUCCESS, () => '.value.result == "x" or'),
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

const SHA = 'a'.repeat(40);

// --- AI-53: o job changes e o pulo do test ----------------------------------------------------------------------

// A lista exata do critério. O teste de repositório docs-only-paths.test.ts lê a lista do ci.yml, e não esta.
const DOCS_PATHS = [
  'README.md',
  '.specs/README.md',
  '.specs/codebase/CONVENTIONS.md',
  '.specs/features/casecellshop/design.md',
  '.specs/project/PROJECT.md',
  '.specs/project/ROADMAP.md',
  '.specs/project/STATE.md',
  '.specs/project/STATE-ARCHIVE.md',
];
const DOCS_PATHS_TEXT = `${DOCS_PATHS.join('\n')}\n`;

// O passo `decide` de referência: a implementação correta do critério, para provar que a tabela de casos aceita o que
// pede e para os controles de comportamento mutarem. O ci.yml real tem a sua própria; a tabela roda nas duas.
// O `grep -F` trata um padrão com quebra de linha como vários padrões (um por linha), então o arquivo `README.md⏎x`
// casaria com a linha `README.md` da lista. Por isso o nome com quebra de linha é recusado antes do `grep`.
const GREP_MATCH_LINE = String.raw`    printf '%s\n' "$DOCS_ONLY_PATHS" | grep -qxF -- "$file" || docs_only=false`;
const MATCH_LINE = String.raw`    case "$file" in *$'\n'*) docs_only=false ;; *) printf '%s\n' "$DOCS_ONLY_PATHS" | grep -qxF -- "$file" || docs_only=false ;; esac`;
const DECIDE_RUN = String.raw`list=$(mktemp)
git diff --name-only --no-renames -z HEAD^1 HEAD > "$list"
docs_only=false
if [ "$EVENT_NAME" = "pull_request" ] && git rev-parse --verify --quiet "HEAD^2" > /dev/null && [ -s "$list" ]; then
  docs_only=true
  while IFS= read -r -d '' file; do
${MATCH_LINE}
  done < "$list"
fi
echo "docs_only=$docs_only" >> "$GITHUB_OUTPUT"
`;

function indent(block: string, spaces: number): string {
  return block
    .trimEnd()
    .split('\n')
    .map((line) => `${' '.repeat(spaces)}${line}`)
    .join('\n');
}

const CHANGES_JOB = `  changes:
    name: Mudanças do PR
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      docs_only: \${{ steps.decide.outputs.docs_only }}
    steps:
      - uses: actions/checkout@${SHA}
        with:
          fetch-depth: 2
          persist-credentials: false
      - id: decide
        env:
          EVENT_NAME: \${{ github.event_name }}
        run: |
${indent(DECIDE_RUN, 10)}
`;

// A lista mora no env do topo do workflow, e todo job a enxerga: o `decide` a compara com o diff, e os jobs que o
// docs_only pode pular apagam os arquivos dela do checkout, para o resultado deles não depender desses arquivos.
const TOP_ENV = `env:
  DOCS_ONLY_PATHS: |
${indent(DOCS_PATHS_TEXT, 4)}
`;

const NEEDS_BASE = 'changes, checks, test, workflows';
const NEEDS_WITH_FUZZ = `${NEEDS_BASE}, api-fuzz`;

const CLEANUP_NAME = 'Troca os arquivos que o AI-53 não testa por pastas';
// AI-53 (achado A1): só apagar o arquivo deixa passar um teste que lista a pasta e lê o que achou (o arquivo some da
// listagem); uma pasta vazia de mesmo nome fica na listagem, e a leitura reprova com EISDIR. O `rm -f --` tira o
// arquivo ou o link (sem seguir o link) e o `mkdir -p --` cria a pasta, com a pasta pai quando falta. Uma pasta que já
// está lá (segunda execução) fica como está: `rm -f` numa pasta reprovaria o passo. `if` em vez de `&&`: com o
// bash -e, o laço que termina numa linha vazia sairia com 1 e reprovaria o passo.
const CLEANUP_RUN = String.raw`printf '%s\n' "$DOCS_ONLY_PATHS" | while IFS= read -r path; do
  if [ -n "$path" ] && { [ -L "$path" ] || [ ! -d "$path" ]; }; then rm -f -- "$path"; mkdir -p -- "$path"; fi
done`;
// O passo anterior ao A1, que só apagava: o controle de comportamento do teste inventado.
const DELETE_ONLY_RUN = String.raw`printf '%s\n' "$DOCS_ONLY_PATHS" | while IFS= read -r path; do
  if [ -n "$path" ]; then rm -f -- "$path"; fi
done`;
const CLEANUP_STEP = `      - name: ${CLEANUP_NAME}
        run: |
${indent(CLEANUP_RUN, 10)}
`;

interface DocsStep extends CiStep {
  id?: string;
}

interface DocsWorkflow extends CiWorkflow {
  env?: Record<string, unknown>;
}

interface DocsJob extends CiJob {
  'runs-on'?: unknown;
  outputs?: Record<string, unknown>;
  steps?: DocsStep[];
}

const DOCS_OUTPUT = /^\$\{\{\s*steps\.decide\.outputs\.docs_only\s*\}\}$/;
const EVENT_NAME_ENV = /^\$\{\{\s*github\.event_name\s*\}\}$/;
const DOCS_IF =
  /^(?:\$\{\{\s*)?needs\.changes\.outputs\.docs_only\s*!=\s*'true'(?:\s*\}\})?$/;

function decideStepOf(workflow: CiWorkflow): DocsStep | undefined {
  const job: DocsJob | undefined = jobOf(workflow, 'changes');
  return job?.steps?.find((step) => step.id === 'decide');
}

// O texto da lista como está no env do topo do workflow ('' quando não há).
function docsPathsTextOf(workflow: DocsWorkflow): string {
  const value = workflow.env?.DOCS_ONLY_PATHS;
  return typeof value === 'string' ? value : '';
}

function docsPathsOf(workflow: DocsWorkflow): string[] {
  return docsPathsTextOf(workflow)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

// O passo `decide` com a lista do env do topo, como o job a recebe do workflow.
function decideStepWithList(workflow: DocsWorkflow): DecideStep | undefined {
  const decide = decideStepOf(workflow);
  return decide === undefined
    ? undefined
    : {
        run: decide.run ?? '',
        env: { ...decide.env, DOCS_ONLY_PATHS: docsPathsTextOf(workflow) },
      };
}

// A linha do `git diff` do run, sem os comentários e com as continuações de linha (`\`) juntas.
function diffLineOf(run: string): string | undefined {
  return run
    .replaceAll(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .find((line) => /\bgit\b/.test(line) && /\bdiff\b/.test(line));
}

function diffViolations(run: string): string[] {
  const line = diffLineOf(run);
  if (line === undefined) return ['o run não tem o git diff'];
  const tokens = line.split(/\s+/);
  const violations = ['--name-only', '--no-renames', '-z']
    .filter((flag) => !tokens.includes(flag))
    .map((flag) => `o diff não usa ${flag}`);
  if (!/\bHEAD\^1\s+HEAD(\s|$)/.test(line))
    violations.push('o diff não compara HEAD^1 com HEAD');
  return violations;
}

// O job `changes`: checkout do commit de merge (a mesma action fixada dos outros jobs, com dois commits de histórico e
// sem guardar a credencial) e o passo `decide`, que recebe tudo por env e escreve docs_only em $GITHUB_OUTPUT.
function changesJobViolations(workflow: DocsWorkflow): string[] {
  const job: DocsJob | undefined = jobOf(workflow, 'changes');
  if (job === undefined) return ['falta o job changes'];
  const violations: string[] = [];
  if (job.name !== 'Mudanças do PR')
    violations.push(`nome ${String(job.name)}`);
  if (job['runs-on'] !== 'ubuntu-latest')
    violations.push('runs-on não é ubuntu-latest');
  if (typeof job['timeout-minutes'] !== 'number')
    violations.push('falta o timeout-minutes');
  if (!DOCS_OUTPUT.test(String(job.outputs?.docs_only)))
    violations.push(
      'a saída docs_only não vem de steps.decide.outputs.docs_only',
    );
  const steps = job.steps ?? [];
  if (steps.length !== 2)
    violations.push(`${steps.length} passos, esperado 2 (checkout e decide)`);
  const [checkout, decide] = steps;
  if (
    checkout === undefined ||
    !(checkout.uses ?? '').startsWith('actions/checkout@')
  )
    violations.push('o primeiro passo não é o checkout');
  else if (unpinnedUses([checkout]).length > 0)
    violations.push('o checkout não está fixado por SHA de 40 caracteres');
  else if (checkout.uses !== stepsOfJob(workflow, 'checks')[0]?.uses)
    violations.push('o checkout não é a mesma action dos outros jobs');
  if (String(checkout?.with?.['fetch-depth']) !== '2')
    violations.push('o checkout não usa fetch-depth: 2');
  if (String(checkout?.with?.['persist-credentials']) !== 'false')
    violations.push('o checkout guarda a credencial (persist-credentials)');
  if (decide?.id !== 'decide')
    return [...violations, 'o segundo passo não tem id: decide'];
  if (!EVENT_NAME_ENV.test(String(decide.env?.EVENT_NAME)))
    violations.push('o env EVENT_NAME não vem de github.event_name');
  if (Object.keys(decide.env ?? {}).join() !== 'EVENT_NAME')
    violations.push('o env do decide tem algo além do EVENT_NAME');
  const paths = docsPathsOf(workflow);
  if (
    JSON.stringify([...paths].sort()) !== JSON.stringify([...DOCS_PATHS].sort())
  )
    violations.push('a lista DOCS_ONLY_PATHS não é a do critério');
  if (paths.some((path) => /[*?[]/.test(path)))
    violations.push('a lista DOCS_ONLY_PATHS tem glob');
  const run = decide.run ?? '';
  if (run.includes('${{'))
    violations.push('o run interpola uma expressão (passe por env)');
  if (!run.includes('GITHUB_OUTPUT'))
    violations.push('o run não escreve em GITHUB_OUTPUT');
  return [...violations, ...diffViolations(run)];
}

// O `test` e o `api-fuzz` dependem do `changes` e só são pulados com docs_only == 'true'. O `test` pode ter outros
// `needs` no futuro; o `api-fuzz`, que o critério manda depender só do `changes`, não.
function skipConditionViolations(
  workflow: CiWorkflow,
  id: 'test' | 'api-fuzz',
): string[] {
  const job = jobOf(workflow, id);
  if (job === undefined) return [`falta o job ${id}`];
  const violations: string[] = [];
  if (!needsOf(job).includes('changes'))
    violations.push(`o ${id} não depende do changes`);
  else if (id === 'api-fuzz' && needsOf(job).length !== 1)
    violations.push('o api-fuzz depende de algo além do changes');
  if (!DOCS_IF.test((job.if ?? '').trim()))
    violations.push(
      `if do ${id} é ${JSON.stringify(job.if)}, e não needs.changes.outputs.docs_only != 'true'`,
    );
  return violations;
}

function testSkipViolations(workflow: CiWorkflow): string[] {
  return skipConditionViolations(workflow, 'test');
}

// O passo logo depois do checkout (antes do setup-node e do npm ci no `test`; antes do relatório e do compose no
// `api-fuzz`) troca cada arquivo da lista por uma pasta vazia, lendo $DOCS_ONLY_PATHS do ambiente do workflow.
function cleanupStepOf(workflow: CiWorkflow, id: string): CiStep | undefined {
  return stepsOfJob(workflow, id).find((step) => step.name === CLEANUP_NAME);
}

function cleanupViolations(workflow: CiWorkflow, id: string): string[] {
  const steps = stepsOfJob(workflow, id);
  const step = cleanupStepOf(workflow, id);
  if (step === undefined) return [`${id}: falta o passo "${CLEANUP_NAME}"`];
  const violations: string[] = [];
  const checkoutAt = steps.findIndex((candidate) =>
    (candidate.uses ?? '').startsWith('actions/checkout@'),
  );
  if (checkoutAt < 0 || steps.indexOf(step) !== checkoutAt + 1)
    violations.push(`${id}: o passo de troca não vem logo depois do checkout`);
  const run = step.run ?? '';
  if (!/\$\{?DOCS_ONLY_PATHS\b/.test(run))
    violations.push(`${id}: o passo de troca não lê $DOCS_ONLY_PATHS`);
  if (!run.includes('rm -f --'))
    violations.push(`${id}: o passo de troca não apaga com rm -f --`);
  if (!run.includes('mkdir -p --'))
    violations.push(`${id}: o passo de troca não cria a pasta com mkdir -p --`);
  if (run.includes('${{'))
    violations.push(`${id}: o passo de troca interpola uma expressão`);
  return violations;
}

// O run real do passo de troca, em diretórios temporários: um com os arquivos da lista e outros que têm de ficar, um
// vazio (nem a pasta pai existe) e um com um link simbólico no lugar do README.md.
const KEPT_FILES = [
  '.specs/features/casecellshop/spec.md',
  'src/app.ts',
  'CONTRIBUTING.md',
];
const KEPT_CONTENT = 'conteúdo\n';

function errorCodeOf(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String(error.code)
    : 'erro sem código';
}

// O código do erro da leitura do caminho, ou 'sem erro' quando ela funciona.
function readOutcome(full: string): string {
  try {
    readFileSync(full);
    return 'sem erro';
  } catch (error) {
    return errorCodeOf(error);
  }
}

// O "teste inventado" do achado A1: lista a raiz, filtra os `.md` e lê cada um que achou. Com o arquivo apagado ele some
// da listagem e o teste passa sem conferi-lo; com uma pasta no lugar, a leitura reprova com EISDIR.
function enumeratingTestOutcome(dir: string): string {
  try {
    for (const name of readdirSync(dir).filter((entry) =>
      entry.endsWith('.md'),
    ))
      readFileSync(join(dir, name));
    return 'sem erro';
  } catch (error) {
    return errorCodeOf(error);
  }
}

// Uma pasta de verdade (não um link) e vazia; devolve o que está errado, ou undefined.
function emptyDirProblem(dir: string, path: string): string | undefined {
  const full = join(dir, path);
  let stat;
  try {
    stat = lstatSync(full);
  } catch {
    return `${path} não existe`;
  }
  if (stat.isSymbolicLink()) return `${path} continua um link`;
  if (!stat.isDirectory()) return `${path} não virou pasta`;
  if (readdirSync(full).length > 0) return `${path} não está vazia`;
  return undefined;
}

function cleanupBehaviorViolations(
  step: DecideStep | undefined,
  listText: string,
): string[] {
  if (step === undefined) return ['falta o passo de troca'];
  const script = join(makeTempDir('cleanup-script-'), 'step.sh');
  writeFileSync(script, step.run ?? '');
  const run = (cwd: string): number | null =>
    runCommand('bash', ['--noprofile', '--norc', '-e', script], {
      cwd,
      env: { PATH: process.env.PATH ?? '', DOCS_ONLY_PATHS: listText },
    }).status;
  const violations: string[] = [];
  const problems = (scenario: string, dir: string): void => {
    for (const path of DOCS_PATHS) {
      const problem = emptyDirProblem(dir, path);
      if (problem !== undefined) violations.push(`${scenario}: ${problem}`);
      else if (readOutcome(join(dir, path)) !== 'EISDIR')
        violations.push(`${scenario}: a leitura de ${path} não deu EISDIR`);
    }
  };

  // Os arquivos da lista existem: viram pastas vazias, o resto fica, e a segunda execução sai com 0 e deixa as pastas.
  const populated = makeTempDir('cleanup-');
  for (const path of [...DOCS_PATHS, ...KEPT_FILES])
    writeFileIn(populated, path, KEPT_CONTENT);
  if (enumeratingTestOutcome(populated) !== 'sem erro')
    violations.push('com os arquivos no lugar o teste inventado já reprova');
  const first = run(populated);
  if (first !== 0)
    violations.push(`com os arquivos: saiu com ${String(first)}, esperado 0`);
  problems('com os arquivos', populated);
  for (const path of KEPT_FILES)
    if (!existsSync(join(populated, path)))
      violations.push(`com os arquivos: apagou ${path}`);
    else if (readFileSync(join(populated, path), 'utf8') !== KEPT_CONTENT)
      violations.push(`com os arquivos: mudou ${path}`);
  const listing = enumeratingTestOutcome(populated);
  if (listing !== 'EISDIR')
    violations.push(
      `com os arquivos: o teste inventado que lista a raiz e lê os .md deu "${listing}", esperado EISDIR`,
    );
  const second = run(populated);
  if (second !== 0)
    violations.push(`segunda execução: saiu com ${String(second)}, esperado 0`);
  problems('segunda execução', populated);

  // Nenhum caminho existe, nem a pasta pai: o passo cria tudo.
  const bare = makeTempDir('cleanup-bare-');
  const bareStatus = run(bare);
  if (bareStatus !== 0)
    violations.push(
      `sem os arquivos: saiu com ${String(bareStatus)}, esperado 0`,
    );
  problems('sem os arquivos', bare);

  // Um link simbólico no lugar de um arquivo da lista vira uma pasta de verdade; o destino do link não é tocado.
  const linked = makeTempDir('cleanup-link-');
  const target = makeTempDir('cleanup-target-');
  writeFileIn(target, 'dentro.txt', KEPT_CONTENT);
  symlinkSync(target, join(linked, 'README.md'));
  const linkedStatus = run(linked);
  if (linkedStatus !== 0)
    violations.push(
      `com um link: saiu com ${String(linkedStatus)}, esperado 0`,
    );
  problems('com um link', linked);
  if (!existsSync(join(target, 'dentro.txt')))
    violations.push('com um link: apagou o conteúdo do destino do link');
  return violations;
}

// O que o achado A1 pede: com o passo de referência o teste inventado reprova (EISDIR), e com o passo que só apaga
// ele passa sem erro, sem conferir o arquivo.
function enumeratingOutcomeAfter(run: string): string {
  const dir = makeTempDir('cleanup-enumerate-');
  for (const path of [...DOCS_PATHS, ...KEPT_FILES])
    writeFileIn(dir, path, KEPT_CONTENT);
  const script = join(makeTempDir('cleanup-script-'), 'step.sh');
  writeFileSync(script, run);
  const status = runCommand('bash', ['--noprofile', '--norc', '-e', script], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', DOCS_ONLY_PATHS: DOCS_PATHS_TEXT },
  }).status;
  return status === 0
    ? enumeratingTestOutcome(dir)
    : `o passo saiu com ${String(status)}`;
}

// Sem paths-ignore nem paths: um workflow que não roda deixaria o ci-ok exigido pendente.
function pathFilterViolations(workflow: CiWorkflow): string[] {
  return Object.entries(workflow.on ?? {}).flatMap(([event, config]) =>
    typeof config === 'object' && config !== null
      ? ['paths-ignore', 'paths']
          .filter((key) => key in config)
          .map((key) => `on.${event} usa ${key}`)
      : [],
  );
}

// A forma completa do AI-53, para a estrutura que tem o `test` e o `changes` (o `api-fuzz` tem a sua, em
// apiFuzzSkipViolations).
function docsOnlyViolations(workflow: DocsWorkflow): string[] {
  return [
    ...changesJobViolations(workflow),
    ...testSkipViolations(workflow),
    ...cleanupViolations(workflow, 'test'),
    ...pathFilterViolations(workflow),
    ...ciOkViolations(workflow),
  ];
}

function apiFuzzSkipViolations(workflow: CiWorkflow): string[] {
  return [
    ...skipConditionViolations(workflow, 'api-fuzz'),
    ...cleanupViolations(workflow, 'api-fuzz'),
  ];
}

// --- AI-53: o passo decide rodado de verdade, num repositório git temporário ------------------------------------

interface DecideCase {
  label: string;
  expected: 'true' | 'false';
  event?: string;
  // `false`: o HEAD é o commit do PR (um commit comum), e não o commit de merge.
  merge?: boolean;
  // Muda a base antes de o PR sair dela (para criar o rename detectável).
  base?: (repo: string) => void;
  pr: (repo: string) => void;
}

type DecideStep = Pick<CiStep, 'run' | 'env'>;

const DECIDE_BASE_FILES: Record<string, string> = {
  'src/app.ts': 'export {};\n',
  'src/x.ts': 'linha 1\nlinha 2\nlinha 3\nlinha 4\nlinha 5\n',
  'README.md': 'base\n',
  'docs/README.md': 'base\n',
  '.specs/project/STATE.md': 'base\n',
  '.specs/codebase/CONVENTIONS.md': 'base\n',
  '.specs/features/casecellshop/spec.md': 'base\n',
};

// Cada arquivo muda com um texto próprio, para o git ver a mudança.
function touch(repo: string, path: string): void {
  writeFileIn(repo, path, `mudou ${path}\n`);
}

function touchAll(...paths: string[]): (repo: string) => void {
  return (repo) => {
    for (const path of paths) touch(repo, path);
  };
}

const RENAME_LABEL = 'rename de src/x.ts para o README.md';
const PUSH_LABEL = 'push com só o README.md';
const EMPTY_LABEL = 'merge sem mudança de arquivo';
const NOT_MERGE_LABEL = 'HEAD que não é merge';
const SUFFIX_LABEL = 'docs/README.md';
const PREFIX_LABEL = 'README.md.ts';

const DECIDE_CASES: DecideCase[] = [
  { label: 'só o README.md', expected: 'true', pr: touchAll('README.md') },
  {
    label: 'só o STATE.md',
    expected: 'true',
    pr: touchAll('.specs/project/STATE.md'),
  },
  {
    label: 'README.md e CONVENTIONS.md',
    expected: 'true',
    pr: touchAll('README.md', '.specs/codebase/CONVENTIONS.md'),
  },
  {
    label: 'todos os oito arquivos da lista',
    expected: 'true',
    pr: touchAll(...DOCS_PATHS),
  },
  {
    label: 'README.md e src/app.ts',
    expected: 'false',
    pr: touchAll('README.md', 'src/app.ts'),
  },
  {
    label: 'README.md e um teste ao lado do código',
    expected: 'false',
    pr: touchAll('README.md', 'src/x.test.ts'),
  },
  {
    label: 'README.md e um teste de test/repo',
    expected: 'false',
    pr: touchAll('README.md', 'test/repo/x.test.ts'),
  },
  {
    label: 'o spec.md',
    expected: 'false',
    pr: touchAll('.specs/features/casecellshop/spec.md'),
  },
  {
    label: 'o telemetry.md',
    expected: 'false',
    pr: touchAll('.specs/features/casecellshop/telemetry.md'),
  },
  {
    label: 'um arquivo novo em .specs/',
    expected: 'false',
    pr: touchAll('.specs/project/NOVO.md'),
  },
  {
    label: RENAME_LABEL,
    expected: 'false',
    // O README.md sai da base, para o git enxergar o src/x.ts virando README.md como um rename.
    base: (repo) => {
      rmSync(join(repo, 'README.md'));
    },
    pr: (repo) => {
      renameSync(join(repo, 'src/x.ts'), join(repo, 'README.md'));
    },
  },
  {
    label: SUFFIX_LABEL,
    expected: 'false',
    pr: touchAll('docs/README.md'),
  },
  { label: PREFIX_LABEL, expected: 'false', pr: touchAll('README.md.ts') },
  {
    label: 'a remoção de src/x.ts',
    expected: 'false',
    pr: (repo) => {
      rmSync(join(repo, 'src/x.ts'));
    },
  },
  {
    label: PUSH_LABEL,
    expected: 'false',
    event: 'push',
    pr: touchAll('README.md'),
  },
  {
    label: EMPTY_LABEL,
    expected: 'false',
    pr: () => undefined,
  },
  {
    label: NOT_MERGE_LABEL,
    expected: 'false',
    merge: false,
    pr: touchAll('README.md'),
  },
];

// AI-53, casos de borda: apagar um arquivo da lista conta como mudar só a lista; um nome com espaço ou com quebra de
// linha é lido inteiro pelo -z e fica fora da lista.
const REMOVE_README_LABEL = 'a remoção do README.md';
const REMOVE_STATE_LABEL = 'a remoção do STATE.md';
const SPACE_NAME_LABEL = 'um arquivo novo chamado "README.md x" (com espaço)';
const NEWLINE_NAME_LABEL =
  'um arquivo novo chamado "README.md", quebra de linha e "x"';
const NEWLINE_NAME = 'README.md\nx';

const DECIDE_EDGE_CASES: DecideCase[] = [
  {
    label: REMOVE_README_LABEL,
    expected: 'true',
    pr: (repo) => {
      rmSync(join(repo, 'README.md'));
    },
  },
  {
    label: REMOVE_STATE_LABEL,
    expected: 'true',
    pr: (repo) => {
      rmSync(join(repo, '.specs/project/STATE.md'));
    },
  },
  {
    label: SPACE_NAME_LABEL,
    expected: 'false',
    pr: touchAll('README.md x'),
  },
];

const NEWLINE_NAME_CASE: DecideCase = {
  label: NEWLINE_NAME_LABEL,
  expected: 'false',
  pr: touchAll(NEWLINE_NAME),
};

// O caso do nome com quebra de linha só roda onde o sistema de arquivos aceita o nome (o Linux aceita; o Windows e
// alguns volumes montados não). É uma limitação do ambiente, e nunca uma forma de esconder uma falha do passo.
function filesystemAcceptsNewlineNames(): boolean {
  const dir = makeTempDir('newline-name-');
  try {
    writeFileIn(dir, NEWLINE_NAME, 'x\n');
    return existsSync(join(dir, NEWLINE_NAME));
  } catch {
    return false;
  }
}

const NEWLINE_NAMES_SUPPORTED = filesystemAcceptsNewlineNames();

function makeDecideRepo(): string {
  const repo = makeTempDir('decide-repo-');
  git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(DECIDE_BASE_FILES))
    writeFileIn(repo, path, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

// Os casos de uma tabela dividem o repositório (criar um por caso custaria mais): cada um parte da `main`, faz o
// commit do PR numa ramificação e deixa o HEAD no commit de merge `--no-ff` (primeiro pai: a base; segundo: o PR),
// como o GitHub monta o refs/pull/N/merge.
let sharedRepo: string | undefined;

function sharedDecideRepo(): string {
  sharedRepo ??= makeDecideRepo();
  return sharedRepo;
}

function prepareDecideCase(repo: string, decideCase: DecideCase): void {
  git(repo, 'checkout', '-q', '-B', 'case-base', 'main');
  if (decideCase.base !== undefined) {
    decideCase.base(repo);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'ajusta a base');
  }
  const base = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'checkout', '-q', '-B', 'case-pr', base);
  decideCase.pr(repo);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'pr');
  if (decideCase.merge === false) return;
  git(repo, 'checkout', '-q', '--detach', base);
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge do pr', 'case-pr');
}

// O env do passo como o GitHub o entregaria: github.event_name vira o evento do caso; qualquer outra expressão é um
// erro do teste, e não um passo que o teste sabe rodar.
function envOfDecide(step: DecideStep, event: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, raw] of Object.entries(step.env ?? {})) {
    const value = String(raw);
    if (EVENT_NAME_ENV.test(value)) env[name] = event;
    else if (value.includes('${{'))
      throw new Error(`expressão do env não suportada pelo teste: ${value}`);
    else env[name] = value;
  }
  return env;
}

interface DecideRun {
  status: number | null;
  value: string | undefined;
}

// bash -e, o shell padrão do GitHub no Linux; o git roda dentro do repositório do caso, e o script e o arquivo
// GITHUB_OUTPUT ficam numa pasta temporária fora dele.
function runDecide(
  step: DecideStep,
  repo: string,
  event = 'pull_request',
): DecideRun {
  const work = makeTempDir('decide-run-');
  const output = join(work, 'github-output');
  writeFileSync(output, '');
  writeFileIn(work, 'step.sh', step.run ?? '');
  const result = runCommand(
    'bash',
    ['--noprofile', '--norc', '-e', join(work, 'step.sh')],
    {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: work,
        ...envOfDecide(step, event),
        GITHUB_OUTPUT: output,
      },
    },
  );
  const written = [
    ...readFileSync(output, 'utf8').matchAll(/^docs_only=(.*)$/gm),
  ];
  return { status: result.status, value: written.at(-1)?.[1] };
}

function decideBehaviorViolations(
  step: DecideStep | undefined,
  cases: DecideCase[] = DECIDE_CASES,
): string[] {
  if (step === undefined) return ['falta o passo decide'];
  const repo = sharedDecideRepo();
  const violations: string[] = [];
  for (const decideCase of cases) {
    prepareDecideCase(repo, decideCase);
    const { status, value } = runDecide(step, repo, decideCase.event);
    if (status !== 0 || value !== decideCase.expected)
      violations.push(
        `${decideCase.label}: saiu com ${String(status)} e docs_only=${value ?? '(ausente)'}, esperado 0 e ${decideCase.expected}`,
      );
  }
  return violations;
}

// Um erro do git reprova o passo: um PR só de documentação, com o objeto do primeiro pai apagado do repositório. O
// passo tem de sair com código diferente de 0 e nunca escrever docs_only=true; um diff que falhou e foi lido como
// vazio (ou como "sem arquivo fora da lista") deixaria o `test` ser pulado por engano.
function decideGitErrorViolations(step: DecideStep | undefined): string[] {
  if (step === undefined) return ['falta o passo decide'];
  const repo = makeDecideRepo();
  prepareDecideCase(repo, {
    label: 'git com erro',
    expected: 'false',
    pr: touchAll('README.md'),
  });
  const parent = git(repo, 'rev-parse', 'HEAD^1').trim();
  const object = join(
    repo,
    '.git',
    'objects',
    parent.slice(0, 2),
    parent.slice(2),
  );
  if (!existsSync(object))
    return ['o teste não achou o objeto do pai para apagar'];
  rmSync(object);
  const { status, value } = runDecide(step, repo);
  const violations: string[] = [];
  if (status === 0) violations.push('o git falhou e o passo saiu com 0');
  if (value === 'true')
    violations.push('o git falhou e o passo escreveu docs_only=true');
  return violations;
}

// A estrutura do critério, completa e correta: prova que as conferências aceitam o que elas pedem.
const GOOD_STRUCTURE = `
on:
  push:
    branches: [main]
  pull_request:
${TOP_ENV}jobs:
${CHANGES_JOB}  checks:
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
    needs: changes
    if: needs.changes.outputs.docs_only != 'true'
    strategy:
      fail-fast: false
      matrix:
        node: [nvmrc, '24.12.0']
    steps:
      - uses: actions/checkout@${SHA}
        with: { fetch-depth: 0, persist-credentials: false }
${CLEANUP_STEP}      - uses: actions/setup-node@${SHA}
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
${ciOkJob(NEEDS_BASE)}`;

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

  it('AI-42 o workflow tem exatamente os jobs checks, test, workflows, api-fuzz (FND-16), changes (AI-53) e ci-ok, e o job commits deixou de existir', () => {
    expect(Object.keys(ci.jobs ?? {}).sort()).toEqual(CI_JOB_IDS);
  });

  it('AI-42 o ci-ok depende dos cinco jobs changes, checks, test, workflows e api-fuzz', () => {
    expect(needsOf(jobOf(ci, 'ci-ok') ?? {}).sort()).toEqual([
      'api-fuzz',
      'changes',
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

  it('AI-42 o passo de shell do ci-ok sai com 0 com tudo success, e com código diferente de 0 em failure e cancelled de qualquer job', () => {
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
// ambiente (valem os padrões fixos do compose, para a execução ser repetível), e com o down pelo perfil fuzz. AI-53:
// roda em paralelo ao `test`, depende só do `changes` e é pulado só com docs_only == 'true', com o passo de troca por pastas
// logo depois do checkout.
function ciFuzzViolations(workflow: FuzzWorkflow): string[] {
  const job = jobOf(workflow, 'api-fuzz');
  const violations = apiFuzzJobViolations(job, 'default');
  if (job === undefined) return violations;
  if (job.name !== 'Fuzzing da API')
    violations.push(`nome ${String(job.name)}`);
  violations.push(...apiFuzzSkipViolations(workflow));
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

const FUZZ_NEEDS = '    needs: changes\n';
const FUZZ_IF = "    if: needs.changes.outputs.docs_only != 'true'\n";

const CI_FUZZ_JOB = `  api-fuzz:
    name: Fuzzing da API
${FUZZ_NEEDS}${FUZZ_IF}    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
${CLEANUP_STEP}${REPORT_DIR_STEP}      - name: Fuzzing com o Schemathesis
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
  ciOkJob(NEEDS_BASE),
  () => CI_FUZZ_JOB + ciOkJob(NEEDS_WITH_FUZZ),
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
    'com needs além do changes (não roda em paralelo ao test)',
    FUZZ_NEEDS,
    '    needs: [changes, checks]\n',
  ],
  [
    'com needs só do checks, sem o changes',
    FUZZ_NEEDS,
    '    needs: [checks]\n',
  ],
  ['sem needs (o if não enxerga o changes)', FUZZ_NEEDS, ''],
  [
    'com outra condição no job (pode ser pulado em PR de código)',
    FUZZ_IF,
    "    if: github.event_name == 'pull_request'\n",
  ],
  [
    'com a condição invertida (pulado em PR de código)',
    FUZZ_IF,
    "    if: needs.changes.outputs.docs_only == 'true'\n",
  ],
  ['sem if (roda em PR só de documentação)', FUZZ_IF, ''],
  ['sem o passo que tira os arquivos da lista', CLEANUP_STEP, ''],
  [
    'com o passo que tira os arquivos depois do relatório',
    CLEANUP_STEP + REPORT_DIR_STEP,
    REPORT_DIR_STEP + CLEANUP_STEP,
  ],
  [
    'com o passo que tira os arquivos sem ler o DOCS_ONLY_PATHS',
    '"$DOCS_ONLY_PATHS"',
    '"README.md"',
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
    expect(ciOkSkipViolations(good)).toEqual([]);
    expect(ciOkRejectsFuzzViolations(good)).toEqual([]);
    expect(retryViolations(good)).toEqual([]);
  });

  it('FND-16 sem o job api-fuzz, reprova', () => {
    const without = parseWorkflow(
      GOOD_WITH_FUZZ.replace(CI_FUZZ_JOB, () => '').replace(
        NEEDS_WITH_FUZZ,
        () => NEEDS_BASE,
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

  it('FND-16 o api-fuzz do CI que cria o schemathesis-report antes do checkout reprova', () => {
    const early = parseWorkflow(
      GOOD_WITH_FUZZ.replace(CI_FUZZ_JOB, () =>
        reportDirBeforeCheckout(CI_FUZZ_JOB),
      ),
    );

    expect(ciFuzzViolations(early)).toEqual([
      'o diretório do relatório é criado antes do checkout',
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
      mutated(
        GOOD_WITH_FUZZ,
        '\nenv:\n  DOCS_ONLY_PATHS: |',
        '\nenv:\n  FUZZ_SEED: 1\n  DOCS_ONLY_PATHS: |',
      ),
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
      mutated(GOOD_WITH_FUZZ, NEEDS_WITH_FUZZ, NEEDS_BASE),
    );

    expect(ciOkViolations(missing)).toEqual(['needs não tem api-fuzz']);
  });

  it('FND-16 o ci-ok que não reprova quando o api-fuzz falha ou é cancelado reprova no comportamento', () => {
    const lenient = parseWorkflow(
      mutated(
        GOOD_WITH_FUZZ,
        '.value.result == "success" or',
        '.value.result == "success" or .value.result == "failure" or .value.result == "cancelled" or',
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

  it('FND-16 o job api-fuzz roda em paralelo ao test: depende só do changes (AI-53) e nenhum job depende dele além do ci-ok', () => {
    const others = Object.entries(ci.jobs ?? {}).filter(
      ([id]) => id !== 'api-fuzz' && id !== 'ci-ok',
    );

    expect(jobOf(ci, 'api-fuzz')).toBeDefined();
    expect(needsOf(jobOf(ci, 'api-fuzz') ?? {})).toEqual(['changes']);
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

// --- AI-53: o pulo do test e do api-fuzz em PR só de documentação ---------------------------------------------------

// O passo `decide` de referência com o ambiente que o GitHub lhe daria: o evento e a lista do env do topo.
function refStep(run: string): DecideStep {
  return {
    run,
    env: {
      EVENT_NAME: '${{ github.event_name }}',
      DOCS_ONLY_PATHS: DOCS_PATHS_TEXT,
    },
  };
}

// Variante do passo que lê o diff por substituição de processo: o erro do git não derruba o laço, e o diff que
// falhou parece vazio.
const DECIDE_SUBSTITUTION_RUN = String.raw`count=0
docs_only=false
if [ "$EVENT_NAME" = "pull_request" ] && git rev-parse --verify --quiet "HEAD^2" > /dev/null; then
  docs_only=true
  while IFS= read -r -d '' file; do
    count=$((count + 1))
${MATCH_LINE}
  done < <(git diff --name-only --no-renames -z HEAD^1 HEAD)
  [ "$count" -gt 0 ] || docs_only=false
fi
echo "docs_only=$docs_only" >> "$GITHUB_OUTPUT"
`;

// [rótulo, trecho do passo, trecho trocado, rótulo do caso da tabela que tem de enxergar a diferença]
type DecideMutation = readonly [
  label: string,
  from: string,
  to: string,
  caseLabel: string,
];

const DECIDE_MUTATIONS: DecideMutation[] = [
  ['sem --no-renames', ' --no-renames', '', RENAME_LABEL],
  [
    'sem conferir o evento',
    '[ "$EVENT_NAME" = "pull_request" ] && ',
    '',
    PUSH_LABEL,
  ],
  [
    'sem exigir o segundo pai',
    ' && git rev-parse --verify --quiet "HEAD^2" > /dev/null',
    '',
    NOT_MERGE_LABEL,
  ],
  ['sem exigir o diff não vazio', ' && [ -s "$list" ]', '', EMPTY_LABEL],
  [
    'com casamento por glob de sufixo',
    MATCH_LINE,
    '    case "$file" in *README.md|*.specs/*) ;; *) docs_only=false ;; esac',
    SUFFIX_LABEL,
  ],
  [
    'com casamento por prefixo',
    MATCH_LINE,
    '    case "$file" in README.md*|.specs/*) ;; *) docs_only=false ;; esac',
    PREFIX_LABEL,
  ],
];

describe('AI-53 as conferências do passo decide enxergam o que procuram (controle negativo)', () => {
  it('AI-53 o passo de referência, do texto e do YAML da estrutura correta, passa na tabela de casos e no erro do git (controle positivo)', () => {
    const good = parseWorkflow(GOOD_STRUCTURE);

    expect(decideBehaviorViolations(refStep(DECIDE_RUN))).toEqual([]);
    expect(decideBehaviorViolations(decideStepWithList(good))).toEqual([]);
    expect(decideGitErrorViolations(decideStepWithList(good))).toEqual([]);
  }, 60_000);

  it.each(DECIDE_MUTATIONS)(
    'AI-53 o decide %s dá o resultado errado no caso da tabela e reprova',
    (_label, from, to, caseLabel) => {
      const cases = DECIDE_CASES.filter((c) => c.label === caseLabel);

      expect(cases).toHaveLength(1);
      const violations = decideBehaviorViolations(
        refStep(mutated(DECIDE_RUN, from, to)),
        cases,
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(caseLabel);
    },
  );

  it('AI-53 o decide que lê o diff por substituição de processo não reprova o passo quando o git falha, e a conferência enxerga', () => {
    expect(decideGitErrorViolations(refStep(DECIDE_SUBSTITUTION_RUN))).toEqual([
      'o git falhou e o passo saiu com 0',
    ]);
  });
});

describe('AI-53 os casos de borda do passo decide enxergam o que procuram (controle negativo)', () => {
  it('AI-53 o passo de referência dá true na remoção do README.md e do STATE.md e false no nome com espaço (controle positivo)', () => {
    expect(
      decideBehaviorViolations(refStep(DECIDE_RUN), DECIDE_EDGE_CASES),
    ).toEqual([]);
  });

  it('AI-53 o decide que ignora os arquivos apagados (--diff-filter=d) dá false na remoção e reprova nos dois casos', () => {
    const violations = decideBehaviorViolations(
      refStep(
        mutated(DECIDE_RUN, ' --no-renames', ' --no-renames --diff-filter=d'),
      ),
      DECIDE_EDGE_CASES,
    );

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain(REMOVE_README_LABEL);
    expect(violations[1]).toContain(REMOVE_STATE_LABEL);
  });

  it('AI-53 o decide com casamento por prefixo dá true no nome com espaço "README.md x", e o caso enxerga', () => {
    const violations = decideBehaviorViolations(
      refStep(
        mutated(
          DECIDE_RUN,
          MATCH_LINE,
          '    case "$file" in README.md*|.specs/*) ;; *) docs_only=false ;; esac',
        ),
      ),
      DECIDE_EDGE_CASES,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(SPACE_NAME_LABEL);
  });

  it.skipIf(!NEWLINE_NAMES_SUPPORTED)(
    'AI-53 o passo de referência dá false no nome "README.md", quebra de linha, "x" (controle positivo)',
    () => {
      expect(
        decideBehaviorViolations(refStep(DECIDE_RUN), [NEWLINE_NAME_CASE]),
      ).toEqual([]);
    },
  );

  it.skipIf(!NEWLINE_NAMES_SUPPORTED)(
    'AI-53 o decide que compara o nome inteiro com o grep -F, sem recusar a quebra de linha, dá true (o grep lê dois padrões), e o caso enxerga',
    () => {
      const violations = decideBehaviorViolations(
        refStep(mutated(DECIDE_RUN, MATCH_LINE, GREP_MATCH_LINE)),
        [...DECIDE_EDGE_CASES, NEWLINE_NAME_CASE],
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(NEWLINE_NAME_LABEL);
      expect(violations[0]).toContain('docs_only=true');
    },
  );

  it.skipIf(!NEWLINE_NAMES_SUPPORTED)(
    'AI-53 o decide que lê o diff por linha, sem -z, também dá false no nome com quebra de linha (o git o escreve entre aspas), então esse caso não distingue o -z',
    () => {
      // Sem o -z o git cita o nome (`"README.md\nx"`) e a linha não casa com a lista. O que separa o passo certo do
      // errado nesse caso é a recusa da quebra de linha antes do `grep -F` (o teste acima), e não o -z.
      const perLine = String.raw`list=$(mktemp)
git diff --name-only --no-renames HEAD^1 HEAD > "$list"
docs_only=false
if [ "$EVENT_NAME" = "pull_request" ] && git rev-parse --verify --quiet "HEAD^2" > /dev/null && [ -s "$list" ]; then
  docs_only=true
  while IFS= read -r file; do
${GREP_MATCH_LINE}
  done < "$list"
fi
echo "docs_only=$docs_only" >> "$GITHUB_OUTPUT"
`;

      expect(
        decideBehaviorViolations(refStep(perLine), [NEWLINE_NAME_CASE]),
      ).toEqual([]);
    },
  );
});

describe('AI-53 as conferências do ci-ok contra um RESULTS que não é JSON enxergam o que procuram (controle negativo)', () => {
  it('AI-53 o ci-ok de referência reprova lixo, JSON cortado e vazio, com docs_only true e false (controle positivo)', () => {
    expect(ciOkInvalidResultsViolations(parseWorkflow(GOOD_CI_OK))).toEqual([]);
  }, 60_000);

  const ALL_INVALID = [
    'RESULTS lixo com docs_only true: saiu com 0, esperado diferente de 0',
    'RESULTS com JSON cortado com docs_only true: saiu com 0, esperado diferente de 0',
    'RESULTS vazio com docs_only true: saiu com 0, esperado diferente de 0',
    'RESULTS lixo com docs_only false: saiu com 0, esperado diferente de 0',
    'RESULTS com JSON cortado com docs_only false: saiu com 0, esperado diferente de 0',
    'RESULTS vazio com docs_only false: saiu com 0, esperado diferente de 0',
  ];
  // A regra com a polaridade de reprovar o que não passa, lida por `jq ... || true` numa substituição: o erro do jq
  // vira texto vazio, e o texto vazio não é "true".
  const failedOrTrue = `bad=$(echo "$RESULTS" | jq -r --arg docs "$DOCS_ONLY" 'any(to_entries[]; (${OK_FILTER}) | not)' || true); if [ "$bad" = "true" ]; then`;

  it.each([
    [
      'trata o erro do jq como "nenhum job reprova" (if jq -e sem validar o JSON antes)',
      (text: string) =>
        text
          .replace(CI_OK_JSON_GUARD, () => '')
          .replace(CI_OK_RULE_LINE, () => CI_OK_FAIL_OPEN_RULE_LINE),
    ],
    [
      'ignora o erro do jq da validação com || true',
      (text: string) =>
        text
          .replace(
            CI_OK_JSON_GUARD,
            () =>
              `echo "$RESULTS" | jq -e 'type == "object" and length > 0' > /dev/null || true`,
          )
          .replace(CI_OK_RULE_LINE, () => CI_OK_FAIL_OPEN_RULE_LINE),
    ],
    [
      'lê a regra por jq ... || true dentro de uma substituição',
      (text: string) =>
        text
          .replace(CI_OK_JSON_GUARD, () => '')
          .replace(CI_OK_RULE_LINE, () => failedOrTrue),
    ],
  ])(
    'AI-53 um ci-ok que %s aprova o RESULTS inválido e reprova no comportamento, sem reprovar o failure nem o skipped',
    (_label, edit) => {
      const workflow = variant(edit);

      expect(ciOkInvalidResultsViolations(workflow)).toEqual(ALL_INVALID);
      expect(ciOkBehaviorViolations(workflow)).toEqual([]);
      expect(ciOkSkipViolations(workflow)).toEqual([]);
    },
    60_000,
  );
});

describe('AI-53 as conferências do ci-ok contra um RESULTS que é JSON mas não descreve os jobs enxergam o que procuram (controle negativo)', () => {
  const labelsOf = (cases: typeof SHAPE_RESULTS): string[] =>
    ['true', 'false'].flatMap((docsOnly) =>
      cases.map(
        ([label]) =>
          `${label} com docs_only ${docsOnly}: saiu com 0, esperado diferente de 0`,
      ),
    );
  const only = (...labels: string[]): typeof SHAPE_RESULTS =>
    SHAPE_RESULTS.filter(([label]) => labels.includes(label));

  it('AI-53 o ci-ok de referência reprova {}, um job sem result, neutral, um resultado desconhecido e um job que não é objeto, com docs_only true e false (controle positivo)', () => {
    expect(ciOkShapeViolations(parseWorkflow(GOOD_CI_OK))).toEqual([]);
  }, 60_000);

  it('AI-53 o ci-ok anterior, por lista de proibidos, sai com 0 com {"test":{}} e com neutral, e a conferência acusa (controle de comportamento)', () => {
    const legacy = parseWorkflow(
      GOOD_CI_OK.replace(ciOkJob('checks, test, changes'), () =>
        legacyCiOkJob('checks, test, changes'),
      ),
    );

    const violations = ciOkShapeViolations(legacy);

    expect(violations).toContain(
      'RESULTS com um job sem result com docs_only false: saiu com 0, esperado diferente de 0',
    );
    expect(violations).toContain(
      'RESULTS com result neutral com docs_only false: saiu com 0, esperado diferente de 0',
    );
    expect(violations).toEqual(labelsOf(SHAPE_RESULTS));
    expect(ciOkBehaviorViolations(legacy)).toEqual([
      'checks neutral: saiu com 0, esperado diferente de 0',
      'test neutral: saiu com 0, esperado diferente de 0',
      'changes neutral: saiu com 0, esperado diferente de 0',
    ]);
    expect(ciOkViolations(legacy)).toEqual([
      'o run não cita success',
      'o run não exige length > 0 no RESULTS',
    ]);
  }, 60_000);

  it.each([
    [
      'sem exigir pelo menos um job na guarda (all de um objeto vazio é verdadeiro)',
      (text: string) => text.replace(CI_OK_JSON_GUARD, () => LEGACY_JSON_GUARD),
      only('RESULTS {} sem nenhum job'),
    ],
    [
      'com a guarda do objeto vazio ignorada por || true',
      (text: string) =>
        text.replace(
          CI_OK_JSON_GUARD,
          () =>
            `echo "$RESULTS" | jq -e 'type == "object" and length > 0' > /dev/null || true`,
        ),
      only('RESULTS {} sem nenhum job'),
    ],
    [
      'que trata um job sem result como success',
      (text: string) =>
        text.replace(
          '.value.result == "success"',
          () => '(.value.result // "success") == "success"',
        ),
      only(
        'RESULTS com um job sem result',
        'RESULTS com success e um job sem result',
      ),
    ],
    [
      'que passa quando algum job é success (any no lugar de all)',
      (text: string) =>
        text.replace('all(to_entries[];', () => 'any(to_entries[];'),
      only(
        'RESULTS com success e um job sem result',
        'RESULTS com success e um job neutral',
      ),
    ],
  ])(
    'AI-53 um ci-ok %s aprova o RESULTS sem o job certo e reprova na conferência de forma do RESULTS',
    (_label, edit, accused) => {
      const workflow = variant(edit);

      expect(ciOkShapeViolations(workflow)).toEqual(labelsOf(accused));
      expect(ciOkInvalidResultsViolations(workflow)).toEqual([]);
    },
    60_000,
  );
});

describe('AI-53 as conferências do passo de troca por pastas enxergam o que procuram (controle negativo)', () => {
  it('AI-53 o passo de troca de referência faz do arquivo, do caminho que não existia e do link uma pasta vazia, deixa os outros e sai com 0 na segunda execução (controle positivo)', () => {
    expect(
      cleanupBehaviorViolations(refStep(CLEANUP_RUN), DOCS_PATHS_TEXT),
    ).toEqual([]);
  });

  it.each([
    [
      'só apaga, sem criar a pasta (rm sem mkdir)',
      '; mkdir -p -- "$path"',
      '',
      'não existe',
    ],
    [
      'cria a pasta sem -p (a pasta pai que falta reprova o passo)',
      'mkdir -p --',
      'mkdir --',
      'sem os arquivos: saiu com',
    ],
    [
      'não trata o link (o link fica)',
      '[ -L "$path" ] || ',
      '',
      'com um link: README.md continua um link',
    ],
    [
      'cria a pasta antes de apagar (mkdir antes do rm)',
      'rm -f -- "$path"; mkdir -p -- "$path"',
      'mkdir -p -- "$path"; rm -f -- "$path"',
      'com os arquivos: saiu com',
    ],
    [
      'troca sempre, até a pasta que já está lá (a segunda execução reprova o passo)',
      '[ -n "$path" ] && { [ -L "$path" ] || [ ! -d "$path" ]; }',
      '[ -n "$path" ]',
      'segunda execução: saiu com',
    ],
    [
      'sem -f (caminho que não existe reprova o passo)',
      'rm -f --',
      'rm --',
      'sem os arquivos: saiu com',
    ],
    [
      'trocando também o src/app.ts',
      'rm -f -- "$path"',
      'rm -f -- "$path" src/app.ts',
      'com os arquivos: apagou src/app.ts',
    ],
    [
      'sem ler a lista (troca só o README.md)',
      '"$DOCS_ONLY_PATHS"',
      '"README.md"',
      'com os arquivos: .specs/README.md não',
    ],
    [
      'trocando só o primeiro caminho da lista',
      '"$DOCS_ONLY_PATHS" |',
      '"$DOCS_ONLY_PATHS" | head -n 1 |',
      'com os arquivos: .specs/README.md não',
    ],
  ])(
    'AI-53 o passo de troca %s reprova no comportamento',
    (_label, from, to, fragment) => {
      const violations = cleanupBehaviorViolations(
        refStep(mutated(CLEANUP_RUN, from, to)),
        DOCS_PATHS_TEXT,
      );

      expect(violations.join('\n')).toContain(fragment);
    },
  );

  it('AI-53 um teste inventado que lista a raiz e lê os .md reprova com EISDIR depois da troca, e passa sem erro depois de só apagar (o achado A1)', () => {
    expect(enumeratingOutcomeAfter(CLEANUP_RUN)).toBe('EISDIR');
    expect(enumeratingOutcomeAfter(DELETE_ONLY_RUN)).toBe('sem erro');
    expect(
      cleanupBehaviorViolations(refStep(DELETE_ONLY_RUN), DOCS_PATHS_TEXT).join(
        '\n',
      ),
    ).toContain(
      'o teste inventado que lista a raiz e lê os .md deu "sem erro"',
    );
  });

  it('AI-53 a leitura de cada um dos oito caminhos da lista depois da troca lança EISDIR', () => {
    const dir = makeTempDir('cleanup-eisdir-');
    for (const path of DOCS_PATHS) writeFileIn(dir, path, KEPT_CONTENT);
    const script = join(makeTempDir('cleanup-script-'), 'step.sh');
    writeFileSync(script, CLEANUP_RUN);
    const status = runCommand('bash', ['--noprofile', '--norc', '-e', script], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', DOCS_ONLY_PATHS: DOCS_PATHS_TEXT },
    }).status;

    expect(status).toBe(0);
    expect(DOCS_PATHS.map((path) => readOutcome(join(dir, path)))).toEqual(
      DOCS_PATHS.map(() => 'EISDIR'),
    );
  });
});

// [rótulo, trecho da estrutura correta, trecho trocado, violação que a conferência certa tem de apontar]
type StructureCase = readonly [
  label: string,
  from: string,
  to: string,
  expected: string,
];

const STRUCTURE_CASES: StructureCase[] = [
  [
    'um ci-ok sem o changes em needs',
    `needs: [${NEEDS_BASE}]`,
    'needs: [checks, test, workflows]',
    'needs não tem changes',
  ],
  [
    'uma lista com glob no lugar de um caminho',
    '    .specs/README.md\n',
    '    .specs/**\n',
    'a lista DOCS_ONLY_PATHS tem glob',
  ],
  [
    'uma lista com um glob a mais',
    '    README.md\n',
    '    README.md\n    docs/*.md\n',
    'a lista DOCS_ONLY_PATHS tem glob',
  ],
  [
    'uma lista com um caminho a menos',
    '    .specs/README.md\n',
    '',
    'a lista DOCS_ONLY_PATHS não é a do critério',
  ],
  [
    'uma lista com o spec.md',
    '    README.md\n',
    '    README.md\n    .specs/features/casecellshop/spec.md\n',
    'a lista DOCS_ONLY_PATHS não é a do critério',
  ],
  [
    'uma lista no env do passo decide, e não no do topo',
    '          EVENT_NAME: ${{ github.event_name }}\n',
    '          EVENT_NAME: ${{ github.event_name }}\n          DOCS_ONLY_PATHS: x\n',
    'o env do decide tem algo além do EVENT_NAME',
  ],
  [
    'um diff sem --no-renames',
    ' --no-renames',
    '',
    'o diff não usa --no-renames',
  ],
  ['um diff sem -z', ' -z HEAD^1', ' HEAD^1', 'o diff não usa -z'],
  [
    'um diff do HEAD com o HEAD^2',
    'HEAD^1 HEAD >',
    'HEAD^2 HEAD >',
    'o diff não compara HEAD^1 com HEAD',
  ],
  [
    'um on.pull_request com paths-ignore',
    '  pull_request:\n',
    "  pull_request:\n    paths-ignore: ['.specs/**']\n",
    'on.pull_request usa paths-ignore',
  ],
  [
    'um on.pull_request com paths',
    '  pull_request:\n',
    "  pull_request:\n    paths: ['src/**']\n",
    'on.pull_request usa paths',
  ],
  [
    'um on.push com paths-ignore',
    '    branches: [main]\n',
    "    branches: [main]\n    paths-ignore: ['**.md']\n",
    'on.push usa paths-ignore',
  ],
  [
    'um test sem needs: changes',
    '    needs: changes\n',
    '',
    'o test não depende do changes',
  ],
  [
    'um test sem o if',
    "    if: needs.changes.outputs.docs_only != 'true'\n",
    '',
    "if do test é undefined, e não needs.changes.outputs.docs_only != 'true'",
  ],
  [
    'um test com o if invertido',
    "docs_only != 'true'",
    "docs_only == 'true'",
    "if do test é \"needs.changes.outputs.docs_only == 'true'\", e não needs.changes.outputs.docs_only != 'true'",
  ],
  [
    'um passo decide que interpola uma expressão no run',
    'list=$(mktemp)',
    'list=$(mktemp) # ${{ github.event_name }}',
    'o run interpola uma expressão (passe por env)',
  ],
  [
    'um passo decide que não vem do github.event_name',
    '          EVENT_NAME: ${{ github.event_name }}\n',
    '          EVENT_NAME: pull_request\n',
    'o env EVENT_NAME não vem de github.event_name',
  ],
  [
    'um changes com outro nome',
    'name: Mudanças do PR',
    'name: Mudanças',
    'nome Mudanças',
  ],
  [
    'um changes sem timeout-minutes',
    '    timeout-minutes: 5\n',
    '',
    'falta o timeout-minutes',
  ],
  [
    'um changes com o checkout fixado por tag',
    `actions/checkout@${SHA}`,
    'actions/checkout@v7',
    'o checkout não está fixado por SHA de 40 caracteres',
  ],
  [
    'um changes com o checkout raso (fetch-depth 1)',
    '          fetch-depth: 2\n',
    '          fetch-depth: 1\n',
    'o checkout não usa fetch-depth: 2',
  ],
  [
    'um changes que guarda a credencial no checkout',
    '          persist-credentials: false\n',
    '          persist-credentials: true\n',
    'o checkout guarda a credencial (persist-credentials)',
  ],
  [
    'um test sem o passo que troca os arquivos da lista por pastas',
    CLEANUP_STEP,
    '',
    `test: falta o passo "${CLEANUP_NAME}"`,
  ],
  [
    'um test com o passo que troca os arquivos por pastas depois do npm ci',
    `${CLEANUP_STEP}      - uses: actions/setup-node@${SHA}\n      - run: npm ci\n`,
    `      - uses: actions/setup-node@${SHA}\n      - run: npm ci\n${CLEANUP_STEP}`,
    'test: o passo de troca não vem logo depois do checkout',
  ],
  [
    'um test com o passo que troca os arquivos por pastas sem ler a lista',
    String.raw`printf '%s\n' "$DOCS_ONLY_PATHS" | while`,
    String.raw`printf '%s\n' "README.md" | while`,
    'test: o passo de troca não lê $DOCS_ONLY_PATHS',
  ],
  [
    'um test com o passo que troca os arquivos por pastas sem rm -f --',
    'rm -f --',
    'rm -f',
    'test: o passo de troca não apaga com rm -f --',
  ],
  [
    'um test com o passo que troca os arquivos por pastas sem mkdir -p --',
    'mkdir -p --',
    'mkdir --',
    'test: o passo de troca não cria a pasta com mkdir -p --',
  ],
  [
    'um test com o passo que só apaga os arquivos (o nome antigo, sem o mkdir)',
    `name: ${CLEANUP_NAME}`,
    'name: Tira os arquivos que o AI-53 não testa',
    `test: falta o passo "${CLEANUP_NAME}"`,
  ],
  [
    'um ci-ok sem o env DOCS_ONLY',
    '          DOCS_ONLY: ${{ needs.changes.outputs.docs_only }}\n',
    '',
    'o env DOCS_ONLY não vem de needs.changes.outputs.docs_only',
  ],
  [
    'um ci-ok que não confere o skipped nem o success',
    CI_OK_RULE_LINE,
    'if false; then',
    'o run não cita skipped',
  ],
  [
    'um ci-ok que não cita o success',
    '.value.result == "success" or',
    '.value.result == "ok" or',
    'o run não cita success',
  ],
  [
    'um ci-ok com a guarda sem o length > 0 (o objeto vazio passaria)',
    CI_OK_JSON_GUARD,
    LEGACY_JSON_GUARD,
    'o run não exige length > 0 no RESULTS',
  ],
];

describe('AI-53 as conferências do pulo do test enxergam o que procuram (controle negativo)', () => {
  it('AI-53 a estrutura correta passa em todas as conferências do changes, do test, da troca por pastas e do ci-ok (controle positivo)', () => {
    const good = parseWorkflow(GOOD_STRUCTURE);

    expect(docsOnlyViolations(good)).toEqual([]);
    expect(ciOkBehaviorViolations(good)).toEqual([]);
    expect(ciOkSkipViolations(good)).toEqual([]);
    expect(retryViolations(good)).toEqual([]);
    expect(
      cleanupBehaviorViolations(
        cleanupStepOf(good, 'test'),
        docsPathsTextOf(good),
      ),
    ).toEqual([]);
  }, 60_000);

  it('AI-53 o if do test aceita a forma com ${{ }} em volta', () => {
    const wrapped = parseWorkflow(
      mutated(
        GOOD_STRUCTURE,
        "    if: needs.changes.outputs.docs_only != 'true'\n",
        "    if: ${{ needs.changes.outputs.docs_only != 'true' }}\n",
      ),
    );

    expect(docsOnlyViolations(wrapped)).toEqual([]);
  });

  it.each(STRUCTURE_CASES)('AI-53 %s reprova', (_label, from, to, expected) => {
    const violations = docsOnlyViolations(
      parseWorkflow(mutated(GOOD_STRUCTURE, from, to)),
    );

    expect(violations).toContain(expected);
  });

  it.each([
    [
      'aceita o skipped de qualquer job, com ou sem docs_only',
      '.value.result == "skipped" and $docs == "true" and (.key == "test" or .key == "api-fuzz")',
      '.value.result == "skipped"',
    ],
    [
      'ignora o DOCS_ONLY (o test e o api-fuzz pulados passam sempre)',
      '$docs == "true" and ',
      '',
    ],
    [
      'deixa qualquer job pulado com docs_only true',
      ' and (.key == "test" or .key == "api-fuzz")',
      '',
    ],
    [
      'nunca aceita o pulado (reprova o test e o api-fuzz pulados com docs_only true)',
      '.value.result == "skipped" and',
      '.value.result == "nothing" and',
    ],
  ])(
    'AI-53 um ci-ok que %s reprova no comportamento do skipped, e não no do failure',
    (_label, from, to) => {
      const workflow = variant((t) => t.replace(from, () => to));

      expect(ciOkSkipViolations(workflow)).not.toEqual([]);
      expect(ciOkBehaviorViolations(workflow)).toEqual([]);
    },
  );

  it('AI-53 um ci-ok que deixa o job pulado de outro job passar com docs_only true reprova com o rótulo do job', () => {
    const lenient = variant((t) =>
      t.replace(' and (.key == "test" or .key == "api-fuzz")', () => ''),
    );

    expect(ciOkSkipViolations(lenient)).toEqual([
      'checks skipped com docs_only true: saiu com 0, esperado diferente de 0',
      'changes skipped com docs_only true: saiu com 0, esperado diferente de 0',
    ]);
  });
});

describe('AI-53 o ci.yml pula o test e o api-fuzz em PR só de documentação', () => {
  const ci = readCi();

  it('AI-53 o job changes (Mudanças do PR) tem o checkout fixado com fetch-depth 2 e sem credencial, e o passo decide com a saída docs_only', () => {
    expect(changesJobViolations(ci)).toEqual([]);
  });

  it('AI-53 a lista DOCS_ONLY_PATHS do env do topo tem exatamente os oito caminhos, sem glob', () => {
    expect(docsPathsOf(ci).sort()).toEqual([...DOCS_PATHS].sort());
    expect(docsPathsOf(ci).filter((path) => /[*?[]/.test(path))).toEqual([]);
  });

  it('AI-53 o test depende do changes e só é pulado com docs_only != true', () => {
    expect(testSkipViolations(ci)).toEqual([]);
  });

  it('AI-53 o api-fuzz depende só do changes e só é pulado com docs_only != true', () => {
    expect(skipConditionViolations(ci, 'api-fuzz')).toEqual([]);
  });

  it('AI-53 o test e o api-fuzz trocam os arquivos da lista por pastas logo depois do checkout, lendo DOCS_ONLY_PATHS, com rm -f -- e mkdir -p --', () => {
    expect([
      ...cleanupViolations(ci, 'test'),
      ...cleanupViolations(ci, 'api-fuzz'),
    ]).toEqual([]);
  });

  it('AI-53 o ci-ok depende do changes, recebe RESULTS e DOCS_ONLY por env e lê o RESULTS com jq', () => {
    expect(needsOf(jobOf(ci, 'ci-ok') ?? {})).toContain('changes');
    expect(ciOkViolations(ci)).toEqual([]);
  });

  it('AI-53 o ci.yml pula por job, e não por paths-ignore nem paths (o ci-ok exigido ficaria pendente)', () => {
    expect(jobOf(ci, 'changes')).toBeDefined();
    expect(pathFilterViolations(ci)).toEqual([]);
  });

  it('AI-53 o passo decide real dá true só no PR com os arquivos da lista, e false em push, em diff vazio, em HEAD sem dois pais e em qualquer arquivo fora da lista', () => {
    expect(decideBehaviorViolations(decideStepWithList(ci))).toEqual([]);
  }, 60_000);

  it('AI-53 o passo decide real reprova o passo quando o git falha, e não escreve docs_only=true', () => {
    expect(decideGitErrorViolations(decideStepWithList(ci))).toEqual([]);
  });

  it('AI-53 o passo de troca real do test faz uma pasta vazia de cada um dos oito caminhos (existam ou não, link inclusive), deixa os outros, sai com 0 na segunda execução e o teste inventado que lista a raiz reprova com EISDIR', () => {
    expect(
      cleanupBehaviorViolations(cleanupStepOf(ci, 'test'), docsPathsTextOf(ci)),
    ).toEqual([]);
  });

  it('AI-53 o passo de troca real do api-fuzz faz uma pasta vazia de cada um dos oito caminhos (existam ou não, link inclusive), deixa os outros, sai com 0 na segunda execução e o teste inventado que lista a raiz reprova com EISDIR', () => {
    expect(
      cleanupBehaviorViolations(
        cleanupStepOf(ci, 'api-fuzz'),
        docsPathsTextOf(ci),
      ),
    ).toEqual([]);
  });

  it('AI-53 o passo de shell do ci-ok real aceita o test e o api-fuzz pulados só com docs_only true, e reprova o pulado de qualquer outro job, a falha e o cancelamento', () => {
    expect(ciOkSkipViolations(ci)).toEqual([]);
  }, 60_000);

  it('AI-53 o passo decide real dá true na remoção do README.md e do STATE.md, e false no nome "README.md x" com espaço', () => {
    expect(
      decideBehaviorViolations(decideStepWithList(ci), DECIDE_EDGE_CASES),
    ).toEqual([]);
  }, 60_000);

  it.skipIf(!NEWLINE_NAMES_SUPPORTED)(
    'AI-53 o passo decide real dá false no nome "README.md", quebra de linha, "x": o nome é lido inteiro e fica fora da lista',
    () => {
      expect(
        decideBehaviorViolations(decideStepWithList(ci), [NEWLINE_NAME_CASE]),
      ).toEqual([]);
    },
    60_000,
  );

  it('AI-53 o passo de shell do ci-ok real reprova um RESULTS que não é JSON (lixo, cortado, vazio), com docs_only true e false', () => {
    expect(ciOkInvalidResultsViolations(ci)).toEqual([]);
  }, 60_000);

  it('AI-53 o passo de shell do ci-ok real aceita só success (e skipped do test e do api-fuzz com docs_only true): {}, um job sem result, neutral, um resultado desconhecido e um job que não é objeto reprovam', () => {
    expect(ciOkShapeViolations(ci)).toEqual([]);
    expect(ciOkBehaviorViolations(ci)).toEqual([]);
  }, 60_000);
});
