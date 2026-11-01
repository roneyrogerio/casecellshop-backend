import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutated,
  parseYaml,
  readRepoYaml,
  readWorkflowFile,
  same,
  stepsOfWorkflow,
  workflowsDir,
  type CiJob,
  type CiStep,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// AI-10: o merge segue a aprovação do dono e sai em nome de um GitHub App. Dois workflows:
// - merge-on-approval.yml roda a versão que está no PR; por isso não tem secret nem permissão, e só confere a revisão;
// - merge-by-app.yml roda em workflow_run do anterior, na versão da main, sem checkout, no ambiente `merge`, com o
//   token do App gerado na hora. O `.github/zizmor.yml` dispensa o dangerous-triggers só nele.
// Cada conferência devolve as violações; a lista vazia é o que o arquivo deve ter, e os controles negativos tiram uma
// condição de cada vez de uma cópia em memória.

const APPROVAL_FILE = 'merge-on-approval.yml';
const BY_APP_FILE = 'merge-by-app.yml';
const APP_TOKEN_ACTION =
  'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510';

const APPROVAL_CONDITIONS = [
  "github.event.review.state == 'approved'",
  "github.event.review.author_association == 'OWNER'",
  'github.event.pull_request.head.repo.full_name == github.repository',
];
const BY_APP_CONDITIONS = [
  "github.event.workflow_run.conclusion == 'success'",
  "github.event.workflow_run.event == 'pull_request_review'",
  'github.event.workflow_run.head_repository.full_name == github.repository',
];

interface RunTrigger {
  workflows?: string[];
  types?: string[];
}

const noSpaces = (value: unknown): string => String(value).replace(/\s+/g, '');
const flat = (value: string | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ');
const jobsOf = (workflow: CiWorkflow): [string, CiJob][] =>
  Object.entries(workflow.jobs ?? {});
const runsOf = (steps: CiStep[]): string[] =>
  steps.map((step) => step.run ?? '');

// O PR roda a versão do arquivo que está nele; nenhum dos dois baixa o código do PR.
function checkoutViolations(workflow: CiWorkflow): string[] {
  return stepsOfWorkflow(workflow).some(
    (step) =>
      (step.uses ?? '').startsWith('actions/checkout') ||
      /git checkout|gh pr checkout|git clone|git fetch/.test(step.run ?? ''),
  )
    ? ['baixa o código do PR (checkout)']
    : [];
}

function permissionViolations(workflow: CiWorkflow): string[] {
  const violations: string[] = [];
  if (!same(workflow.permissions, {}))
    violations.push('permissions do topo não é {}');
  for (const [id, job] of jobsOf(workflow))
    if (!same(job.permissions, {}))
      violations.push(`o job ${id} não tem permissions: {}`);
  return violations;
}

// Cada condição obrigatória no `if` do job; uma alternativa (`||`) as desfaria.
function conditionViolations(
  workflow: CiWorkflow,
  required: string[],
): string[] {
  const violations: string[] = [];
  for (const [id, job] of jobsOf(workflow)) {
    const condition = flat(job.if);
    for (const part of required)
      if (!condition.includes(part))
        violations.push(`o if do job ${id} não exige: ${part}`);
    if (condition.includes('||'))
      violations.push(`o if do job ${id} tem uma alternativa (||)`);
  }
  return violations;
}

function approvalViolations(workflow: CiWorkflow): string[] {
  const trigger = workflow.on?.pull_request_review as RunTrigger | undefined;
  const violations = [
    ...permissionViolations(workflow),
    ...conditionViolations(workflow, APPROVAL_CONDITIONS),
    ...checkoutViolations(workflow),
  ];
  if (Object.keys(workflow.on ?? {}).join() !== 'pull_request_review')
    violations.push('o gatilho não é só pull_request_review');
  if (!same(trigger?.types, ['submitted']))
    violations.push('os types não são [submitted]');
  if (jobsOf(workflow).length === 0) violations.push('falta o job');
  if (JSON.stringify(workflow).includes('secrets.'))
    violations.push('usa secrets.');
  if (
    runsOf(stepsOfWorkflow(workflow)).some((run) => run.includes('gh pr merge'))
  )
    violations.push('roda gh pr merge');
  return violations;
}

function environmentName(job: CiJob): unknown {
  const { environment } = job;
  return typeof environment === 'object' && environment !== null
    ? (environment as { name?: unknown }).name
    : environment;
}

// O token do App sai do ambiente `merge`, só com as duas permissões do merge, por action fixada por SHA.
function appTokenViolations(steps: CiStep[]): string[] {
  const step = steps.find((candidate) =>
    (candidate.uses ?? '').startsWith('actions/create-github-app-token@'),
  );
  if (step === undefined) return ['falta o actions/create-github-app-token'];
  const violations: string[] = [];
  if (step.uses !== APP_TOKEN_ACTION)
    violations.push(`a action não é ${APP_TOKEN_ACTION}`);
  const inputs = step.with ?? {};
  if (noSpaces(inputs['client-id']) !== '${{vars.MERGE_APP_CLIENT_ID}}')
    violations.push('client-id não vem de vars.MERGE_APP_CLIENT_ID');
  if (noSpaces(inputs['private-key']) !== '${{secrets.MERGE_APP_PRIVATE_KEY}}')
    violations.push('private-key não vem de secrets.MERGE_APP_PRIVATE_KEY');
  const scopes = Object.entries(inputs)
    .filter(([name]) => name.startsWith('permission-'))
    .map(([name, level]) => `${name}=${String(level)}`)
    .sort();
  if (
    !same(scopes, [
      'permission-contents=write',
      'permission-pull-requests=write',
    ])
  )
    violations.push(`permissões do token: [${scopes.join(', ')}]`);
  return violations;
}

// A conferência da revisão APPROVED de OWNER vem antes do `gh pr merge --auto --merge`, no mesmo script.
function mergeStepViolations(steps: CiStep[]): string[] {
  const merge = steps.find((step) => (step.run ?? '').includes('gh pr merge'));
  if (merge === undefined) return ['falta o passo com gh pr merge'];
  const run = merge.run ?? '';
  const violations: string[] = [];
  const at = run.indexOf('gh pr merge');
  for (const word of ['APPROVED', 'OWNER'])
    if (!run.includes(word)) violations.push(`o passo não confere ${word}`);
    else if (run.indexOf(word) > at)
      violations.push(`${word} é conferido depois do gh pr merge`);
  const command = run.slice(at);
  if (!/--auto\b/.test(command) || !/--merge\b/.test(command))
    violations.push('o gh pr merge não é --auto --merge');
  return violations;
}

const allRuns = (steps: CiStep[]): string => runsOf(steps).join('\n');

// O `gh` lê como número de PR uma branch de nome numérico e, sem PR, sai com erro: o `set -e` deixaria o job vermelho
// em vez de cair no aviso. O PR vem de `gh pr list --head`, aberto e de branch deste repositório, e o `gh pr view`
// só aceita o número já achado.
function prLookupViolations(steps: CiStep[]): string[] {
  const run = allRuns(steps);
  const violations: string[] = [];
  for (const [, target = ''] of run.matchAll(/gh pr view\s+(\S+)/g))
    if (!/^["']?\$\{?(?:pr|PR_NUMBER)\}?["']?$/.test(target))
      violations.push(`gh pr view busca por ${target}, e não pelo número`);
  const list = /gh pr list(?:[^\n\\]|\\\n)*/.exec(run)?.[0];
  if (list === undefined) {
    violations.push('o PR não vem de gh pr list');
    return violations;
  }
  if (!/--head[ =]["']?\$\{?HEAD_BRANCH\}?["']?(?:\s|$)/.test(list))
    violations.push('o gh pr list não filtra por --head "$HEAD_BRANCH"');
  if (!/(?:--state[ =]|-s )open\b/.test(list))
    violations.push('o gh pr list não pede --state open');
  if (
    !/--json[ =]["']?[\w,]*\bisCrossRepository\b/.test(list) ||
    !/select\(\s*(?:\.isCrossRepository\s*==\s*false|\.isCrossRepository\s*\|\s*not|not\s+\.isCrossRepository|!\.isCrossRepository)\s*\)/.test(
      list,
    )
  )
    violations.push('o gh pr list não descarta o PR de outro repositório');
  const variable = /(\w+)=\$\(\s*gh pr list/.exec(run)?.[1];
  const empty =
    variable === undefined
      ? undefined
      : new RegExp(
          `if \\[ -z "\\$\\{?${variable}\\}?" \\]; then([\\s\\S]*?)\\bfi\\b`,
        ).exec(run)?.[1];
  if (empty === undefined)
    violations.push('falta o if que trata a falta de PR');
  else {
    if (!empty.includes('::warning::'))
      violations.push('a falta de PR não deixa um ::warning::');
    if (!/\bexit 0\b/.test(empty))
      violations.push('a falta de PR não termina com exit 0');
  }
  return violations;
}

// A revisão APPROVED de OWNER só vale no commit atual do PR: o commit_id dela é comparado com o headRefOid, lido na hora.
function approvalCommitViolations(steps: CiStep[]): string[] {
  const run = allRuns(steps);
  const violations: string[] = [];
  const head = /(\w+)=\$\(\s*gh pr view[^)\n]*--json headRefOid/.exec(run)?.[1];
  if (head === undefined)
    violations.push('o commit atual do PR (headRefOid) não é lido');
  const filter = /select\(([^\n]*)\)\s*\|/.exec(
    run.slice(run.indexOf('/reviews')),
  )?.[1];
  if (filter === undefined) return [...violations, 'falta o select da revisão'];
  for (const part of ['.state == "APPROVED"', '.author_association == "OWNER"'])
    if (!filter.includes(part))
      violations.push(`o select da revisão não confere ${part}`);
  if (/\bor\b|\|\|/.test(filter))
    violations.push('o select da revisão tem uma alternativa (or)');
  // O jq do `gh api --jq` não tem --arg: a variável chega pelo ambiente do comando (`HEAD="$head" gh api ...`).
  const variable = /\.commit_id\s*==\s*env\.(\w+)/.exec(filter)?.[1];
  if (variable === undefined) {
    violations.push('o select não compara o commit_id com env.<variável>');
    return violations;
  }
  const holder = String.raw`["']?\$\{?${head ?? 'head'}\}?["']?`;
  if (head === undefined || !new RegExp(`\\b${variable}=${holder}`).test(run))
    violations.push('o commit_id não é comparado com o headRefOid do PR');
  return violations;
}

function byAppViolations(
  workflow: CiWorkflow,
  approvalName: string | undefined,
): string[] {
  const trigger = workflow.on?.workflow_run as RunTrigger | undefined;
  const violations = [
    ...permissionViolations(workflow),
    ...conditionViolations(workflow, BY_APP_CONDITIONS),
    ...checkoutViolations(workflow),
  ];
  if (Object.keys(workflow.on ?? {}).join() !== 'workflow_run')
    violations.push('o gatilho não é só workflow_run');
  if (approvalName === undefined || !same(trigger?.workflows, [approvalName]))
    violations.push(`workflows não é [${approvalName}]`);
  if (!same(trigger?.types, ['completed']))
    violations.push('os types não são [completed]');
  if (jobsOf(workflow).length === 0) violations.push('falta o job');
  for (const [id, job] of jobsOf(workflow))
    if (environmentName(job) !== 'merge')
      violations.push(`o job ${id} não usa o environment merge`);
  const steps = stepsOfWorkflow(workflow);
  if (runsOf(steps).some((run) => run.includes('${{')))
    violations.push('um run interpola uma expressão (passe por env)');
  return [
    ...violations,
    ...appTokenViolations(steps),
    ...mergeStepViolations(steps),
  ];
}

// O audit dangerous-triggers dispensado só para o merge-by-app.yml; o nome do arquivo, com ou sem a pasta.
function zizmorViolations(config: unknown): string[] {
  const rules = (config as { rules?: Record<string, { ignore?: unknown }> })
    ?.rules;
  const ignored = rules?.['dangerous-triggers']?.ignore;
  const names = Array.isArray(ignored)
    ? ignored.map((entry) =>
        String(entry)
          .replace(/^\.github\/workflows\//, '')
          .replace(/(?::\d+)+$/, ''),
      )
    : [];
  return same(names, [BY_APP_FILE]) &&
    (ignored as unknown[]).every((entry) => !String(entry).includes('*'))
    ? []
    : [
        `dangerous-triggers ignora [${names.join(', ')}], esperado só ${BY_APP_FILE}`,
      ];
}

// --- linhas de base em memória -----------------------------------------------------------------------------------

const APPROVAL_GOOD = `
name: Merge na aprovação
on:
  pull_request_review:
    types: [submitted]

permissions: {}

jobs:
  approved:
    name: Confere a aprovação do dono
    permissions: {}
    if: >-
      github.event.review.state == 'approved' &&
      github.event.review.author_association == 'OWNER' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - run: echo "Aprovação do dono registrada"
`;

const APPROVER_JOB = '    runs-on: ubuntu-latest\n    steps:\n';

const LOOKUP_COMMAND = `gh pr list --head "$HEAD_BRANCH" --state open --json number,isCrossRepository --jq '.[] | select(.isCrossRepository == false) | .number'`;
const NO_PR_WARNING =
  'echo "::warning::Nenhum PR aberto da branch $HEAD_BRANCH."';
const LOOKUP_LINES = `          set -euo pipefail
          pr=$(${LOOKUP_COMMAND})
          if [ -z "$pr" ]; then
            ${NO_PR_WARNING}
            exit 0
          fi
`;
const HEAD_COMMAND = `gh pr view "$pr" --json headRefOid --jq '.headRefOid'`;
const REVIEW_FILTER = `.state == "APPROVED" and .author_association == "OWNER" and .commit_id == env.HEAD`;
const CHECK_LINES = `          head=$(${HEAD_COMMAND})
          approved=$(HEAD="$head" gh api "repos/$GH_REPO/pulls/$pr/reviews" --paginate \\
            --jq '.[] | select(${REVIEW_FILTER}) | .id')
          if [ -z "$approved" ]; then
            echo "::warning::O PR #$pr não tem aprovação do dono no commit $head."
            exit 0
          fi
`;
const MERGE_LINE = '          gh pr merge "$pr" --auto --merge\n';

const BY_APP_GOOD = `
name: Merge pelo App
on:
  workflow_run:
    workflows: ['Merge na aprovação']
    types: [completed]

permissions: {}

jobs:
  merge:
    name: Liga o auto-merge pelo App
    environment: merge
    permissions: {}
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request_review' &&
      github.event.workflow_run.head_repository.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - id: app-token
        uses: ${APP_TOKEN_ACTION} # v3.1.1
        with:
          client-id: \${{ vars.MERGE_APP_CLIENT_ID }}
          private-key: \${{ secrets.MERGE_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
      - name: Liga o auto-merge com merge commit
        env:
          GH_TOKEN: \${{ steps.app-token.outputs.token }}
          GH_REPO: \${{ github.repository }}
          HEAD_BRANCH: \${{ github.event.workflow_run.head_branch }}
        run: |
${LOOKUP_LINES}${CHECK_LINES}${MERGE_LINE}`;

const ZIZMOR_GOOD = `
rules:
  dangerous-triggers:
    ignore:
      - merge-by-app.yml
`;

type Case = readonly [label: string, from: string, to: string];

const APPROVAL_CASES: Case[] = [
  [
    'com um gatilho a mais',
    '  pull_request_review:\n    types: [submitted]\n',
    '  pull_request_review:\n    types: [submitted]\n  pull_request_target:\n',
  ],
  ['com types além de submitted', '[submitted]', '[submitted, edited]'],
  [
    'com permissão de escrita no topo',
    'permissions: {}\n\njobs:',
    'permissions:\n  contents: write\n\njobs:',
  ],
  ['sem permissions: {} no topo', 'permissions: {}\n\njobs:', 'jobs:'],
  [
    'com permissão no job',
    '    permissions: {}\n',
    '    permissions:\n      contents: write\n',
  ],
  ['sem permissions: {} no job', '    permissions: {}\n', ''],
  [
    'com um secret',
    '      - run: echo "Aprovação do dono registrada"\n',
    '      - env:\n          CHAVE: ${{ secrets.MERGE_APP_PRIVATE_KEY }}\n        run: echo "$CHAVE"\n',
  ],
  [
    'que liga o auto-merge',
    '      - run: echo "Aprovação do dono registrada"\n',
    '      - run: gh pr merge "$PR_NUMBER" --auto --merge\n',
  ],
  [
    'com checkout',
    APPROVER_JOB,
    `${APPROVER_JOB}      - uses: actions/checkout@${'a'.repeat(40)}\n`,
  ],
  [
    'sem exigir a revisão approved',
    "      github.event.review.state == 'approved' &&\n",
    '',
  ],
  [
    'sem exigir o autor OWNER',
    "      github.event.review.author_association == 'OWNER' &&\n",
    '',
  ],
  [
    'sem exigir o PR de branch deste repositório',
    ' &&\n      github.event.pull_request.head.repo.full_name == github.repository',
    '',
  ],
  [
    'com uma alternativa no if',
    "github.event.review.state == 'approved' &&",
    "github.event.review.state == 'approved' || true &&",
  ],
];

const BY_APP_CASES: Case[] = [
  [
    'com o gatilho de outro workflow',
    "['Merge na aprovação']",
    "['Outro workflow']",
  ],
  ['com types diferente de completed', '[completed]', '[requested]'],
  [
    'com o gatilho pull_request_review no lugar',
    "  workflow_run:\n    workflows: ['Merge na aprovação']\n    types: [completed]\n",
    '  pull_request_review:\n    types: [submitted]\n',
  ],
  [
    'com permissão de escrita no topo',
    'permissions: {}\n\njobs:',
    'permissions:\n  contents: write\n\njobs:',
  ],
  [
    'com permissão no job (o GITHUB_TOKEN deve ficar sem)',
    '    permissions: {}\n',
    '    permissions:\n      contents: write\n',
  ],
  ['sem permissions: {} no job', '    permissions: {}\n', ''],
  ['sem o ambiente merge', '    environment: merge\n', ''],
  ['com outro ambiente', 'environment: merge', 'environment: production'],
  [
    'com checkout',
    '    steps:\n',
    `    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n`,
  ],
  [
    'com a action por tag',
    APP_TOKEN_ACTION,
    'actions/create-github-app-token@v3.1.1',
  ],
  [
    'com a action em outro SHA',
    APP_TOKEN_ACTION,
    `actions/create-github-app-token@${'a'.repeat(40)}`,
  ],
  [
    'com o client-id fixo no arquivo',
    '${{ vars.MERGE_APP_CLIENT_ID }}',
    'Iv23liXXXXXXXXXXXXXX',
  ],
  [
    'com o client-id de outra variável',
    'vars.MERGE_APP_CLIENT_ID',
    'vars.OUTRA_VARIAVEL',
  ],
  [
    'com a chave de outro secret',
    'secrets.MERGE_APP_PRIVATE_KEY }}\n          permission',
    'secrets.OUTRO_SECRET }}\n          permission',
  ],
  [
    'sem permission-contents no token',
    '          permission-contents: write\n',
    '',
  ],
  [
    'sem permission-pull-requests no token',
    '          permission-pull-requests: write\n',
    '',
  ],
  [
    'com uma permissão a mais no token',
    '          permission-pull-requests: write\n',
    '          permission-pull-requests: write\n          permission-actions: write\n',
  ],
  [
    'sem exigir a conclusão success',
    "      github.event.workflow_run.conclusion == 'success' &&\n",
    '',
  ],
  [
    'sem exigir o evento pull_request_review',
    "      github.event.workflow_run.event == 'pull_request_review' &&\n",
    '',
  ],
  [
    'sem exigir o PR de branch deste repositório',
    ' &&\n      github.event.workflow_run.head_repository.full_name == github.repository',
    '',
  ],
  [
    'com uma alternativa no if',
    "conclusion == 'success' &&",
    "conclusion == 'success' || true &&",
  ],
  ['sem a conferência da aprovação', CHECK_LINES, ''],
  ['sem conferir a revisão APPROVED', '.state == "APPROVED" and ', ''],
  ['sem conferir o autor OWNER', ' and .author_association == "OWNER"', ''],
  [
    'com a conferência depois do gh pr merge',
    `${CHECK_LINES}${MERGE_LINE}`,
    `${MERGE_LINE}${CHECK_LINES}`,
  ],
  ['sem --auto', ' --auto --merge', ' --merge'],
  ['sem --merge (squash)', '--auto --merge', '--auto --squash'],
  [
    'com a expressão do evento direto no run',
    '"$pr" --auto',
    '${{ github.event.workflow_run.pull_requests[0].number }} --auto',
  ],
];

// A1: a revisão só vale no commit atual do PR.
const COMMIT_CASES: Case[] = [
  ['sem comparar o commit_id da revisão', ' and .commit_id == env.HEAD', ''],
  [
    'com o commit_id como alternativa (or) na conferência',
    ' and .commit_id == env.HEAD',
    ' or .commit_id == env.HEAD',
  ],
  [
    'comparando o commit_id com uma variável que ninguém preenche',
    'env.HEAD',
    'env.OUTRO',
  ],
  [
    'comparando o commit_id com um commit fixo',
    'env.HEAD',
    '"0123456789abcdef"',
  ],
  [
    'sem passar o headRefOid para a comparação',
    'HEAD="$head" gh api',
    'gh api',
  ],
  [
    'passando à comparação outro commit que não o headRefOid',
    'HEAD="$head" gh api',
    'HEAD="$GITHUB_SHA" gh api',
  ],
  [
    'sem ler o headRefOid do PR',
    "--json headRefOid --jq '.headRefOid'",
    "--json number --jq '.number'",
  ],
];

// A2: o PR vem de `gh pr list --head`, aberto e de branch deste repositório, e a falta de PR vira aviso com exit 0.
const LOOKUP_CASES: Case[] = [
  [
    'que busca o PR por gh pr view com a branch',
    LOOKUP_COMMAND,
    `gh pr view "$HEAD_BRANCH" --json number,state --jq 'select(.state == "OPEN") | .number'`,
  ],
  [
    'que busca o PR por gh pr view com a branch sem aspas',
    LOOKUP_COMMAND,
    `gh pr view $HEAD_BRANCH --json number --jq '.number'`,
  ],
  [
    'que lê o commit por gh pr view com a branch',
    HEAD_COMMAND,
    `gh pr view "\${HEAD_BRANCH}" --json headRefOid --jq '.headRefOid'`,
  ],
  [
    'que lê o commit por gh pr view sem o número',
    HEAD_COMMAND,
    `gh pr view --json headRefOid --jq '.headRefOid'`,
  ],
  ['com gh pr list sem --state open', ' --state open', ''],
  [
    'com gh pr list em qualquer estado (--state all)',
    '--state open',
    '--state all',
  ],
  [
    'com gh pr list sem filtrar o PR de outro repositório',
    'select(.isCrossRepository == false)',
    'select(.number > 0)',
  ],
  [
    'com gh pr list que fica com o PR de outro repositório',
    '.isCrossRepository == false',
    '.isCrossRepository == true',
  ],
  [
    'com gh pr list sem pedir isCrossRepository no --json',
    '--json number,isCrossRepository',
    '--json number',
  ],
  ['com gh pr list de outra branch', '--head "$HEAD_BRANCH"', '--head main'],
  ['sem o aviso quando falta o PR', NO_PR_WARNING, 'echo "Nenhum PR aberto"'],
  [
    'com erro no lugar do aviso quando falta o PR',
    NO_PR_WARNING,
    'echo "::error::Nenhum PR aberto"',
  ],
  [
    'sem exit 0 quando falta o PR',
    `${NO_PR_WARNING}\n            exit 0`,
    `${NO_PR_WARNING}\n            exit 1`,
  ],
  [
    'sem tratar a falta de PR',
    `if [ -z "$pr" ]; then`,
    `if [ -z "$approved" ]; then`,
  ],
];

const approvalNameOf = (workflow: CiWorkflow | undefined): string | undefined =>
  workflow?.name;

describe('AI-10 as conferências do merge enxergam o que procuram (controle negativo)', () => {
  const approval = parseYaml<CiWorkflow>(APPROVAL_GOOD);
  const byApp = parseYaml<CiWorkflow>(BY_APP_GOOD);
  const edited = (base: string, from: string, to: string): CiWorkflow =>
    parseYaml<CiWorkflow>(mutated(base, from, to));

  it('AI-10 as linhas de base passam em todas as conferências (controle positivo)', () => {
    expect(approvalViolations(approval)).toEqual([]);
    expect(byAppViolations(byApp, approvalNameOf(approval))).toEqual([]);
    expect(zizmorViolations(parseYaml(ZIZMOR_GOOD))).toEqual([]);
  });

  it.each(APPROVAL_CASES)(
    'AI-10 o merge-on-approval.yml %s reprova',
    (_label, from, to) => {
      expect(approvalViolations(edited(APPROVAL_GOOD, from, to))).not.toEqual(
        [],
      );
    },
  );

  it.each(BY_APP_CASES)(
    'AI-10 o merge-by-app.yml %s reprova',
    (_label, from, to) => {
      expect(
        byAppViolations(
          edited(BY_APP_GOOD, from, to),
          approvalNameOf(approval),
        ),
      ).not.toEqual([]);
    },
  );

  it('AI-10 as linhas de base passam na busca do PR por gh pr list e na comparação do commit_id (controle positivo)', () => {
    const steps = stepsOfWorkflow(byApp);
    expect(prLookupViolations(steps)).toEqual([]);
    expect(approvalCommitViolations(steps)).toEqual([]);
  });

  it.each(COMMIT_CASES)(
    'AI-10 o merge-by-app.yml %s reprova (o commit_id da revisão é o do PR)',
    (_label, from, to) => {
      expect(
        approvalCommitViolations(
          stepsOfWorkflow(edited(BY_APP_GOOD, from, to)),
        ),
      ).not.toEqual([]);
    },
  );

  it.each(LOOKUP_CASES)(
    'AI-10 o merge-by-app.yml %s reprova (o PR vem de gh pr list)',
    (_label, from, to) => {
      expect(
        prLookupViolations(stepsOfWorkflow(edited(BY_APP_GOOD, from, to))),
      ).not.toEqual([]);
    },
  );

  it('AI-10 o merge-by-app.yml que espera um workflow sem nome reprova', () => {
    expect(byAppViolations(byApp, undefined)).not.toEqual([]);
  });

  it.each([
    ['sem o arquivo', undefined],
    ['sem a regra', {}],
    [
      'com outro arquivo na lista',
      { rules: { 'dangerous-triggers': { ignore: ['ci.yml'] } } },
    ],
    [
      'com um arquivo a mais na lista',
      {
        rules: {
          'dangerous-triggers': { ignore: ['merge-by-app.yml', 'ci.yml'] },
        },
      },
    ],
    [
      'com um curinga na lista',
      { rules: { 'dangerous-triggers': { ignore: ['*.yml'] } } },
    ],
    [
      'com outra auditoria dispensada',
      { rules: { 'excessive-permissions': { ignore: ['merge-by-app.yml'] } } },
    ],
  ])('AI-10 o zizmor.yml %s reprova', (_label, config) => {
    expect(zizmorViolations(config)).not.toEqual([]);
  });
});

describe('AI-10 o merge do repositório', () => {
  const approval = readWorkflowFile(APPROVAL_FILE);
  const byApp = readWorkflowFile(BY_APP_FILE);

  it('AI-10 o merge-on-approval.yml roda em revisão enviada, sem secret, sem permissão e sem merge, e só passa para a aprovação do dono num PR deste repositório', () => {
    expect(approvalViolations(approval ?? {})).toEqual([]);
    expect(approval).toBeDefined();
  });

  it('AI-10 o merge-by-app.yml existe', () => {
    expect(existsSync(join(workflowsDir, BY_APP_FILE))).toBe(true);
  });

  it('AI-10 o merge-by-app.yml roda no workflow_run do Merge na aprovação, no ambiente merge, com o token do App, e confere a aprovação do dono antes do auto-merge', () => {
    expect(byAppViolations(byApp ?? {}, approvalNameOf(approval))).toEqual([]);
  });

  it('AI-10 o merge-by-app.yml compara o commit_id da revisão APPROVED de OWNER com o headRefOid do PR', () => {
    expect(byApp).toBeDefined();
    expect(approvalCommitViolations(stepsOfWorkflow(byApp ?? {}))).toEqual([]);
  });

  it('AI-10 o merge-by-app.yml acha o PR por gh pr list --head, aberto e de branch deste repositório, nunca por gh pr view com a branch, e a falta de PR vira aviso com exit 0', () => {
    expect(byApp).toBeDefined();
    expect(prLookupViolations(stepsOfWorkflow(byApp ?? {}))).toEqual([]);
  });

  it('AI-10 o .github/zizmor.yml dispensa o dangerous-triggers só para o merge-by-app.yml', () => {
    expect(zizmorViolations(readRepoYaml('.github', 'zizmor.yml'))).toEqual([]);
    expect(existsSync(join(repoRoot, '.github', 'zizmor.yml'))).toBe(true);
  });
});
