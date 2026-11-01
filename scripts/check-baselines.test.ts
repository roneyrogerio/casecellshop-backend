import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  writeFileIn,
} from '../test/helpers/git-sandbox.ts';
import { repoRoot } from '../test/helpers/repo-root.ts';
import {
  exportedFn,
  loadScript,
  runScript,
  sandboxWithScript,
  type ScriptModule,
} from '../test/helpers/script-module.ts';

// AI-49: o piso de cobertura (AI-37) só sobe e a linha de base do jscpd (AI-36) só perde repetições. O script compara
// o PR com a origin/main: um piso menor em qualquer métrica, ou uma repetição que não estava na base, reprova.
const FILE = 'check-baselines.ts';
const METRICS = ['lines', 'functions', 'branches', 'statements'] as const;
type Metric = (typeof METRICS)[number];
type Floor = Record<Metric, number>;

const FLOOR: Floor = { lines: 92, functions: 92, branches: 83, statements: 91 };

let mod: ScriptModule;
beforeAll(async () => {
  mod = await loadScript(FILE);
});
afterAll(cleanupTempDirs);

const coverageFloorViolations = (base: string, head: string): string[] =>
  exportedFn<(base: string, head: string) => string[]>(
    mod,
    FILE,
    'coverageFloorViolations',
  )(base, head);

const baselineViolations = (base: string, head: string): string[] =>
  exportedFn<(base: string, head: string) => string[]>(
    mod,
    FILE,
    'baselineViolations',
  )(base, head);

// Do jeito que o vitest.config.ts é escrito: `thresholds` numa linha, dentro de `coverage`.
function config(floor: Partial<Floor>): string {
  const body = Object.entries(floor)
    .map(([metric, value]) => `${metric}: ${String(value)}`)
    .join(', ');
  return `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { ${body} },
    },
    projects: [],
  },
});
`;
}

describe('AI-49 coverageFloorViolations reprova o piso de cobertura que caiu em relação à base', () => {
  it('AI-49 o mesmo piso passa (controle)', () => {
    expect(coverageFloorViolations(config(FLOOR), config(FLOOR))).toEqual([]);
  });

  it.each(METRICS)(
    'AI-49 o piso de %s 1 ponto abaixo reprova, e cita a métrica',
    (metric) => {
      const head = config({ ...FLOOR, [metric]: FLOOR[metric] - 1 });

      expect(coverageFloorViolations(config(FLOOR), head)).toEqual([
        expect.stringContaining(metric),
      ]);
    },
  );

  it.each(METRICS)('AI-49 o piso de %s igual ou acima passa', (metric) => {
    for (const delta of [0, 1, 5])
      expect(
        coverageFloorViolations(
          config(FLOOR),
          config({ ...FLOOR, [metric]: FLOOR[metric] + delta }),
        ),
        `${metric} +${String(delta)}`,
      ).toEqual([]);
  });

  it('AI-49 subir todas as métricas passa', () => {
    const higher: Floor = {
      lines: 95,
      functions: 94,
      branches: 90,
      statements: 93,
    };

    expect(coverageFloorViolations(config(FLOOR), config(higher))).toEqual([]);
  });

  it('AI-49 cair em duas métricas ao mesmo tempo gera uma violação por métrica', () => {
    const head = config({ ...FLOOR, lines: 50, branches: 10 });
    const violations = coverageFloorViolations(config(FLOOR), head);

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('lines');
    expect(violations.join('\n')).toContain('branches');
  });

  it('AI-49 cair numa métrica e subir em outra reprova só a que caiu', () => {
    const head = config({ ...FLOOR, lines: 99, functions: 91 });

    expect(coverageFloorViolations(config(FLOOR), head)).toEqual([
      expect.stringContaining('functions'),
    ]);
  });

  it.each(METRICS)(
    'AI-49 a métrica %s removida do PR reprova (sem o piso, qualquer cobertura passaria)',
    (metric) => {
      const rest = Object.fromEntries(
        METRICS.filter((other) => other !== metric).map((other) => [
          other,
          FLOOR[other],
        ]),
      );

      expect(coverageFloorViolations(config(FLOOR), config(rest))).toEqual([
        expect.stringContaining(metric),
      ]);
    },
  );

  it('AI-49 o bloco thresholds removido do PR reprova as quatro métricas', () => {
    const head = config({});
    const withoutBlock = head.replace(/\s*thresholds: \{[^}]*\},/, '');

    expect(withoutBlock).not.toContain('thresholds');
    expect(coverageFloorViolations(config(FLOOR), withoutBlock)).toHaveLength(
      4,
    );
  });

  it('AI-49 lê os thresholds também quando o Prettier os quebra em várias linhas', () => {
    const multiline = (floor: Floor): string =>
      config(FLOOR).replace(
        /thresholds: \{[^}]*\},/,
        `thresholds: {\n        lines: ${String(floor.lines)},\n        functions: ${String(floor.functions)},\n        branches: ${String(floor.branches)},\n        statements: ${String(floor.statements)},\n      },`,
      );

    expect(coverageFloorViolations(multiline(FLOOR), multiline(FLOOR))).toEqual(
      [],
    );
    expect(
      coverageFloorViolations(
        multiline(FLOOR),
        multiline({ ...FLOOR, statements: 90 }),
      ),
    ).toEqual([expect.stringContaining('statements')]);
    expect(
      coverageFloorViolations(
        config(FLOOR),
        multiline({ ...FLOOR, statements: 90 }),
      ),
    ).toEqual([expect.stringContaining('statements')]);
  });

  it('AI-49 o vitest.config.ts do repositório contra ele mesmo passa', () => {
    const text = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');

    expect(coverageFloorViolations(text, text)).toEqual([]);
  });

  it('AI-49 o vitest.config.ts do repositório com uma métrica 1 ponto abaixo reprova', () => {
    const text = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    const lower = text.replace(
      /lines: (\d+)/,
      (_match, value: string) => `lines: ${String(Number(value) - 1)}`,
    );

    expect(lower).not.toBe(text);
    expect(coverageFloorViolations(text, lower)).toEqual([
      expect.stringContaining('lines'),
    ]);
  });
});

// O formato real do .jscpd-baseline.json: o mapa `fingerprints`, da impressão da repetição para a contagem.
function baseline(fingerprints: string[]): string {
  return JSON.stringify(
    {
      version: 1,
      fingerprints: Object.fromEntries(fingerprints.map((fp) => [fp, 1])),
    },
    null,
    2,
  );
}

const BASE_FINGERPRINTS = [
  '012a289b63ff923a',
  '019d52cd919db180',
  '03b03fbe0952e96a',
];

describe('AI-49 baselineViolations reprova a repetição que entrou na linha de base do jscpd', () => {
  it('AI-49 a mesma linha de base passa (controle)', () => {
    expect(
      baselineViolations(
        baseline(BASE_FINGERPRINTS),
        baseline(BASE_FINGERPRINTS),
      ),
    ).toEqual([]);
  });

  it('AI-49 uma repetição nova reprova, e cita a impressão dela', () => {
    const head = baseline([...BASE_FINGERPRINTS, 'ffffffffffffffff']);

    expect(baselineViolations(baseline(BASE_FINGERPRINTS), head)).toEqual([
      expect.stringContaining('ffffffffffffffff'),
    ]);
  });

  it('AI-49 duas repetições novas geram duas violações', () => {
    const head = baseline([
      ...BASE_FINGERPRINTS,
      'aaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbb',
    ]);

    expect(baselineViolations(baseline(BASE_FINGERPRINTS), head)).toHaveLength(
      2,
    );
  });

  it('AI-49 tirar uma repetição da linha de base passa', () => {
    expect(
      baselineViolations(
        baseline(BASE_FINGERPRINTS),
        baseline(BASE_FINGERPRINTS.slice(1)),
      ),
    ).toEqual([]);
  });

  it('AI-49 esvaziar a linha de base passa', () => {
    expect(
      baselineViolations(baseline(BASE_FINGERPRINTS), baseline([])),
    ).toEqual([]);
  });

  it('AI-49 trocar uma repetição por outra reprova só a que entrou', () => {
    const head = baseline([
      '019d52cd919db180',
      '03b03fbe0952e96a',
      'cccccccccccccccc',
    ]);

    expect(baselineViolations(baseline(BASE_FINGERPRINTS), head)).toEqual([
      expect.stringContaining('cccccccccccccccc'),
    ]);
  });

  it('AI-49 outra ordem das chaves e outra formatação do JSON não mudam o resultado', () => {
    const reordered = JSON.stringify({
      fingerprints: Object.fromEntries(
        [...BASE_FINGERPRINTS].reverse().map((fp) => [fp, 1]),
      ),
      version: 1,
    });

    expect(baselineViolations(baseline(BASE_FINGERPRINTS), reordered)).toEqual(
      [],
    );
  });

  it('AI-49 o .jscpd-baseline.json do repositório contra ele mesmo passa, e com uma repetição a mais reprova', () => {
    const text = readFileSync(join(repoRoot, '.jscpd-baseline.json'), 'utf8');
    const extra = text.replace(
      '"fingerprints": {',
      '"fingerprints": {\n    "ffffffffffffffff": 1,',
    );

    expect(extra).not.toBe(text);
    expect(baselineViolations(text, text)).toEqual([]);
    expect(baselineViolations(text, extra)).toEqual([
      expect.stringContaining('ffffffffffffffff'),
    ]);
  });
});

// O CLI lê a base com `git show origin/$BASE_REF:<arquivo>` e o PR da árvore de trabalho. A origin é simulada por uma
// ref em refs/remotes, sem rede.
interface Sandbox {
  dir: string;
  run: () => ReturnType<typeof runScript>;
}

function prSandbox(options: {
  base: { config?: string; baseline?: string };
  head: { config: string; baseline: string };
}): Sandbox {
  const dir = sandboxWithScript(FILE);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  if (options.base.config !== undefined)
    writeFileIn(dir, 'vitest.config.ts', options.base.config);
  if (options.base.baseline !== undefined)
    writeFileIn(dir, '.jscpd-baseline.json', options.base.baseline);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base com as linhas');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileIn(dir, 'vitest.config.ts', options.head.config);
  writeFileIn(dir, '.jscpd-baseline.json', options.head.baseline);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'pr');
  return { dir, run: () => runScript(dir, FILE, { BASE_REF: 'main' }) };
}

describe('AI-49 o CLI do check-baselines compara com a origin/BASE_REF', () => {
  const lowered = config({ ...FLOOR, branches: 82 });

  it('AI-49 pisos e linha de base iguais saem com 0', () => {
    const { run } = prSandbox({
      base: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
      head: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
    });
    const result = run();

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 um piso 1 ponto abaixo sai com 1, citando a métrica', () => {
    const { run } = prSandbox({
      base: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
      head: { config: lowered, baseline: baseline(BASE_FINGERPRINTS) },
    });
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('branches');
  });

  it('AI-49 uma repetição nova na linha de base sai com 1, citando a impressão', () => {
    const { run } = prSandbox({
      base: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
      head: {
        config: config(FLOOR),
        baseline: baseline([...BASE_FINGERPRINTS, 'ffffffffffffffff']),
      },
    });
    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('ffffffffffffffff');
  });

  it('AI-49 os arquivos que ainda não existem na base (primeiro PR) não têm o que comparar e passam', () => {
    const { run } = prSandbox({
      base: {},
      head: { config: lowered, baseline: baseline(BASE_FINGERPRINTS) },
    });
    const result = run();

    expect(result.status, result.stderr).toBe(0);
  });
});
