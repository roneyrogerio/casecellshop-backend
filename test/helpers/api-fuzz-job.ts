import {
  NOT_CANCELLED,
  same,
  text,
  tokensOf,
  type CiJob,
} from './ci-workflow.ts';

// FND-16: a conferência do job `api-fuzz`, igual no agendado (nightly.yml) e no CI do PR (ci.yml). O que muda entre
// os dois é a semente: o agendado usa a da execução (`github.run_id`), e o PR usa os padrões fixos do compose para a
// execução ser repetível, então não passa `FUZZ_SEED` nem `FUZZ_MAX_EXAMPLES`.
export interface FuzzJob extends CiJob {
  env?: Record<string, unknown>;
}

export type FuzzSeedMode = 'run_id' | 'default';

// Controles negativos que valem nos dois workflows: o texto de `from` existe no job das duas linhas de base e a
// edição tem de fazer a conferência reprovar. Os casos que dependem do SHA, da semente ou do `down` ficam em cada teste.
export type FuzzCase = readonly [label: string, from: string, to: string];

export const FUZZ_STEP = '      - name: Fuzzing com o Schemathesis\n';
export const FUZZ_UPLOAD_IF = '        if: ${{ !cancelled() }}\n';

// A imagem do Schemathesis roda como uid 1000, e o diretório montado em ./schemathesis-report nasce com dono root e
// modo 755 no runner Linux (sem o diretório no checkout, o Docker o cria assim): o Schemathesis não grava o JUnit e
// sai com código 2, antes do fuzzing. O passo cria o diretório gravável por qualquer uid, depois do checkout (que
// limpa a pasta) e antes do fuzzing.
export const REPORT_DIR_RUN = 'install -d -m 0777 schemathesis-report';
export const REPORT_DIR_STEP = `      - name: Cria o diretório do relatório\n        run: ${REPORT_DIR_RUN}\n`;

// Move o passo do diretório para depois do fuzzing (antes do upload), para o controle de ordem: o texto do job é o
// de cada workflow, por isso a edição é uma função e não um par `from`/`to`.
export function reportDirAfterFuzz(jobText: string): string {
  const upload = '      - uses: actions/upload-artifact@';
  return jobText
    .replace(REPORT_DIR_STEP, () => '')
    .replace(upload, () => `${REPORT_DIR_STEP}${upload}`);
}

export const SHARED_FUZZ_CASES: FuzzCase[] = [
  ['sem o passo que cria o schemathesis-report', REPORT_DIR_STEP, ''],
  [
    'criando o schemathesis-report com mkdir sem modo',
    `run: ${REPORT_DIR_RUN}`,
    'run: mkdir schemathesis-report',
  ],
  [
    'criando o schemathesis-report com modo 0755',
    'install -d -m 0777',
    'install -d -m 0755',
  ],
  [
    'criando o schemathesis-report com mkdir -m 0755',
    `run: ${REPORT_DIR_RUN}`,
    'run: mkdir -m 0755 schemathesis-report',
  ],
  [
    'criando outro diretório que não o schemathesis-report',
    `run: ${REPORT_DIR_RUN}`,
    'run: install -d -m 0777 reports',
  ],
  ['sem timeout-minutes', '    timeout-minutes: 30\n', ''],
  [
    'com timeout-minutes por expressão',
    'timeout-minutes: 30',
    "timeout-minutes: ${{ fromJSON('30') }}",
  ],
  [
    'com timeout-minutes em texto',
    'timeout-minutes: 30',
    "timeout-minutes: 'x'",
  ],
  ['com timeout-minutes zero', 'timeout-minutes: 30', 'timeout-minutes: 0'],
  ['com contents: write', '      contents: read\n', '      contents: write\n'],
  [
    'com issues: write além de contents: read',
    '      contents: read\n',
    '      contents: read\n      issues: write\n',
  ],
  [
    'com pull-requests: write além de contents: read',
    '      contents: read\n',
    '      contents: read\n      pull-requests: write\n',
  ],
  [
    'em write-all',
    '    permissions:\n      contents: read\n',
    '    permissions: write-all\n',
  ],
  [
    'com a credencial guardada no checkout',
    'persist-credentials: false',
    'persist-credentials: true',
  ],
  [
    'sem rodar o serviço do fuzzing',
    'docker compose --profile fuzz run --rm schemathesis',
    'echo sem fuzzing',
  ],
  [
    'rodando sem o perfil fuzz',
    'docker compose --profile fuzz run',
    'docker compose run',
  ],
  ['rodando sem --rm', ' --rm schemathesis', ' schemathesis'],
  ['rodando outro serviço', 'run --rm schemathesis', 'run --rm api'],
  [
    'com continue-on-error no fuzzing',
    FUZZ_STEP,
    `${FUZZ_STEP}        continue-on-error: true\n`,
  ],
  ['com o upload sem !cancelled()', FUZZ_UPLOAD_IF, ''],
  ['com o upload só em sucesso', '${{ !cancelled() }}', '${{ success() }}'],
  [
    'com o upload de outro diretório',
    'path: schemathesis-report',
    'path: reports',
  ],
  ['com o down só em sucesso', 'if: always()', 'if: success()'],
  ['com o down só em falha', 'if: always()', 'if: failure()'],
];

const ALWAYS_STEP = /^(?:\$\{\{\s*)?always\(\)(?:\s*\}\})?$/;
const FUZZ_RUN =
  /(^|\n)\s*docker compose --profile fuzz run --rm schemathesis(\s|$)/;
const FUZZ_KNOBS = /FUZZ_(?:SEED|MAX_EXAMPLES)|--seed\b|--max-examples\b/;

// A semente e o número de exemplos vêm do ambiente do compose; o PR não pode mexer em nenhum dos dois, nem pelo env
// do passo ou do job, nem por variável ou flag no próprio `run`.
function defaultsViolations(job: FuzzJob): string[] {
  const violations: string[] = [];
  for (const name of Object.keys(job.env ?? {}))
    if (FUZZ_KNOBS.test(name))
      violations.push(`o env do job define ${name}: o PR usa os padrões`);
  for (const step of job.steps ?? []) {
    for (const name of Object.keys(step.env ?? {}))
      if (FUZZ_KNOBS.test(name))
        violations.push(`um passo define ${name}: o PR usa os padrões`);
    if (FUZZ_KNOBS.test(step.run ?? ''))
      violations.push('um run cita a semente ou o número de exemplos');
  }
  return violations;
}

// O fuzzing roda o serviço do perfil fuzz depois do checkout, guarda o relatório mesmo quando o fuzzing reprova e
// derruba o compose com os volumes ao final, em qualquer resultado.
export function apiFuzzJobViolations(
  job: FuzzJob | undefined,
  seedMode: FuzzSeedMode,
): string[] {
  if (job === undefined) return ['falta o job api-fuzz'];
  const violations: string[] = [];
  const minutes = job['timeout-minutes'];
  if (typeof minutes !== 'number' || !(minutes > 0))
    violations.push('timeout-minutes não é um número positivo');
  // Sem permissions no job vale o topo (só contents: read); com, só contents: read.
  if (
    job.permissions !== undefined &&
    !same(job.permissions, { contents: 'read' })
  )
    violations.push('o job não tem só contents: read');
  const steps = job.steps ?? [];

  const checkoutAt = steps.findIndex((step) =>
    (step.uses ?? '').startsWith('actions/checkout@'),
  );
  if (checkoutAt < 0) violations.push('sem checkout');
  else if (String(steps[checkoutAt]?.with?.['persist-credentials']) !== 'false')
    violations.push('o checkout guarda a credencial');

  const runAt = steps.findIndex((step) => FUZZ_RUN.test(step.run ?? ''));
  const run = steps[runAt];
  if (run === undefined)
    violations.push(
      'sem o passo docker compose --profile fuzz run --rm schemathesis',
    );
  else {
    if (runAt < checkoutAt) violations.push('o fuzzing roda antes do checkout');
    if (run.run?.includes('${{') === true)
      violations.push('o run do fuzzing interpola uma expressão');
    if (run['continue-on-error'] !== undefined)
      violations.push('o fuzzing tem continue-on-error: a falha não reprova');
    if (seedMode === 'run_id') {
      const seed = text(run.env?.['FUZZ_SEED'] ?? job.env?.['FUZZ_SEED']);
      if (seed === '') violations.push('falta FUZZ_SEED no env do fuzzing');
      else if (!seed.includes('github.run_id'))
        violations.push('FUZZ_SEED não depende da execução (github.run_id)');
    }
  }
  const dirAt = steps.findIndex(
    (step) => (step.run ?? '').trim() === REPORT_DIR_RUN,
  );
  if (dirAt < 0)
    violations.push(`sem o passo que cria o relatório (${REPORT_DIR_RUN})`);
  else {
    if (dirAt < checkoutAt)
      violations.push('o diretório do relatório é criado antes do checkout');
    if (runAt >= 0 && dirAt > runAt)
      violations.push('o diretório do relatório é criado depois do fuzzing');
  }
  if (seedMode === 'default') violations.push(...defaultsViolations(job));

  const uploadAt = steps.findIndex((step) =>
    (step.uses ?? '').startsWith('actions/upload-artifact@'),
  );
  const upload = steps[uploadAt];
  if (upload === undefined) violations.push('sem passo upload-artifact');
  else {
    if (uploadAt < runAt) violations.push('o upload vem antes do fuzzing');
    if (!NOT_CANCELLED.test((upload.if ?? '').trim()))
      violations.push(
        `if ${JSON.stringify(upload.if)} do upload não é !cancelled()`,
      );
    if (!text(upload.with?.path).includes('schemathesis-report'))
      violations.push('o artefato não guarda o diretório schemathesis-report');
  }

  const down = steps.at(-1);
  if (
    !/^docker compose (?:--profile fuzz )?down\b/.test((down?.run ?? '').trim())
  )
    violations.push('o último passo não é docker compose down');
  else {
    if (!tokensOf(down?.run ?? '').includes('-v'))
      violations.push('o docker compose down não remove os volumes (-v)');
    if (!ALWAYS_STEP.test((down?.if ?? '').trim()))
      violations.push(`if ${JSON.stringify(down?.if)} do down não é always()`);
  }
  return violations;
}
