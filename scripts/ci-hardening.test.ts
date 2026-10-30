import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  steps?: Step[];
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const root = join(import.meta.dirname, '..');

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
    .filter((run) => /\$\{\{[^}]*github\.(?:base_ref|head_ref)[^}]*\}\}/.test(run));
}

function checkoutsWithCredentials(workflow: Workflow): Step[] {
  return stepsOf(workflow).filter(
    (step) => (step.uses ?? '').startsWith('actions/checkout@') && step.with?.['persist-credentials'] !== false,
  );
}

// O PR pode redefinir um script do próprio package.json; por isso as conferências rodam o arquivo de scripts/,
// que o implementer não escreve (AI-04), e nunca por `npm run`.
function runsNode(workflow: Workflow, file: string): boolean {
  const escaped = file.replace(/[.]/g, '\\.');
  return stepsOf(workflow).some((step) => new RegExp(`(^|\\s)node ${escaped}(\\s|$)`).test(step.run ?? ''));
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
    .filter((run) => /npm\s+run\s+(?:-\S+\s+)*check:(?:scripts|migrations)/.test(run));
}

function topPermissionsAreReadOnly(workflow: Workflow): boolean {
  const permissions = workflow.permissions;
  return permissions !== undefined && Object.keys(permissions).length === 1 && permissions.contents === 'read';
}

const ci = parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')) as Workflow;

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
    expect(topPermissionsAreReadOnly({ permissions: { contents: 'read', 'pull-requests': 'write' } })).toBe(false);
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
    expect(hasScriptsCheck({ jobs: { j: { steps: [{ run: 'npm run check:scripts' }] } } })).toBe(false);
  });

  it('AI-05 a conferência do passo check:migrations reprova a falta dele e a forma por npm run', () => {
    expect(hasMigrationsCheck(BAD)).toBe(false);
    expect(hasMigrationsCheck(GOOD)).toBe(true);
    expect(hasMigrationsCheck({ jobs: { j: { steps: [{ run: 'npm run check:migrations' }] } } })).toBe(false);
  });

  it('AI-05 a conferência das formas fracas enxerga npm run check:scripts e check:migrations, e só elas', () => {
    expect(weakCheckRuns(BAD)).toEqual(['npm run check:scripts', 'npm run check:migrations']);
    expect(weakCheckRuns({ jobs: { j: { steps: [{ run: 'npm run --silent check:scripts' }] } } })).toHaveLength(1);
    expect(weakCheckRuns(GOOD)).toEqual([]);
    expect(weakCheckRuns({ jobs: { j: { steps: [{ run: 'npm run lint' }] } } })).toEqual([]);
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
    expect(stepsOf(ci).some((step) => (step.uses ?? '').startsWith('actions/checkout@'))).toBe(true);
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
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

    expect(pkg.scripts['check:scripts']).toBeTruthy();
  });
});
