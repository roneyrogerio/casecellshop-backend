import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  steps?: Step[];
}

interface Concurrency {
  group?: unknown;
  'cancel-in-progress'?: unknown;
}

interface Workflow {
  permissions?: Record<string, string>;
  concurrency?: Concurrency | string;
  jobs?: Record<string, Job>;
}

const root = join(import.meta.dirname, '..', '..');

function stepsOf(workflow: Workflow): Step[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

// Cada conferência devolve as violações; a lista vazia é o que o ci.yml deve ter.
// O comentário com a versão (`# v7.0.1`) some no parse do YAML, então é livre.
const SHA = /^[^@\s]+@[0-9a-f]{40}$/;

function unpinned(workflow: Workflow): string[] {
  return stepsOf(workflow)
    .map((step) => step.uses)
    .filter((uses): uses is string => uses !== undefined && !SHA.test(uses));
}

function interpolatedRefs(workflow: Workflow): string[] {
  return stepsOf(workflow)
    .map((step) => step.run ?? '')
    .filter((run) =>
      /\$\{\{[^}]*github\.(?:base_ref|head_ref)[^}]*\}\}/.test(run),
    );
}

function checkoutsWithCredentials(workflow: Workflow): Step[] {
  return stepsOf(workflow).filter(
    (step) =>
      (step.uses ?? '').startsWith('actions/checkout@') &&
      step.with?.['persist-credentials'] !== false,
  );
}

// O PR pode redefinir um script do próprio package.json; por isso as conferências rodam o arquivo de scripts/,
// que o implementer não escreve (AI-04), e nunca por `npm run`.
function runsNode(workflow: Workflow, file: string): boolean {
  const escaped = file.replace(/[.]/g, '\\.');
  return stepsOf(workflow).some((step) =>
    new RegExp(`(^|\\s)node ${escaped}(\\s|$)`).test(step.run ?? ''),
  );
}

function hasScriptsCheck(workflow: Workflow): boolean {
  return runsNode(workflow, 'scripts/check-scripts.ts');
}

function hasMigrationsCheck(workflow: Workflow): boolean {
  return runsNode(workflow, 'scripts/check-migrations.ts');
}

// Os run: que chamam as conferências pelo package.json do PR.
function weakCheckRuns(workflow: Workflow): string[] {
  return stepsOf(workflow)
    .map((step) => step.run ?? '')
    .filter((run) =>
      /npm\s+run\s+(?:-\S+\s+)*check:(?:scripts|migrations)/.test(run),
    );
}

function topPermissionsAreReadOnly(workflow: Workflow): boolean {
  const permissions = workflow.permissions;
  return (
    permissions !== undefined &&
    Object.keys(permissions).length === 1 &&
    permissions.contents === 'read'
  );
}

// AI-17: um push novo no mesmo PR cancela a execução anterior; o push da main nunca cancela a anterior.
// O grupo separa o PR (número ou ref) e o workflow; o cancelamento é uma expressão só verdadeira em pull_request.
function concurrencyOf(workflow: Workflow): Concurrency | undefined {
  return typeof workflow.concurrency === 'object'
    ? workflow.concurrency
    : undefined;
}

function groupSeparatesPrAndWorkflow(workflow: Workflow): boolean {
  const group = concurrencyOf(workflow)?.group;
  if (typeof group !== 'string') return false;
  return (
    group.includes('github.workflow') &&
    /github\.event\.pull_request\.number|github\.head_ref|github\.ref/.test(
      group,
    )
  );
}

function cancelsOnlyPullRequests(workflow: Workflow): boolean {
  const cancel = concurrencyOf(workflow)?.['cancel-in-progress'];
  return (
    typeof cancel === 'string' &&
    /github\.event_name\s*==\s*'pull_request'/.test(cancel)
  );
}

const ci = parse(
  readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
) as Workflow;

const GOOD_SHA = 'a'.repeat(40);

// Entradas de propósito erradas: provam que cada conferência enxerga a violação que procura.
const BAD = parse(`
permissions: write-all
jobs:
  j:
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@${'a'.repeat(39)}
      - uses: actions/cache@main
      - run: echo \${{ github.base_ref }}
      - run: git fetch origin \${{ github.head_ref }}
      - run: npm test
      - run: npm run check:scripts
      - run: npm run check:migrations
`) as Workflow;

const GOOD = parse(`
permissions:
  contents: read
jobs:
  j:
    steps:
      - uses: actions/checkout@${GOOD_SHA} # v7.0.1
        with:
          persist-credentials: false
      - run: node scripts/check-scripts.ts
      - run: node scripts/check-migrations.ts
      - run: echo "$BASE_REF"
        env:
          BASE_REF: \${{ github.base_ref }}
`) as Workflow;

describe('AI-05 as conferências do ci.yml enxergam o que procuram (controle negativo)', () => {
  it('AI-05 a conferência de permissões reprova permissions: write-all e aceita contents: read', () => {
    expect(topPermissionsAreReadOnly(BAD)).toBe(false);
    expect(
      topPermissionsAreReadOnly({
        permissions: { contents: 'read', 'pull-requests': 'write' },
      }),
    ).toBe(false);
    expect(topPermissionsAreReadOnly({})).toBe(false);
    expect(topPermissionsAreReadOnly(GOOD)).toBe(true);
  });

  it('AI-05 a conferência de SHA reprova tag, ramo e SHA curto, e aceita 40 hexadecimais', () => {
    expect(unpinned(BAD)).toEqual([
      'actions/checkout@v7.0.1',
      `actions/setup-node@${'a'.repeat(39)}`,
      'actions/cache@main',
    ]);
    expect(unpinned(GOOD)).toEqual([]);
  });

  it('AI-05 a conferência de base_ref reprova a interpolação em run: e aceita no env:', () => {
    expect(interpolatedRefs(BAD)).toHaveLength(2);
    expect(interpolatedRefs(GOOD)).toEqual([]);
  });

  it('AI-05 a conferência do checkout reprova o que não desliga as credenciais', () => {
    expect(checkoutsWithCredentials(BAD)).toHaveLength(1);
    expect(checkoutsWithCredentials(GOOD)).toEqual([]);
  });

  it('AI-05 a conferência do passo check:scripts reprova a falta dele e a forma por npm run', () => {
    expect(hasScriptsCheck(BAD)).toBe(false);
    expect(hasScriptsCheck(GOOD)).toBe(true);
    expect(
      hasScriptsCheck({
        jobs: { j: { steps: [{ run: 'npm run check:scripts' }] } },
      }),
    ).toBe(false);
  });

  it('AI-05 a conferência do passo check:migrations reprova a falta dele e a forma por npm run', () => {
    expect(hasMigrationsCheck(BAD)).toBe(false);
    expect(hasMigrationsCheck(GOOD)).toBe(true);
    expect(
      hasMigrationsCheck({
        jobs: { j: { steps: [{ run: 'npm run check:migrations' }] } },
      }),
    ).toBe(false);
  });

  it('AI-05 a conferência das formas fracas enxerga npm run check:scripts e check:migrations, e só elas', () => {
    expect(weakCheckRuns(BAD)).toEqual([
      'npm run check:scripts',
      'npm run check:migrations',
    ]);
    expect(
      weakCheckRuns({
        jobs: { j: { steps: [{ run: 'npm run --silent check:scripts' }] } },
      }),
    ).toHaveLength(1);
    expect(weakCheckRuns(GOOD)).toEqual([]);
    expect(
      weakCheckRuns({ jobs: { j: { steps: [{ run: 'npm run lint' }] } } }),
    ).toEqual([]);
  });
});

describe('AI-17 as conferências da concurrency enxergam o que procuram (controle negativo)', () => {
  const GOOD_CONCURRENCY = parse(`
concurrency:
  group: \${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
`) as Workflow;

  it('AI-17 a conferência do grupo reprova grupo fixo, sem o PR ou sem o workflow, e aceita workflow mais PR ou ref', () => {
    expect(groupSeparatesPrAndWorkflow({})).toBe(false);
    expect(groupSeparatesPrAndWorkflow({ concurrency: { group: 'ci' } })).toBe(
      false,
    );
    expect(
      groupSeparatesPrAndWorkflow({
        concurrency: { group: '${{ github.workflow }}' },
      }),
    ).toBe(false);
    expect(
      groupSeparatesPrAndWorkflow({
        concurrency: { group: '${{ github.ref }}' },
      }),
    ).toBe(false);
    expect(groupSeparatesPrAndWorkflow({ concurrency: 'ci' })).toBe(false);
    expect(groupSeparatesPrAndWorkflow(GOOD_CONCURRENCY)).toBe(true);
    expect(
      groupSeparatesPrAndWorkflow({
        concurrency: { group: '${{ github.workflow }}-${{ github.ref }}' },
      }),
    ).toBe(true);
  });

  it('AI-17 a conferência do cancelamento reprova true fixo, ausência e outra condição, e aceita o event_name', () => {
    expect(cancelsOnlyPullRequests({})).toBe(false);
    expect(
      cancelsOnlyPullRequests({
        concurrency: { group: 'g', 'cancel-in-progress': true },
      }),
    ).toBe(false);
    expect(
      cancelsOnlyPullRequests({
        concurrency: { group: 'g', 'cancel-in-progress': 'true' },
      }),
    ).toBe(false);
    expect(
      cancelsOnlyPullRequests({
        concurrency: {
          group: 'g',
          'cancel-in-progress': "${{ github.ref != 'refs/heads/main' }}",
        },
      }),
    ).toBe(false);
    expect(cancelsOnlyPullRequests(GOOD_CONCURRENCY)).toBe(true);
  });
});

describe('AI-17 o ci.yml cancela a execução anterior do mesmo PR e nunca a da main', () => {
  it('AI-17 declara concurrency no nível do workflow, e não só dentro de um job', () => {
    expect(concurrencyOf(ci)).toBeDefined();
  });

  it('AI-17 o grupo separa o PR (número ou ref) e o workflow', () => {
    expect(groupSeparatesPrAndWorkflow(ci)).toBe(true);
  });

  it('AI-17 cancel-in-progress é a expressão github.event_name == pull_request, e não true fixo', () => {
    expect(cancelsOnlyPullRequests(ci)).toBe(true);
  });

  it('AI-17 o workflow continua rodando no push da main', () => {
    const triggers = (ci as { on?: { push?: { branches?: string[] } } }).on;

    expect(triggers?.push?.branches).toContain('main');
  });
});

// AI-18: o npm test grava o relatório JSON do Vitest, e um passo à parte, só no Node do .nvmrc e mesmo com teste
// falhando, roda o criteria-report.ts sobre esse arquivo e anexa a saída ao resumo da execução.
// AI-42: o teste e a tabela vivem no job `test`; o `checks` não roda teste.
function testJobSteps(workflow: Workflow): Step[] {
  return workflow.jobs?.test?.steps ?? [];
}

function testStep(workflow: Workflow): Step | undefined {
  return testJobSteps(workflow).find((step) =>
    /(^|\s)npm\s+(?:run\s+)?test(\s|$)/.test(step.run ?? ''),
  );
}

// O arquivo do relatório, quando o passo do npm test pede o reporter json e um arquivo de saída.
function reportFileOf(workflow: Workflow): string | null {
  const run = testStep(workflow)?.run ?? '';
  if (!/--reporter[= ]json(\s|$)/.test(run)) return null;
  return /--outputFile(?:\.json)?[= ](\S+)/.exec(run)?.[1] ?? null;
}

const REPORT_SCRIPT = 'scripts/criteria-report.ts';

function summaryStep(workflow: Workflow): Step | undefined {
  return testJobSteps(workflow).find((step) =>
    runsNode({ jobs: { j: { steps: [step] } } }, REPORT_SCRIPT),
  );
}

// O passo lê o mesmo arquivo que o npm test grava.
function summaryReadsTheTestReport(workflow: Workflow): boolean {
  const file = reportFileOf(workflow);
  const run = summaryStep(workflow)?.run ?? '';
  if (file === null) return false;
  return run.includes(`node ${REPORT_SCRIPT} ${file}`);
}

// O shellcheck do actionlint (AI-43) reprova a variável do shell sem aspas (SC2086): o caminho com `$` vai entre aspas
// duplas, no npm test e no passo do resumo.
function reportPathIsQuoted(workflow: Workflow): boolean {
  const file = reportFileOf(workflow);
  if (file === null) return false;
  return !file.includes('$') || /^"[^"]+"$/.test(file);
}

function appendsToStepSummary(step: Step | undefined): boolean {
  return />>\s*"?\$\{?GITHUB_STEP_SUMMARY\}?"?/.test(step?.run ?? '');
}

function runsOnlyOnNvmrcNode(step: Step | undefined): boolean {
  return /matrix\.node\s*==\s*'nvmrc'/.test(step?.if ?? '');
}

function runsEvenWhenTestsFail(step: Step | undefined): boolean {
  return /(?:always\(\)|!\s*cancelled\(\))/.test(step?.if ?? '');
}

function summaryAfterTests(workflow: Workflow): boolean {
  const steps = testJobSteps(workflow);
  const test = testStep(workflow);
  const summary = summaryStep(workflow);
  return (
    test !== undefined &&
    summary !== undefined &&
    steps.indexOf(summary) > steps.indexOf(test)
  );
}

function reportByNpmRun(workflow: Workflow): string[] {
  return stepsOf(workflow)
    .map((step) => step.run ?? '')
    .filter((run) => /npm\s+run\s+(?:-\S+\s+)*\S*criteria-report/.test(run));
}

describe('AI-18 as conferências do resumo da execução enxergam o que procuram (controle negativo)', () => {
  const GOOD_SUMMARY = parse(`
jobs:
  test:
    steps:
      - run: npm test -- --reporter=default --reporter=json --outputFile.json=vitest-report.json
      - name: Tabela critério × teste
        if: \${{ always() && matrix.node == 'nvmrc' }}
        run: node scripts/criteria-report.ts vitest-report.json >> "$GITHUB_STEP_SUMMARY"
`) as Workflow;

  const BAD_SUMMARY = parse(`
jobs:
  test:
    steps:
      - run: node scripts/criteria-report.ts other.json
      - run: npm test
      - name: Tabela
        if: success()
        run: npm run criteria-report vitest-report.json
`) as Workflow;

  it('AI-18 o relatório JSON só vale com o reporter json e o arquivo de saída', () => {
    expect(reportFileOf(GOOD_SUMMARY)).toBe('vitest-report.json');
    expect(reportFileOf(BAD_SUMMARY)).toBeNull();
    expect(
      reportFileOf({
        jobs: { test: { steps: [{ run: 'npm test -- --reporter=json' }] } },
      }),
    ).toBeNull();
    expect(
      reportFileOf({
        jobs: {
          test: { steps: [{ run: 'npm test -- --outputFile.json=r.json' }] },
        },
      }),
    ).toBeNull();
    expect(
      reportFileOf({
        jobs: {
          test: {
            steps: [{ run: 'npm test -- --reporter=json --outputFile=r.json' }],
          },
        },
      }),
    ).toBe('r.json');
    // O relatório de um npm test fora do job `test` não vale.
    expect(
      reportFileOf({
        jobs: {
          checks: {
            steps: [{ run: 'npm test -- --reporter=json --outputFile=r.json' }],
          },
        },
      }),
    ).toBeNull();
  });

  it('AI-18 o passo do resumo só vale com node, o mesmo arquivo do npm test e depois dele', () => {
    // Só o job `test` conta: o mesmo passo no `checks` não é a tabela do AI-18.
    expect(
      summaryStep({
        jobs: {
          checks: {
            steps: [{ run: 'node scripts/criteria-report.ts r.json' }],
          },
        },
      }),
    ).toBeUndefined();
    expect(summaryReadsTheTestReport(GOOD_SUMMARY)).toBe(true);
    expect(summaryAfterTests(GOOD_SUMMARY)).toBe(true);
    expect(summaryReadsTheTestReport(BAD_SUMMARY)).toBe(false);
    expect(summaryAfterTests(BAD_SUMMARY)).toBe(false);
    expect(
      summaryStep({
        jobs: { j: { steps: [{ run: 'npm run criteria-report x.json' }] } },
      }),
    ).toBeUndefined();
  });

  it('AI-18 o caminho do relatório com $RUNNER_TEMP exige aspas duplas, e a forma sem aspas reprova', () => {
    const withPath = (path: string): Workflow =>
      parse(`
jobs:
  test:
    steps:
      - run: npm test -- --reporter=json --outputFile.json=${path}
      - run: node scripts/criteria-report.ts ${path} >> "$GITHUB_STEP_SUMMARY"
`) as Workflow;

    expect(reportPathIsQuoted(GOOD_SUMMARY)).toBe(true);
    expect(
      reportPathIsQuoted(withPath('"$RUNNER_TEMP/vitest-report.json"')),
    ).toBe(true);
    expect(summaryReadsTheTestReport(withPath('"$RUNNER_TEMP/r.json"'))).toBe(
      true,
    );
    expect(
      reportPathIsQuoted(withPath('$RUNNER_TEMP/vitest-report.json')),
    ).toBe(false);
    expect(reportPathIsQuoted(BAD_SUMMARY)).toBe(false);
  });

  it('AI-18 anexar ao resumo exige >> $GITHUB_STEP_SUMMARY', () => {
    expect(appendsToStepSummary(summaryStep(GOOD_SUMMARY))).toBe(true);
    expect(appendsToStepSummary(summaryStep(BAD_SUMMARY))).toBe(false);
    expect(
      appendsToStepSummary({ run: 'node scripts/criteria-report.ts r.json' }),
    ).toBe(false);
    expect(
      appendsToStepSummary({
        run: 'node scripts/criteria-report.ts r.json >> $GITHUB_STEP_SUMMARY',
      }),
    ).toBe(true);
  });

  it('AI-18 a condição exige o Node do .nvmrc e rodar também com teste falhando', () => {
    const good = summaryStep(GOOD_SUMMARY);
    expect(runsOnlyOnNvmrcNode(good)).toBe(true);
    expect(runsEvenWhenTestsFail(good)).toBe(true);
    expect(runsOnlyOnNvmrcNode({ if: 'always()' })).toBe(false);
    expect(runsEvenWhenTestsFail({ if: "matrix.node == 'nvmrc'" })).toBe(false);
    expect(
      runsEvenWhenTestsFail({ if: "success() && matrix.node == 'nvmrc'" }),
    ).toBe(false);
    expect(
      runsEvenWhenTestsFail({
        if: "${{ !cancelled() && matrix.node == 'nvmrc' }}",
      }),
    ).toBe(true);
    expect(runsOnlyOnNvmrcNode(undefined)).toBe(false);
  });

  it('AI-18 a forma por npm run para o criteria-report é enxergada', () => {
    expect(reportByNpmRun(BAD_SUMMARY)).toHaveLength(1);
    expect(reportByNpmRun(GOOD_SUMMARY)).toEqual([]);
  });
});

describe('AI-18 o ci.yml publica a tabela critério × teste no resumo da execução', () => {
  it('AI-18 o passo do npm test grava o relatório JSON do Vitest num arquivo', () => {
    expect(testStep(ci)).toBeDefined();
    expect(reportFileOf(ci)).not.toBeNull();
  });

  it('AI-18 há um passo node scripts/criteria-report.ts sobre o mesmo arquivo do relatório', () => {
    expect(summaryStep(ci)).toBeDefined();
    expect(summaryReadsTheTestReport(ci)).toBe(true);
  });

  it('AI-18 o caminho do relatório vai entre aspas duplas no npm test e no passo do resumo', () => {
    expect(reportFileOf(ci)).toBe('"$RUNNER_TEMP/vitest-report.json"');
    expect(reportPathIsQuoted(ci)).toBe(true);
    expect(summaryStep(ci)?.run).toContain(
      'node scripts/criteria-report.ts "$RUNNER_TEMP/vitest-report.json"',
    );
  });

  it('AI-18 o passo roda depois do npm test e anexa a saída ao $GITHUB_STEP_SUMMARY', () => {
    expect(summaryAfterTests(ci)).toBe(true);
    expect(appendsToStepSummary(summaryStep(ci))).toBe(true);
  });

  it('AI-18 o passo só roda no Node do .nvmrc (matrix.node == nvmrc)', () => {
    expect(runsOnlyOnNvmrcNode(summaryStep(ci))).toBe(true);
  });

  it('AI-18 o passo roda também quando os testes falham (always() ou !cancelled())', () => {
    expect(runsEvenWhenTestsFail(summaryStep(ci))).toBe(true);
  });

  it('AI-18 o criteria-report roda com node, e não por npm run (AI-05)', () => {
    expect(runsNode(ci, REPORT_SCRIPT)).toBe(true);
    expect(reportByNpmRun(ci)).toEqual([]);
  });
});

// AI-05, M2: a conferência dos tipos do banco (FND-09) também roda com node, e nunca por npm run. O nome do
// script no package.json não está no critério: a forma por npm run é reconhecida pelo corpo do script, que chama
// o arquivo de scripts/. As formas do Kysely (AI-19) saíram do ci.yml: viraram regra de lint, que o passo
// `npm run lint` já roda, e o script antigo não tem mais passo.
const DB_TYPES_SCRIPT = 'scripts/check-db-types.ts';
const OLD_KYSELY_SCRIPT = 'scripts/check-kysely-usage.ts';

// Os tipos do banco rodam no job `test`, só no Node do .nvmrc (AI-42).
function stepRunningNode(workflow: Workflow, file: string): Step | undefined {
  return testJobSteps(workflow).find((step) =>
    runsNode({ jobs: { j: { steps: [step] } } }, file),
  );
}

// Os run: que chamam, por npm run, um script do package.json cujo corpo roda um dos arquivos.
function npmRunsOf(
  workflow: Workflow,
  scripts: Record<string, string>,
  files: string[],
): string[] {
  const names = Object.entries(scripts)
    .filter(([, body]) => files.some((file) => body.includes(file)))
    .map(([name]) => name);
  return stepsOf(workflow)
    .map((step) => step.run ?? '')
    .filter((run) => {
      const called = /npm\s+(?:run|run-script)\s+(?:-\S+\s+)*([^\s&;|]+)/g;
      return [...run.matchAll(called)].some((match) =>
        names.includes(match[1] ?? ''),
      );
    });
}

describe('AI-05 as conferências dos tipos do banco e do Kysely no ci.yml enxergam o que procuram (controle negativo)', () => {
  const SCRIPTS = {
    'check:db-types': 'node scripts/check-db-types.ts',
    lint: 'oxlint',
  };

  const GOOD_M2 = parse(`
jobs:
  test:
    steps:
      - name: Tipos
        if: matrix.node == 'nvmrc'
        run: node scripts/check-db-types.ts
      - run: npm run lint
`) as Workflow;

  const BAD_M2 = parse(`
jobs:
  test:
    steps:
      - run: npm run check:db-types
      - run: npm run lint
`) as Workflow;

  // O passo antigo das formas do Kysely: a conferência de que ele sumiu só vale se enxerga um que exista.
  const WITH_OLD_KYSELY_STEP = parse(`
jobs:
  j:
    steps:
      - name: Formas do Kysely
        run: node scripts/check-kysely-usage.ts
      - run: npm run lint
`) as Workflow;

  it('AI-05 a conferência do passo reprova a falta dele e a forma por npm run, e aceita node scripts/...', () => {
    expect(stepRunningNode(GOOD_M2, DB_TYPES_SCRIPT)).toBeDefined();
    expect(stepRunningNode(BAD_M2, DB_TYPES_SCRIPT)).toBeUndefined();
    expect(stepRunningNode({}, DB_TYPES_SCRIPT)).toBeUndefined();
    // No job `checks` não vale: a conferência sobe o PostgreSQL e roda uma vez, no job `test`.
    expect(
      stepRunningNode(
        {
          jobs: {
            checks: { steps: [{ run: 'node scripts/check-db-types.ts' }] },
          },
        },
        DB_TYPES_SCRIPT,
      ),
    ).toBeUndefined();
  });

  it('AI-05 a conferência por npm run enxerga a dos tipos do banco e só ela', () => {
    expect(npmRunsOf(BAD_M2, SCRIPTS, [DB_TYPES_SCRIPT])).toEqual([
      'npm run check:db-types',
    ]);
    expect(npmRunsOf(GOOD_M2, SCRIPTS, [DB_TYPES_SCRIPT])).toEqual([]);
  });

  it('AI-05 a condição do Node do .nvmrc enxerga a falta dela', () => {
    expect(runsOnlyOnNvmrcNode(stepRunningNode(GOOD_M2, DB_TYPES_SCRIPT))).toBe(
      true,
    );
    expect(runsOnlyOnNvmrcNode(stepRunningNode(BAD_M2, DB_TYPES_SCRIPT))).toBe(
      false,
    );
  });

  it('AI-05 a conferência da falta do passo antigo do Kysely enxerga um passo que ainda exista', () => {
    expect(runsNode(WITH_OLD_KYSELY_STEP, OLD_KYSELY_SCRIPT)).toBe(true);
    expect(runsNode(GOOD_M2, OLD_KYSELY_SCRIPT)).toBe(false);
    expect(
      citingKysely(WITH_OLD_KYSELY_STEP).length,
      'o detector enxerga o passo antigo',
    ).toBe(1);
    expect(citingKysely(GOOD_M2)).toEqual([]);
  });
});

// Os run: que citam a conferência antiga do Kysely, pelo arquivo ou pelo nome do script.
function citingKysely(workflow: Workflow): string[] {
  return stepsOf(workflow)
    .map((step) => step.run ?? '')
    .filter((run) => /check[-:]kysely/.test(run));
}

describe('AI-05 o ci.yml roda a conferência dos tipos do banco e não tem mais a do Kysely', () => {
  const pkgScripts = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('AI-05 o passo dos tipos do banco roda node scripts/check-db-types.ts', () => {
    expect(runsNode(ci, DB_TYPES_SCRIPT)).toBe(true);
  });

  it('AI-05 o passo dos tipos do banco só roda no Node do .nvmrc (matrix.node == nvmrc)', () => {
    expect(runsOnlyOnNvmrcNode(stepRunningNode(ci, DB_TYPES_SCRIPT))).toBe(
      true,
    );
  });

  it('AI-05 o ci.yml não tem mais o passo node scripts/check-kysely-usage.ts', () => {
    expect(runsNode(ci, OLD_KYSELY_SCRIPT)).toBe(false);
    expect(stepRunningNode(ci, OLD_KYSELY_SCRIPT)).toBeUndefined();
  });

  it('AI-05 nenhum run: do ci.yml cita a conferência antiga do Kysely, nem pelo arquivo nem por npm run check:kysely', () => {
    expect(citingKysely(ci)).toEqual([]);
  });

  it('AI-05 as formas do Kysely vão pelo lint: o ci.yml roda npm run lint, que carrega a regra (AI-19)', () => {
    const lintSteps = stepsOf(ci).filter(
      (step) => (step.run ?? '').trim() === 'npm run lint',
    );

    expect(lintSteps).toHaveLength(1);
    expect(lintSteps[0]?.if).toBeUndefined();
  });

  it('AI-05 a conferência dos tipos do banco não roda por npm run, qualquer que seja o nome do script no package.json', () => {
    expect(npmRunsOf(ci, pkgScripts, [DB_TYPES_SCRIPT])).toEqual([]);
  });

  it('AI-05 nenhum run: do ci.yml cita a conferência dos tipos do banco sem ser por node scripts/...', () => {
    const offenders = stepsOf(ci)
      .map((step) => step.run ?? '')
      .filter((run) => /check-db-types/.test(run))
      .filter(
        (run) => !/(^|\s)node scripts\/check-db-types\.ts(\s|$)/.test(run),
      );

    expect(offenders).toEqual([]);
  });
});

describe('AI-05 o ci.yml é endurecido', () => {
  it('AI-05 declara permissions: contents: read no topo, e só isso', () => {
    expect(ci.permissions).toEqual({ contents: 'read' });
  });

  it('AI-05 fixa todo uses: por SHA de 40 hexadecimais', () => {
    expect(stepsOf(ci).some((step) => step.uses !== undefined)).toBe(true);
    expect(unpinned(ci)).toEqual([]);
  });

  it('AI-05 não interpola github.base_ref nem github.head_ref em run:', () => {
    expect(interpolatedRefs(ci)).toEqual([]);
  });

  it('AI-05 faz todo actions/checkout com persist-credentials: false', () => {
    expect(
      stepsOf(ci).some((step) =>
        (step.uses ?? '').startsWith('actions/checkout@'),
      ),
    ).toBe(true);
    expect(checkoutsWithCredentials(ci)).toEqual([]);
  });

  it('AI-05 o passo de scripts roda node scripts/check-scripts.ts, e não npm run check:scripts', () => {
    expect(hasScriptsCheck(ci)).toBe(true);
  });

  it('AI-05 o passo de migrações roda node scripts/check-migrations.ts, e não npm run check:migrations', () => {
    expect(hasMigrationsCheck(ci)).toBe(true);
  });

  it('AI-05 nenhum run: do ci.yml chama check:scripts nem check:migrations por npm run', () => {
    expect(weakCheckRuns(ci)).toEqual([]);
  });

  it('AI-05 o package.json tem o script check:scripts', () => {
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(pkg.scripts['check:scripts']).toBeTruthy();
  });
});
