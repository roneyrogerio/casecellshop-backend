import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AI-17: `npm run verify` espelha o CI sem os testes de integração; `npm run verify:full` troca os testes
// unitários por todos os testes. Os dois são listas de `npm run` ligadas por `&&`.
const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

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
];

describe('AI-17 as conferências dos scripts enxergam o que procuram (controle negativo)', () => {
  it('AI-17 o leitor de passos reconhece npm run, npm test e a flag do openapi, e recusa o que não é npm', () => {
    expect(stepsOf('npm run lint && npm run openapi -- --check && npm test')).toEqual([
      'lint',
      'openapi -- --check',
      'test',
    ]);
    expect(stepsOf('npm run lint && vitest run')).toEqual(['lint', null]);
    expect(stepsOf(undefined)).toEqual([null]);
  });
});

describe('AI-17 os scripts verify e verify:full do package.json', () => {
  it('AI-17 existem os scripts verify e verify:full', () => {
    expect(pkg.scripts.verify).toBeTruthy();
    expect(pkg.scripts['verify:full']).toBeTruthy();
  });

  it('AI-17 o verify roda lint, typecheck, test:unit, openapi -- --check, lint:openapi, check:instructions, check:migrations e check:scripts', () => {
    const steps = stepsOf(pkg.scripts.verify);

    expect(steps).not.toContain(null);
    expect([...steps].map(String).sort()).toEqual([...COMMON, 'test:unit'].sort());
  });

  it('AI-17 o verify:full roda os mesmos passos, com todos os testes (npm test) no lugar de test:unit', () => {
    const steps = stepsOf(pkg.scripts['verify:full']);

    expect(steps).not.toContain(null);
    expect([...steps].map(String).sort()).toEqual([...COMMON, 'test'].sort());
  });

  // Controle negativo: o verify é o do pre-push e não pode carregar a integração (Docker).
  it('AI-17 o verify não roda npm test, a integração, o vitest direto nem o verify:full', () => {
    const steps = stepsOf(pkg.scripts.verify);

    for (const forbidden of ['test', 'test:integration', 'test:changed', 'verify:full']) {
      expect(steps).not.toContain(forbidden);
    }
    expect(pkg.scripts.verify ?? '').not.toMatch(/vitest|testcontainers|docker|integration/i);
  });

  it('AI-17 o verify:full não repete o test:unit, que o npm test já inclui', () => {
    expect(stepsOf(pkg.scripts['verify:full'])).not.toContain('test:unit');
  });

  it('AI-17 todo script que o verify e o verify:full chamam existe no package.json', () => {
    const names = [...stepsOf(pkg.scripts.verify), ...stepsOf(pkg.scripts['verify:full'])]
      .filter((step): step is string => step !== null)
      .map((step) => step.split(' ')[0] ?? '');

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(pkg.scripts[name], `script ${name}`).toBeTruthy();
  });

  it('AI-17 o script openapi do verify confere (--check) e não regrava o openapi.yaml', () => {
    expect(pkg.scripts.verify ?? '').toMatch(/npm run openapi -- --check/);
    expect(pkg.scripts['verify:full'] ?? '').toMatch(/npm run openapi -- --check/);
  });
});
