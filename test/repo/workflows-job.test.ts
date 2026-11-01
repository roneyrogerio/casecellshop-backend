import { describe, expect, it } from 'vitest';
import {
  jobOf,
  mutated,
  parseWorkflow,
  readCi,
  stepsOfJob,
  unpinnedUses,
  zizmorStepViolations,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';

// AI-43: o job `workflows` do ci.yml confere os workflows com o actionlint e o zizmor, sem Node. Cada conferência
// devolve as violações; a lista vazia é o que o ci.yml deve ter. Os testes leem só o YAML: a prova real é o CI do PR.

const SHA = 'b'.repeat(40);
const RELEASE = 'https://github.com/rhysd/actionlint/releases/download';
// O sha256 do tarball vem fixo no workflow: um arquivo de checksums baixado da mesma release seria trocado junto com
// uma release trocada, e não prova nada.
const TARBALL_NAME = 'actionlint_1.7.12_linux_amd64.tar.gz';
const TARBALL_SHA256 =
  '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8';
const TARBALL = /^actionlint_(\d+\.\d+\.\d+)_linux_amd64\.tar\.gz$/;
const CHECKSUMS = /^actionlint_(\d+\.\d+\.\d+)_checksums\.txt$/;
const URL_OF_RELEASE = new RegExp(
  `^${RELEASE.replace(/[./]/g, '\\$&')}/v(\\d+\\.\\d+\\.\\d+)/([^/]+)$`,
);

function jobSteps(workflow: CiWorkflow) {
  return stepsOfJob(workflow, 'workflows');
}

// O script do job sem as linhas de comentário, na ordem dos passos, para conferir a ordem dos comandos.
function scriptOf(workflow: CiWorkflow): string {
  return jobSteps(workflow)
    .map((step) => step.run ?? '')
    .join('\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

// Sem Node: nem o setup-node, nem npm ou npx. O checkout não guarda a credencial.
function shapeViolations(workflow: CiWorkflow): string[] {
  const job = jobOf(workflow, 'workflows');
  if (job === undefined) return ['falta o job workflows'];
  const violations: string[] = [];
  if (job.name !== 'Workflows') violations.push(`nome ${String(job.name)}`);
  const [checkout] = jobSteps(workflow);
  if (!(checkout?.uses ?? '').startsWith('actions/checkout@'))
    violations.push('o primeiro passo não é o checkout');
  if (checkout?.with?.['persist-credentials'] !== false)
    violations.push('o checkout não desliga persist-credentials');
  if (jobSteps(workflow).some((s) => (s.uses ?? '').includes('setup-node')))
    violations.push('instala o Node (setup-node)');
  if (/(^|[\s;&|])(?:npm|npx)\s/m.test(scriptOf(workflow)))
    violations.push('roda npm ou npx');
  return [
    ...violations,
    ...unpinnedUses(jobSteps(workflow)).map((uses) => `sem SHA: ${uses}`),
  ];
}

// O tarball vem da release de versão fixa em semver, nunca `latest`; o arquivo de checksums, se ainda for baixado,
// tem de ser da mesma versão, mas não é mais exigido.
function releaseViolations(script: string): string[] {
  const urls = script.match(/https:\/\/[^\s"']+/g) ?? [];
  const found = urls.map((url) => URL_OF_RELEASE.exec(url));
  if (urls.length === 0 || found.some((match) => match === null))
    return ['URL do actionlint fora do formato de versão fixa (vX.Y.Z)'];
  const files = found.map((match) => match?.[2] ?? '');
  const versions = new Set([
    ...found.map((match) => match?.[1]),
    ...files.map((file) => (TARBALL.exec(file) ?? CHECKSUMS.exec(file))?.[1]),
  ]);
  const violations: string[] = [];
  if (!files.some((file) => TARBALL.test(file)))
    violations.push('não baixa o tarball linux_amd64');
  if (versions.size !== 1 || versions.has(undefined))
    violations.push('as versões da URL e dos arquivos divergem');
  return violations;
}

// O sha256 fixo e o nome do tarball ficam na mesma linha, no formato que o `sha256sum --check` lê, antes do `tar`.
function pinnedHashViolations(script: string, extract: number): string[] {
  const pair = script
    .split('\n')
    .find(
      (line) => line.includes(TARBALL_SHA256) && line.includes(TARBALL_NAME),
    );
  if (pair === undefined)
    return [`falta o sha256 fixo ${TARBALL_SHA256} junto de ${TARBALL_NAME}`];
  if (extract >= 0 && script.indexOf(TARBALL_SHA256) > extract)
    return ['o sha256 fixo vem depois do tar'];
  return [];
}

// Baixar, conferir o sha256 fixo, só então extrair e rodar: a ordem importa, porque conferir depois não protege.
function actionlintViolations(workflow: CiWorkflow): string[] {
  const script = scriptOf(workflow);
  const violations = releaseViolations(script);
  const last = (pattern: RegExp): number =>
    Math.max(-1, ...[...script.matchAll(pattern)].map((m) => m.index));
  const download = last(/\b(?:curl|wget)\b/g);
  const check = script.search(/sha256sum\b[^\n]*\s(?:--check|-c)\b/);
  const extract = script.search(/(^|[\s;&|])tar\s+-?\S*x/m);
  const run = script.search(/(^|[\s;&|])\.\/actionlint(\s|$)/m);
  if (download < 0) violations.push('não baixa o actionlint (curl ou wget)');
  if (check < 0) violations.push('não confere o sha256 (sha256sum --check)');
  if (extract < 0) violations.push('não extrai o tarball (tar)');
  if (run < 0) violations.push('não roda ./actionlint');
  violations.push(...pinnedHashViolations(script, extract));
  if (
    [download, check, extract, run].every((at) => at >= 0) &&
    !(download < check && check < extract && extract < run)
  )
    violations.push('a ordem não é baixar, conferir, extrair e rodar');
  if (/\|\|\s*true\b/.test(script)) violations.push('engole o erro (|| true)');
  return violations;
}

function zizmorViolations(workflow: CiWorkflow): string[] {
  return zizmorStepViolations(jobSteps(workflow));
}

// --- linha de base em memória -----------------------------------------------------------------------------------

const GOOD = `
jobs:
  workflows:
    name: Workflows
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA}
        with:
          persist-credentials: false
      - name: actionlint
        run: |
          curl -sSLO ${RELEASE}/v1.7.12/${TARBALL_NAME}
          echo "${TARBALL_SHA256}  ${TARBALL_NAME}" | sha256sum --check
          tar -xzf ${TARBALL_NAME} actionlint
          ./actionlint -color
      - uses: zizmorcore/zizmor-action@${SHA} # v0.8.0
        with:
          version: 1.24.1
          advanced-security: false
          token: \${{ github.token }}
`;

const PINNED_PAIR = `${TARBALL_SHA256}  ${TARBALL_NAME}`;
const CHECK_LINE = `echo "${PINNED_PAIR}" | sha256sum --check`;
const TAR_LINE = `tar -xzf ${TARBALL_NAME} actionlint`;
const CHECK_THEN_TAR = `${CHECK_LINE}
          ${TAR_LINE}`;
const TAR_THEN_CHECK = `${TAR_LINE}
          ${CHECK_LINE}`;
const CHECKSUMS_URL = `${RELEASE}/v1.7.12/actionlint_1.7.12_checksums.txt`;
const ONLY_CHECKSUMS = `curl -sSLO ${CHECKSUMS_URL}
          sha256sum --check --ignore-missing actionlint_1.7.12_checksums.txt`;

function edited(from: string, to: string): CiWorkflow {
  return parseWorkflow(mutated(GOOD, from, to));
}

describe('AI-43 as conferências do job workflows enxergam o que procuram (controle negativo)', () => {
  const good = parseWorkflow(GOOD);

  it('AI-43 o job correto passa na forma, no actionlint e no zizmor (controle positivo)', () => {
    expect(shapeViolations(good)).toEqual([]);
    expect(actionlintViolations(good)).toEqual([]);
    expect(zizmorViolations(good)).toEqual([]);
  });

  it.each([
    ['sem o job', shapeViolations({}), 'falta o job workflows'],
    [
      'com setup-node',
      shapeViolations(
        edited(
          '      - name: actionlint',
          `      - uses: actions/setup-node@${SHA}\n      - name: actionlint`,
        ),
      ),
      'instala o Node (setup-node)',
    ],
    [
      'com npm ci',
      shapeViolations(edited('./actionlint -color', 'npm ci')),
      'roda npm ou npx',
    ],
    [
      'com o checkout que guarda a credencial',
      shapeViolations(edited('persist-credentials: false', 'fetch-depth: 0')),
      'o checkout não desliga persist-credentials',
    ],
    [
      'com uma action por tag',
      shapeViolations(edited(`checkout@${SHA}`, 'checkout@v7.0.1')),
      'sem SHA: actions/checkout@v7.0.1',
    ],
  ])('AI-43 o job %s reprova na forma', (_label, violations, expected) => {
    expect(violations).toContain(expected);
  });

  it.each([
    [
      'a URL com latest',
      `${RELEASE}/v1.7.12/${TARBALL_NAME}`,
      'https://github.com/rhysd/actionlint/releases/latest/download/actionlint_linux_amd64.tar.gz',
    ],
    [
      'o tarball de outra versão que a da URL',
      `${RELEASE}/v1.7.12/${TARBALL_NAME}`,
      `${RELEASE}/v1.7.12/actionlint_1.7.11_linux_amd64.tar.gz`,
    ],
    ['o passo sem sha256sum', CHECK_LINE, 'true'],
    ['o sha256sum sem --check', '| sha256sum --check', '| sha256sum'],
    ['o sha256sum depois do tar', CHECK_THEN_TAR, TAR_THEN_CHECK],
    [
      'só o checksums da mesma release, sem o sha256 fixo',
      CHECK_LINE,
      ONLY_CHECKSUMS,
    ],
    [
      'um sha256 diferente do fixo',
      TARBALL_SHA256,
      `${'0'.repeat(8)}${TARBALL_SHA256.slice(8)}`,
    ],
    [
      'o sha256 fixo sem o nome do tarball na mesma linha',
      PINNED_PAIR,
      `${TARBALL_SHA256}  outro.tar.gz`,
    ],
    [
      'o erro engolido com || true',
      './actionlint -color',
      './actionlint || true',
    ],
    ['o actionlint que não roda', './actionlint -color', 'echo pronto'],
  ])('AI-43 %s reprova no actionlint', (_label, from, to) => {
    expect(actionlintViolations(edited(from, to))).not.toEqual([]);
  });

  it.each([
    ['a version latest', 'version: 1.24.1', 'version: latest'],
    ['a version sem o patch', 'version: 1.24.1', 'version: 1.24'],
    [
      'o advanced-security true',
      'advanced-security: false',
      'advanced-security: true',
    ],
    ['o advanced-security ausente', '          advanced-security: false\n', ''],
    ['o passo sem token', '          token: ${{ github.token }}\n', ''],
    ['a action por tag', `zizmor-action@${SHA}`, 'zizmor-action@v0.8.0'],
    [
      'a action por SHA curto',
      `zizmor-action@${SHA}`,
      `zizmor-action@${'b'.repeat(39)}`,
    ],
  ])('AI-43 %s reprova no zizmor', (_label, from, to) => {
    expect(zizmorViolations(edited(from, to))).not.toEqual([]);
  });
});

describe('AI-43 o ci.yml confere os workflows num job workflows, sem Node', () => {
  const ci = readCi();

  it('AI-43 o job workflows se chama Workflows, não instala o Node nem roda npm, e fixa as actions por SHA', () => {
    expect(shapeViolations(ci)).toEqual([]);
  });

  it('AI-43 o actionlint tem versão fixa na URL e o sha256 é conferido antes de extrair e rodar', () => {
    expect(actionlintViolations(ci)).toEqual([]);
  });

  it('AI-43 o zizmor vem pela zizmor-action fixada por SHA, com version exata, advanced-security false e o token do job', () => {
    expect(zizmorViolations(ci)).toEqual([]);
  });

  it('AI-43 o ci-ok espera o job workflows, para o ruleset exigir só o ci-ok', () => {
    const needs = jobOf(ci, 'ci-ok')?.needs ?? [];

    expect([needs].flat()).toContain('workflows');
  });
});
