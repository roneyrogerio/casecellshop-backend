import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  writeFileIn,
} from '../test/helpers/git-sandbox.ts';
import { repoRoot } from '../test/helpers/repo-root.ts';
import type { NodeRun } from '../test/helpers/run-node.ts';
import {
  exportedFn,
  loadScript,
  runScript,
  sandboxWithScript,
  type ScriptModule,
} from '../test/helpers/script-module.ts';

// AI-49: o piso de cobertura (AI-37) só sobe e a linha de base do jscpd (AI-36) só perde repetições. O piso é um
// dado, o coverage-floor.json, e três conferências o seguram: a forma (esquema fechado), a queda (contra a origin/main)
// e a medida (o relatório do Vitest contra o piso da base). Nenhuma lê o vitest.config.ts.
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

const measuredCoverageViolations = (floor: string, report: string): string[] =>
  exportedFn<(floor: string, report: string) => string[]>(
    mod,
    FILE,
    'measuredCoverageViolations',
  )(floor, report);

const baselineViolations = (base: string, head: string): string[] =>
  exportedFn<(base: string, head: string) => string[]>(
    mod,
    FILE,
    'baselineViolations',
  )(base, head);

const floorJson = (floor: Partial<Floor>): string => JSON.stringify(floor);

// O coverage-floor.json do repositório; a falta dele reprova por asserção, e não por erro de leitura.
function repoFloor(): { text: string; parsed: Floor } {
  const file = join(repoRoot, 'coverage-floor.json');
  expect(existsSync(file), 'coverage-floor.json na raiz').toBe(true);
  const text = readFileSync(file, 'utf8');
  return { text, parsed: JSON.parse(text) as Floor };
}

const BASE_SCHEMA = /^coverage-floor\.json da base fora do esquema/;
const HEAD_SCHEMA = /^coverage-floor\.json do PR fora do esquema/;

// Tudo que o esquema fechado recusa: objeto com exatamente as quatro chaves, cada uma um número > 0 e <= 100.
const INVALID_FLOORS: [string, string][] = [
  [
    'uma chave a mais (perFile)',
    floorJson({ ...FLOOR, perFile: true } as Floor),
  ],
  [
    'uma chave a mais (autoUpdate)',
    floorJson({ ...FLOOR, autoUpdate: true } as Floor),
  ],
  [
    'um glob como chave ("src/**")',
    JSON.stringify({ ...FLOOR, 'src/**': { lines: 1 } }),
  ],
  ...METRICS.map((metric): [string, string] => [
    `a chave ${metric} a menos`,
    floorJson(
      Object.fromEntries(
        METRICS.filter((other) => other !== metric).map((other) => [
          other,
          FLOOR[other],
        ]),
      ),
    ),
  ]),
  ['o objeto vazio', '{}'],
  ['um valor string', JSON.stringify({ ...FLOOR, lines: '92' })],
  ['um valor null', JSON.stringify({ ...FLOOR, functions: null })],
  ['um valor 0', floorJson({ ...FLOOR, branches: 0 })],
  ['um valor negativo', floorJson({ ...FLOOR, statements: -1 })],
  ['um valor acima de 100 (101)', floorJson({ ...FLOOR, lines: 101 })],
  ['um valor acima de 100 (100.01)', floorJson({ ...FLOOR, lines: 100.01 })],
  ['um JSON inválido', '{"lines": 92, "functions": 92,'],
  ['um array', '[92, 92, 83, 91]'],
  ['null', 'null'],
];

describe('AI-49 coverageFloorViolations reprova o piso de cobertura que caiu em relação à base', () => {
  it('AI-49 o mesmo piso passa (controle)', () => {
    expect(coverageFloorViolations(floorJson(FLOOR), floorJson(FLOOR))).toEqual(
      [],
    );
  });

  it('AI-49 outra ordem das chaves e outra formatação do JSON não mudam o resultado (controle)', () => {
    const reordered = JSON.stringify(
      {
        statements: 91,
        branches: 83,
        functions: 92,
        lines: 92,
      },
      null,
      4,
    );

    expect(coverageFloorViolations(floorJson(FLOOR), reordered)).toEqual([]);
    expect(coverageFloorViolations(reordered, floorJson(FLOOR))).toEqual([]);
  });

  it('AI-49 o piso de 100 e o piso com casas decimais são aceitos pelo esquema (controle)', () => {
    const full = floorJson({
      lines: 100,
      functions: 100,
      branches: 100,
      statements: 100,
    });
    const decimals = floorJson({ ...FLOOR, lines: 92.5 });

    expect(coverageFloorViolations(full, full)).toEqual([]);
    expect(coverageFloorViolations(decimals, decimals)).toEqual([]);
    expect(
      coverageFloorViolations(decimals, floorJson({ ...FLOOR, lines: 92.4 })),
    ).toEqual([expect.stringContaining('lines')]);
  });

  it.each(METRICS)(
    'AI-49 o piso de %s 1 ponto abaixo reprova, e cita a métrica, o valor antes e o depois',
    (metric) => {
      const head = floorJson({ ...FLOOR, [metric]: FLOOR[metric] - 1 });

      expect(coverageFloorViolations(floorJson(FLOOR), head)).toEqual([
        `piso de ${metric} caiu de ${String(FLOOR[metric])} para ${String(FLOOR[metric] - 1)}`,
      ]);
    },
  );

  it.each(METRICS)('AI-49 o piso de %s igual ou acima passa', (metric) => {
    for (const delta of [0, 1, 5])
      expect(
        coverageFloorViolations(
          floorJson(FLOOR),
          floorJson({ ...FLOOR, [metric]: FLOOR[metric] + delta }),
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

    expect(
      coverageFloorViolations(floorJson(FLOOR), floorJson(higher)),
    ).toEqual([]);
  });

  it('AI-49 cair em duas métricas ao mesmo tempo gera uma violação por métrica', () => {
    const head = floorJson({ ...FLOOR, lines: 50, branches: 10 });
    const violations = coverageFloorViolations(floorJson(FLOOR), head);

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('lines');
    expect(violations.join('\n')).toContain('branches');
  });

  it('AI-49 cair numa métrica e subir em outra reprova só a que caiu', () => {
    const head = floorJson({ ...FLOOR, lines: 99, functions: 91 });

    expect(coverageFloorViolations(floorJson(FLOOR), head)).toEqual([
      expect.stringContaining('functions'),
    ]);
  });

  it('AI-49 o PR que apaga o coverage-floor.json reprova', () => {
    expect(coverageFloorViolations(floorJson(FLOOR), '')).toEqual([
      expect.stringContaining('coverage-floor.json removido do PR'),
    ]);
  });

  it('AI-49 o coverage-floor.json do repositório existe e contra ele mesmo passa', () => {
    const { text } = repoFloor();

    expect(coverageFloorViolations(text, text)).toEqual([]);
  });

  it('AI-49 o coverage-floor.json do repositório com uma métrica 1 ponto abaixo reprova', () => {
    const { text, parsed } = repoFloor();
    const lower = floorJson({ ...parsed, lines: parsed.lines - 1 });

    expect(coverageFloorViolations(text, lower)).toEqual([
      expect.stringContaining('lines'),
    ]);
  });
});

// A forma (esquema fechado), em cada lado da comparação. Cada caso ruim de um lado tem o outro lado correto e igual ao
// piso, para o único defeito ser o esquema; e a conferência não compara quando um lado está fora dele.
describe('AI-49 coverageFloorViolations só aceita o piso no esquema fechado, nos dois lados da comparação', () => {
  it.each(INVALID_FLOORS)(
    'AI-49 %s no PR reprova com o aviso de esquema do PR, mesmo com a base certa',
    (_label, head) => {
      const violations = coverageFloorViolations(floorJson(FLOOR), head);

      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations)
        expect(violation).toMatch(HEAD_SCHEMA);
    },
  );

  it.each(INVALID_FLOORS)(
    'AI-49 %s na base reprova com o aviso de esquema da base, mesmo com o PR certo',
    (_label, base) => {
      const violations = coverageFloorViolations(base, floorJson(FLOOR));

      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations)
        expect(violation).toMatch(BASE_SCHEMA);
    },
  );

  it('AI-49 os dois lados fora do esquema geram o aviso de cada lado', () => {
    const violations = coverageFloorViolations('[]', 'null');

    expect(violations.some((violation) => BASE_SCHEMA.test(violation))).toBe(
      true,
    );
    expect(violations.some((violation) => HEAD_SCHEMA.test(violation))).toBe(
      true,
    );
  });

  // Um PR fora do esquema que também derrubou o piso mostra só o esquema: sem um piso válido não há o que comparar.
  it('AI-49 um lado fora do esquema devolve só as violações de esquema, sem comparar os valores', () => {
    const lowerAndWrong = JSON.stringify({ lines: 1, perFile: true });

    for (const violation of coverageFloorViolations(
      floorJson(FLOOR),
      lowerAndWrong,
    ))
      expect(violation).not.toContain('caiu');
    for (const violation of coverageFloorViolations(
      lowerAndWrong,
      floorJson({ ...FLOOR, lines: 1 }),
    ))
      expect(violation).not.toContain('caiu');
  });
});

// A medida (AI-49): o relatório json-summary do Vitest contra o piso da base.
const SUMMARY_TOTAL = 200;

interface SummaryEntry {
  total: number;
  covered: number;
  skipped: number;
  pct: number | string | null;
}

function entry(pct: number | string | null): SummaryEntry {
  return {
    total: SUMMARY_TOTAL,
    covered: typeof pct === 'number' ? Math.floor(pct * 2) : 0,
    skipped: 0,
    pct,
  };
}

// A forma real do coverage-summary.json: o `total` com as quatro métricas e o `branchesTrue`, mais uma chave por
// arquivo com as mesmas métricas. Uma métrica ausente do argumento fica ausente do `total`.
function summary(
  pcts: Partial<Record<Metric, number | string | null>>,
): string {
  const perFile: Record<string, SummaryEntry> = { branchesTrue: entry(100) };
  for (const [metric, pct] of Object.entries(pcts))
    perFile[metric] = entry(pct);
  return JSON.stringify({
    total: { ...perFile },
    '/repo/src/app.ts': perFile,
  });
}

describe('AI-49 measuredCoverageViolations reprova a cobertura medida abaixo do piso da base', () => {
  const BELOW: Floor = {
    lines: 91.99,
    functions: 91.99,
    branches: 82.99,
    statements: 90.99,
  };

  it('AI-49 a cobertura medida igual ao piso passa (o Vitest reprova só abaixo do piso)', () => {
    expect(
      measuredCoverageViolations(floorJson(FLOOR), summary(FLOOR)),
    ).toEqual([]);
  });

  it('AI-49 a cobertura medida acima do piso passa', () => {
    expect(
      measuredCoverageViolations(
        floorJson(FLOOR),
        summary({ lines: 100, functions: 99.5, branches: 90, statements: 95 }),
      ),
    ).toEqual([]);
  });

  it.each(METRICS)(
    'AI-49 a cobertura de %s medida 0,01 abaixo do piso reprova, e cita a métrica, a medida e o piso',
    (metric) => {
      const report = summary({ ...FLOOR, [metric]: BELOW[metric] });

      expect(measuredCoverageViolations(floorJson(FLOOR), report)).toEqual([
        `cobertura de ${metric} medida em ${String(BELOW[metric])}%, abaixo do piso da base (${String(FLOOR[metric])})`,
      ]);
    },
  );

  it('AI-49 duas métricas abaixo geram uma violação por métrica', () => {
    const violations = measuredCoverageViolations(
      floorJson(FLOOR),
      summary({ ...FLOOR, lines: 10, statements: 20 }),
    );

    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('cobertura de lines');
    expect(violations.join('\n')).toContain('cobertura de statements');
  });

  it('AI-49 o piso da base é o que vale: a cobertura que passa num piso menor reprova num maior', () => {
    const report = summary({ ...FLOOR, lines: 80 });

    expect(
      measuredCoverageViolations(floorJson({ ...FLOOR, lines: 80 }), report),
    ).toEqual([]);
    expect(measuredCoverageViolations(floorJson(FLOOR), report)).toEqual([
      expect.stringContaining('lines'),
    ]);
  });

  it('AI-49 as chaves extras do relatório (arquivos, branchesTrue, pct "Unknown" fora das quatro métricas) são aceitas', () => {
    const report = JSON.parse(summary(FLOOR)) as Record<
      string,
      Record<string, unknown>
    >;
    report['/repo/src/empty.ts'] = {
      lines: entry('Unknown'),
      branchesTrue: entry('Unknown'),
    };
    const text = JSON.stringify(report);

    expect(text).toContain('branchesTrue');
    expect(text).toContain('/repo/src/app.ts');
    expect(measuredCoverageViolations(floorJson(FLOOR), text)).toEqual([]);
  });

  it('AI-49 o relatório ausente reprova', () => {
    expect(measuredCoverageViolations(floorJson(FLOOR), '')).toEqual([
      expect.stringContaining('relatório de cobertura ausente'),
    ]);
  });

  const BAD_REPORTS: [string, string][] = [
    ['um JSON inválido', '{"total": {"lines": '],
    ['um array', '[]'],
    ['null', 'null'],
    ['o objeto vazio, sem total', '{}'],
    [
      'só os arquivos, sem total',
      JSON.stringify({ '/repo/src/a.ts': entry(95) }),
    ],
    ['o total null', '{"total": null}'],
    ...METRICS.map((metric): [string, string] => [
      `o total sem ${metric}`,
      summary(
        Object.fromEntries(
          METRICS.filter((other) => other !== metric).map((other) => [
            other,
            FLOOR[other],
          ]),
        ),
      ),
    ]),
    ...METRICS.map((metric): [string, string] => [
      `o pct "Unknown" em ${metric}`,
      summary({ ...FLOOR, [metric]: 'Unknown' }),
    ]),
    ['um pct texto ("95")', summary({ ...FLOOR, lines: '95' })],
    ['um pct null', summary({ ...FLOOR, branches: null })],
  ];

  it.each(BAD_REPORTS)(
    'AI-49 %s no relatório reprova como fora do formato',
    (_label, report) => {
      const violations = measuredCoverageViolations(floorJson(FLOOR), report);

      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations)
        expect(violation).toMatch(/^relatório de cobertura fora do formato/);
    },
  );

  it.each(INVALID_FLOORS)(
    'AI-49 o piso da base com %s reprova com o aviso de esquema da base',
    (_label, base) => {
      const violations = measuredCoverageViolations(base, summary(FLOOR));

      expect(violations.length).toBeGreaterThan(0);
      for (const violation of violations)
        expect(violation).toMatch(BASE_SCHEMA);
    },
  );

  it('AI-49 o coverage-floor.json do repositório contra um relatório exatamente nele passa, e 0,01 abaixo reprova', () => {
    const { text, parsed } = repoFloor();

    expect(measuredCoverageViolations(text, summary(parsed))).toEqual([]);
    expect(
      measuredCoverageViolations(
        text,
        summary({ ...parsed, branches: parsed.branches - 0.01 }),
      ),
    ).toEqual([expect.stringContaining('branches')]);
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
  // Roda o CLI com a base `main` (ou a ref dada) e os argumentos dados.
  run: (args?: string[], ref?: string) => NodeRun;
  // Grava o relatório do Vitest na pasta temporária e devolve o caminho dele.
  report: (text: string) => string;
}

function prSandbox(options: {
  base: { floor?: string; baseline?: string };
  // `null`: o PR apaga o arquivo.
  head: { floor: string | null; baseline: string };
}): Sandbox {
  const dir = sandboxWithScript(FILE);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  if (options.base.floor !== undefined)
    writeFileIn(dir, 'coverage-floor.json', options.base.floor);
  if (options.base.baseline !== undefined)
    writeFileIn(dir, '.jscpd-baseline.json', options.base.baseline);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'base com os arquivos');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (options.head.floor === null) rmSync(join(dir, 'coverage-floor.json'));
  else writeFileIn(dir, 'coverage-floor.json', options.head.floor);
  writeFileIn(dir, '.jscpd-baseline.json', options.head.baseline);
  git(dir, 'add', '-A');
  // --allow-empty: com pisos e linha de base iguais aos da base o PR não muda arquivo, e o git recusaria o commit.
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pr');
  return {
    dir,
    // O runScript tira as variáveis GIT_ da máquina, que desviariam o `git show` do repositório temporário.
    run: (args = [], ref = 'main') =>
      runScript(dir, FILE, { BASE_REF: ref }, args),
    report: (text) => {
      writeFileIn(dir, 'out/coverage-summary.json', text);
      return join(dir, 'out', 'coverage-summary.json');
    },
  };
}

const standard = {
  base: { floor: floorJson(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
  head: { floor: floorJson(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
};

describe('AI-49 o CLI do check-baselines compara com a origin/BASE_REF', () => {
  const lowered = floorJson({ ...FLOOR, branches: 82 });

  it('AI-49 pisos e linha de base iguais saem com 0', () => {
    const result = prSandbox(standard).run();

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 um piso 1 ponto abaixo no coverage-floor.json sai com 1, citando a métrica', () => {
    const result = prSandbox({
      ...standard,
      head: { ...standard.head, floor: lowered },
    }).run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('branches');
  });

  it('AI-49 o coverage-floor.json apagado no PR sai com 1', () => {
    const result = prSandbox({
      ...standard,
      head: { ...standard.head, floor: null },
    }).run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain(
      'coverage-floor.json removido do PR',
    );
  });

  it('AI-49 o coverage-floor.json do PR fora do esquema sai com 1', () => {
    const result = prSandbox({
      ...standard,
      head: {
        ...standard.head,
        floor: JSON.stringify({ ...FLOOR, perFile: true }),
      },
    }).run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('fora do esquema');
  });

  it('AI-49 uma repetição nova na linha de base sai com 1, citando a impressão', () => {
    const result = prSandbox({
      ...standard,
      head: {
        ...standard.head,
        baseline: baseline([...BASE_FINGERPRINTS, 'ffffffffffffffff']),
      },
    }).run();

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('ffffffffffffffff');
  });

  it('AI-49 os arquivos que ainda não existem na base (primeiro PR) não têm o que comparar e passam', () => {
    const result = prSandbox({
      base: {},
      head: { floor: lowered, baseline: baseline(BASE_FINGERPRINTS) },
    }).run();

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 só o arquivo da linha de base falta na base (o PR que o cria): a ref existe e o CLI sai com 0', () => {
    const result = prSandbox({
      base: { floor: floorJson(FLOOR) },
      head: standard.head,
    }).run();

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 BASE_REF apontando para uma ref que não existe sai com código diferente de 0 (sem a base não há o que comparar)', () => {
    const result = prSandbox(standard).run([], 'ref-que-nao-existe');

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });

  it('AI-49 um argumento desconhecido sai com código diferente de 0', () => {
    const result = prSandbox(standard).run(['--desconhecido']);

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });
});

describe('AI-49 o CLI do check-baselines --measured confere o relatório contra o piso da origin/BASE_REF', () => {
  it('AI-49 --measured com a cobertura medida abaixo do piso da base sai com 1, citando a métrica', () => {
    const sandbox = prSandbox(standard);
    const path = sandbox.report(summary({ ...FLOOR, functions: 91.99 }));
    const result = sandbox.run(['--measured', path]);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('functions');
  });

  it('AI-49 --measured com a cobertura medida igual ao piso sai com 0', () => {
    const sandbox = prSandbox(standard);
    const result = sandbox.run(['--measured', sandbox.report(summary(FLOOR))]);

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 --measured vale o piso da base, e não o do PR: o PR que baixou o piso não salva a medida', () => {
    const sandbox = prSandbox({
      ...standard,
      head: { ...standard.head, floor: floorJson({ ...FLOOR, lines: 50 }) },
    });
    const path = sandbox.report(summary({ ...FLOOR, lines: 80 }));
    const result = sandbox.run(['--measured', path]);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('lines');
  });

  it('AI-49 --measured com a base sem o coverage-floor.json (o PR que o cria) sai com 0', () => {
    const sandbox = prSandbox({
      base: { baseline: baseline(BASE_FINGERPRINTS) },
      head: standard.head,
    });
    const path = sandbox.report(summary({ ...FLOOR, lines: 10 }));
    const result = sandbox.run(['--measured', path]);

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 --measured com o relatório ausente sai com 1', () => {
    const sandbox = prSandbox(standard);
    const result = sandbox.run([
      '--measured',
      join(sandbox.dir, 'nao-existe.json'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain(
      'relatório de cobertura ausente',
    );
  });

  it('AI-49 --measured sem a ref da base sai com 1', () => {
    const sandbox = prSandbox(standard);
    const path = sandbox.report(summary(FLOOR));
    const result = sandbox.run(['--measured', path], 'ref-que-nao-existe');

    expect(result.status).toBe(1);
  });
});
