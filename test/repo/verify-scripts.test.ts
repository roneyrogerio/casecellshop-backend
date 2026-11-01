import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

// AI-17: `npm run verify` espelha o CI sem os testes de integração; `npm run verify:full` troca os testes
// unitários por todos os testes. Os dois são listas de `npm run` ligadas por `&&`.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

// Cada passo vira o nome do script, com os argumentos depois de `--` quando há: `openapi -- --check`.
// `npm test` é o mesmo script `test`. Devolve null para um passo que não é `npm run`/`npm test`.
function stepName(step: string): string | null {
  const text = step.trim().replace(/\s+/g, ' ');
  if (text === 'npm test' || text === 'npm run test') return 'test';
  const match = /^npm run (?:--silent |-s )?([^\s]+)(?: (-- .+))?$/.exec(text);
  if (match === null) return null;
  return match[2] === undefined ? (match[1] ?? '') : `${match[1]} ${match[2]}`;
}

function stepsOf(script: string | undefined): (string | null)[] {
  return (script ?? '').split('&&').map(stepName);
}

const COMMON = [
  'lint',
  'typecheck',
  'openapi -- --check',
  'lint:openapi',
  'check:instructions',
  'check:migrations',
  'check:scripts',
  // AI-34: o pre-push reprova um arquivo fora do formato do Prettier.
  'format:check',
];

// O critério não dá o nome do script da conferência dos tipos do banco (FND-09): ele é achado pelo corpo, que chama
// o arquivo de scripts/ com node, como o ci.yml (AI-05). As formas do Kysely (AI-19) saíram dos scripts: viraram
// regra do lint, que já está na lista comum.
function scriptsRunning(
  file: string,
  scripts: Record<string, string>,
): string[] {
  return Object.entries(scripts)
    .filter(([, body]) => body.trim() === `node ${file}`)
    .map(([name]) => name);
}

// AI-35 e AI-36: o knip e o jscpd entram no verify por um script cujo corpo chama o binário; o nome do script
// também não vem do critério.
function scriptsCalling(
  binary: string,
  scripts: Record<string, string>,
): string[] {
  return Object.entries(scripts)
    .filter(([, body]) => new RegExp(`^${binary}(\\s|$)`).test(body.trim()))
    .map(([name]) => name);
}

// A conferência antiga do Kysely: nenhum script do package.json pode chamá-la nem citá-la.
const OLD_KYSELY_CHECK = Object.entries(pkg.scripts)
  .filter(([name, body]) => /kysely/i.test(name) || /check-kysely/.test(body))
  .map(([name]) => name);
const DB_TYPES_CHECK = scriptsRunning('scripts/check-db-types.ts', pkg.scripts);
const UNUSED_CHECK = scriptsCalling('knip', pkg.scripts);
const DUPLICATION_CHECK = scriptsCalling('jscpd', pkg.scripts);

describe('AI-17 as conferências dos scripts enxergam o que procuram (controle negativo)', () => {
  it('AI-17 o leitor de passos reconhece npm run, npm test e a flag do openapi, e recusa o que não é npm', () => {
    expect(
      stepsOf('npm run lint && npm run openapi -- --check && npm test'),
    ).toEqual(['lint', 'openapi -- --check', 'test']);
    expect(stepsOf('npm run lint && vitest run')).toEqual(['lint', null]);
    expect(stepsOf(undefined)).toEqual([null]);
  });
});

describe('AI-17 os scripts verify e verify:full do package.json', () => {
  it('AI-17 existem os scripts verify e verify:full', () => {
    expect(pkg.scripts.verify).toBeTruthy();
    expect(pkg.scripts['verify:full']).toBeTruthy();
  });

  it('AI-17 existe um script do package.json para a conferência dos tipos do banco e nenhum para a do Kysely, que virou regra do lint', () => {
    expect(DB_TYPES_CHECK).toHaveLength(1);
    expect(OLD_KYSELY_CHECK).toEqual([]);
  });

  it('AI-17 o leitor de scripts acha o script pelo corpo e recusa um corpo que só cita o arquivo', () => {
    const sample = {
      a: 'node scripts/check-db-types.ts',
      b: 'node scripts/check-db-types.ts --write',
      c: 'echo scripts/check-db-types.ts',
      d: 'node scripts/check-migrations.ts',
    };

    expect(scriptsRunning('scripts/check-db-types.ts', sample)).toEqual(['a']);
    expect(scriptsRunning('scripts/check-kysely-usage.ts', sample)).toEqual([]);
  });

  it('AI-17 existe um script do package.json para o knip (AI-35) e outro para o jscpd (AI-36)', () => {
    expect(UNUSED_CHECK).toHaveLength(1);
    expect(DUPLICATION_CHECK).toHaveLength(1);
  });

  it('AI-17 o leitor de scripts acha o knip e o jscpd pelo corpo e recusa um corpo que só os cita', () => {
    const sample = {
      a: 'knip',
      b: 'knip --production',
      c: 'echo knip',
      d: 'jscpd src --baseline x.json',
      e: 'node scripts/jscpd.ts',
    };

    expect(scriptsCalling('knip', sample)).toEqual(['a', 'b']);
    expect(scriptsCalling('jscpd', sample)).toEqual(['d']);
  });

  it('AI-17 o verify roda lint (que traz as formas do Kysely), formato, typecheck, test:unit, openapi -- --check, lint:openapi, check:instructions, check:migrations, check:scripts, o knip e o jscpd, e nenhum passo do Kysely', () => {
    const steps = stepsOf(pkg.scripts.verify);

    expect(steps).not.toContain(null);
    expect(UNUSED_CHECK).toHaveLength(1);
    expect(DUPLICATION_CHECK).toHaveLength(1);
    expect([...steps].map(String).sort()).toEqual(
      [...COMMON, 'test:unit', ...UNUSED_CHECK, ...DUPLICATION_CHECK].sort(),
    );
    expect(pkg.scripts.verify ?? '').not.toMatch(/kysely/i);
  });

  it('AI-17 o verify:full roda os mesmos passos, com todos os testes (npm test) no lugar de test:unit, e mais a conferência dos tipos do banco', () => {
    const steps = stepsOf(pkg.scripts['verify:full']);

    expect(steps).not.toContain(null);
    expect(DB_TYPES_CHECK).toHaveLength(1);
    expect(UNUSED_CHECK).toHaveLength(1);
    expect(DUPLICATION_CHECK).toHaveLength(1);
    expect([...steps].map(String).sort()).toEqual(
      [
        ...COMMON,
        'test',
        ...DB_TYPES_CHECK,
        ...UNUSED_CHECK,
        ...DUPLICATION_CHECK,
      ].sort(),
    );
    expect(pkg.scripts['verify:full'] ?? '').not.toMatch(/kysely/i);
  });

  // A conferência dos tipos sobe o PostgreSQL pelo Docker, e o verify é o do pre-push.
  it('AI-17 o verify roda o lint e não a conferência dos tipos do banco', () => {
    const steps = stepsOf(pkg.scripts.verify);

    expect(steps).toContain('lint');
    expect(DB_TYPES_CHECK).toHaveLength(1);
    for (const name of DB_TYPES_CHECK) expect(steps).not.toContain(name);
  });

  it('AI-17 o verify:full roda o lint, onde estão as formas do Kysely, e a conferência dos tipos do banco', () => {
    const steps = stepsOf(pkg.scripts['verify:full']);

    expect(steps).toContain('lint');
    expect(DB_TYPES_CHECK).toHaveLength(1);
    for (const name of DB_TYPES_CHECK) expect(steps).toContain(name);
  });

  it('AI-17 nenhum script do package.json chama nem cita a conferência antiga do Kysely (check:kysely, check-kysely-usage.ts)', () => {
    expect(OLD_KYSELY_CHECK).toEqual([]);
  });

  // Controle negativo: o verify é o do pre-push e não pode carregar a integração (Docker).
  it('AI-17 o verify não roda npm test, a integração, o vitest direto nem o verify:full', () => {
    const steps = stepsOf(pkg.scripts.verify);

    for (const forbidden of [
      'test',
      'test:integration',
      'test:changed',
      'verify:full',
    ]) {
      expect(steps).not.toContain(forbidden);
    }
    expect(pkg.scripts.verify ?? '').not.toMatch(
      /vitest|testcontainers|docker|integration/i,
    );
  });

  it('AI-17 o verify:full não repete o test:unit, que o npm test já inclui', () => {
    expect(stepsOf(pkg.scripts['verify:full'])).not.toContain('test:unit');
  });

  it('AI-17 todo script que o verify e o verify:full chamam existe no package.json', () => {
    const names = [
      ...stepsOf(pkg.scripts.verify),
      ...stepsOf(pkg.scripts['verify:full']),
    ]
      .filter((step): step is string => step !== null)
      .map((step) => step.split(' ')[0] ?? '');

    expect(names.length).toBeGreaterThan(0);
    for (const name of names)
      expect(pkg.scripts[name], `script ${name}`).toBeTruthy();
  });

  it('AI-17 o script openapi do verify confere (--check) e não regrava o openapi.yaml', () => {
    expect(pkg.scripts.verify ?? '').toMatch(/npm run openapi -- --check/);
    expect(pkg.scripts['verify:full'] ?? '').toMatch(
      /npm run openapi -- --check/,
    );
  });
});
