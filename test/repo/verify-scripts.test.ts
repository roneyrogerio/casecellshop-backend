import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AI-17: `npm run verify` espelha o CI sem os testes de integração; `npm run verify:full` troca os testes
// unitários por todos os testes. Os dois são listas de `npm run` ligadas por `&&`.
const root = join(import.meta.dirname, '..', '..');
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

// O critério não dá o nome dos scripts das conferências do M2 (FND-09, AI-19): elas são achadas pelo corpo, que chama
// o arquivo de scripts/ com node, como o ci.yml (AI-05).
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

const KYSELY_CHECK = scriptsRunning(
  'scripts/check-kysely-usage.ts',
  pkg.scripts,
);
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

  it('AI-17 existe um script do package.json para cada conferência do M2: node scripts/check-kysely-usage.ts e node scripts/check-db-types.ts', () => {
    expect(KYSELY_CHECK).toHaveLength(1);
    expect(DB_TYPES_CHECK).toHaveLength(1);
  });

  it('AI-17 o leitor de scripts acha o script pelo corpo e recusa um corpo que só cita o arquivo', () => {
    const sample = {
      a: 'node scripts/check-kysely-usage.ts',
      b: 'node scripts/check-kysely-usage.ts --write',
      c: 'echo scripts/check-kysely-usage.ts',
      d: 'node scripts/check-migrations.ts',
    };

    expect(scriptsRunning('scripts/check-kysely-usage.ts', sample)).toEqual([
      'a',
    ]);
    expect(scriptsRunning('scripts/check-db-types.ts', sample)).toEqual([]);
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

  it('AI-17 o verify roda lint, formato, typecheck, test:unit, openapi -- --check, lint:openapi, check:instructions, check:migrations, check:scripts, a conferência das formas do Kysely, o knip e o jscpd', () => {
    const steps = stepsOf(pkg.scripts.verify);

    expect(steps).not.toContain(null);
    expect(KYSELY_CHECK).toHaveLength(1);
    expect(UNUSED_CHECK).toHaveLength(1);
    expect(DUPLICATION_CHECK).toHaveLength(1);
    expect([...steps].map(String).sort()).toEqual(
      [
        ...COMMON,
        'test:unit',
        ...KYSELY_CHECK,
        ...UNUSED_CHECK,
        ...DUPLICATION_CHECK,
      ].sort(),
    );
  });

  it('AI-17 o verify:full roda os mesmos passos, com todos os testes (npm test) no lugar de test:unit, e mais a conferência dos tipos do banco', () => {
    const steps = stepsOf(pkg.scripts['verify:full']);

    expect(steps).not.toContain(null);
    expect(KYSELY_CHECK).toHaveLength(1);
    expect(DB_TYPES_CHECK).toHaveLength(1);
    expect(UNUSED_CHECK).toHaveLength(1);
    expect(DUPLICATION_CHECK).toHaveLength(1);
    expect([...steps].map(String).sort()).toEqual(
      [
        ...COMMON,
        'test',
        ...KYSELY_CHECK,
        ...DB_TYPES_CHECK,
        ...UNUSED_CHECK,
        ...DUPLICATION_CHECK,
      ].sort(),
    );
  });

  // A conferência dos tipos sobe o PostgreSQL pelo Docker, e o verify é o do pre-push.
  it('AI-17 o verify roda a conferência das formas do Kysely e não a dos tipos do banco', () => {
    const steps = stepsOf(pkg.scripts.verify);

    expect(KYSELY_CHECK.length + DB_TYPES_CHECK.length).toBe(2);
    for (const name of KYSELY_CHECK) expect(steps).toContain(name);
    for (const name of DB_TYPES_CHECK) expect(steps).not.toContain(name);
  });

  it('AI-17 o verify:full roda as duas conferências do M2', () => {
    const steps = stepsOf(pkg.scripts['verify:full']);

    expect(KYSELY_CHECK.length + DB_TYPES_CHECK.length).toBe(2);
    for (const name of [...KYSELY_CHECK, ...DB_TYPES_CHECK])
      expect(steps).toContain(name);
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
