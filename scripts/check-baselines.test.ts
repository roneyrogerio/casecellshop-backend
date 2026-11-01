import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  makeTempDir,
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

// O mesmo `thresholds`, quebrado em várias linhas como o Prettier quebraria um objeto longo.
function multilineConfig(floor: Floor): string {
  return config(floor).replace(
    /thresholds: \{[^}]*\},/,
    `thresholds: {\n        lines: ${String(floor.lines)},\n        functions: ${String(floor.functions)},\n        branches: ${String(floor.branches)},\n        statements: ${String(floor.statements)},\n      },`,
  );
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

  // O piso tem forma fixa (AI-49): o objeto de uma linha só. O que antes passava, o objeto quebrado em várias linhas,
  // agora reprova nos dois lados da comparação, porque uma forma fora do padrão esconde um piso menor.
  it('AI-49 o thresholds em várias linhas reprova, no PR e na base, mesmo com o mesmo piso', () => {
    expect(
      coverageFloorViolations(config(FLOOR), multilineConfig(FLOOR)).length,
    ).toBeGreaterThan(0);
    expect(
      coverageFloorViolations(multilineConfig(FLOOR), config(FLOOR)).length,
    ).toBeGreaterThan(0);
    expect(
      coverageFloorViolations(multilineConfig(FLOOR), multilineConfig(FLOOR))
        .length,
    ).toBeGreaterThan(0);
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

// A forma fixa do piso (AI-49): `thresholds` citado uma vez só, num objeto de uma linha com exatamente as quatro chaves,
// cada uma com um número literal. Cada caso mantém o mesmo piso da base, para o único defeito ser a forma.
describe('AI-49 coverageFloorViolations só aceita o piso na forma fixa, nos dois lados da comparação', () => {
  const BLOCK =
    'thresholds: { lines: 92, functions: 92, branches: 83, statements: 91 }';
  const LOW_BLOCK =
    'thresholds: { lines: 1, functions: 1, branches: 1, statements: 1 }';

  function withBlock(block: string): string {
    const text = config(FLOOR).replace(BLOCK, block);
    expect(text).not.toBe(config(FLOOR));
    return text;
  }

  const BAD_SHAPES: [string, string][] = [
    [
      'um segundo thresholds no código',
      config(FLOOR).replace(
        'projects: [],',
        `projects: [{ test: { coverage: { ${LOW_BLOCK} } } }],`,
      ),
    ],
    [
      'um segundo thresholds num comentário',
      config(FLOOR).replace(
        '    projects: [],',
        `    // ${LOW_BLOCK}\n    projects: [],`,
      ),
    ],
    [
      'uma chave a mais',
      withBlock(
        'thresholds: { lines: 92, functions: 92, branches: 83, statements: 91, perFile: true }',
      ),
    ],
    [
      'uma chave a menos',
      withBlock('thresholds: { lines: 92, functions: 92, branches: 83 }'),
    ],
    [
      'um ...spread no começo',
      withBlock(
        'thresholds: { ...OUTRO, lines: 92, functions: 92, branches: 83, statements: 91 }',
      ),
    ],
    [
      'um ...spread no fim',
      withBlock(
        'thresholds: { lines: 92, functions: 92, branches: 83, statements: 91, ...OUTRO }',
      ),
    ],
    [
      'um valor que é uma conta',
      withBlock(
        'thresholds: { lines: 92 - 90, functions: 92, branches: 83, statements: 91 }',
      ),
    ],
    [
      'um valor com uma conversão',
      withBlock(
        'thresholds: { lines: 92 as number, functions: 92, branches: 83, statements: 91 }',
      ),
    ],
    [
      'um valor que é texto',
      withBlock(
        "thresholds: { lines: '92', functions: 92, branches: 83, statements: 91 }",
      ),
    ],
    ['o objeto em mais de uma linha', multilineConfig(FLOOR)],
  ];

  it.each(BAD_SHAPES)(
    'AI-49 %s no PR reprova, mesmo com o piso igual ao da base',
    (_label, head) => {
      expect(
        coverageFloorViolations(config(FLOOR), head).length,
      ).toBeGreaterThan(0);
    },
  );

  it.each(BAD_SHAPES)(
    'AI-49 %s na base reprova, mesmo com o PR na forma certa',
    (_label, base) => {
      expect(
        coverageFloorViolations(base, config(FLOOR)).length,
      ).toBeGreaterThan(0);
    },
  );

  // O comentário com o piso antigo na frente do bloco de verdade, que caiu: lido pelo primeiro `thresholds`, o piso
  // menor passaria escondido.
  it('AI-49 um comentário com o piso da base antes do bloco que caiu não esconde a queda', () => {
    const head = config({ ...FLOOR, branches: 82 }).replace(
      '      thresholds:',
      `      // ${BLOCK}\n      thresholds:`,
    );

    expect(head).toContain(`// ${BLOCK}`);
    expect(coverageFloorViolations(config(FLOOR), head).length).toBeGreaterThan(
      0,
    );
  });

  // Controles negativos: a forma fixa, com outra ordem das chaves ou com um comentário que não cita `thresholds`, passa,
  // e o vitest.config.ts do repositório (de uma linha) continua passando.
  it('AI-49 controle: as quatro chaves em outra ordem, numa linha, passam', () => {
    const reordered = withBlock(
      'thresholds: { statements: 91, branches: 83, functions: 92, lines: 92 }',
    );

    expect(coverageFloorViolations(config(FLOOR), reordered)).toEqual([]);
    expect(coverageFloorViolations(reordered, config(FLOOR))).toEqual([]);
  });

  it('AI-49 controle: um comentário que não cita thresholds não reprova', () => {
    const commented = config(FLOOR).replace(
      '    projects: [],',
      '    // o piso só sobe\n    projects: [],',
    );

    expect(coverageFloorViolations(config(FLOOR), commented)).toEqual([]);
  });

  it('AI-49 controle: o vitest.config.ts do repositório cita thresholds uma vez só, numa linha com as quatro chaves', () => {
    const text = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');

    expect(text.match(/thresholds/g)).toHaveLength(1);
    expect(coverageFloorViolations(text, text)).toEqual([]);
  });
});

// A forma fixa, parte 2 (AI-49): `thresholds` só dentro do bloco `coverage:`, que aparece uma vez; o arquivo não tem
// chave computada (`[expressão]:`), e o bloco `coverage:` não tem `...`. Cada caso mantém o piso da base, para o único
// defeito ser a forma. A isca é o `thresholds` de um comentário, que a leitura por texto tomaria pelo bloco de verdade.
describe('AI-49 coverageFloorViolations reprova o thresholds fora do bloco coverage, a chave computada e o ... no bloco', () => {
  const FLOOR_BLOCK =
    'thresholds: { lines: 92, functions: 92, branches: 83, statements: 91 }';
  const DECOY = `    // ${FLOOR_BLOCK}\n`;

  function edit(text: string, from: string, to: string): string {
    const result = text.replace(from, to);
    expect(result, `trecho trocado: ${from}`).not.toBe(text);
    return result;
  }

  const withoutFloor = edit(config(FLOOR), `      ${FLOOR_BLOCK},\n`, '');

  const BAD_SHAPES: [string, string][] = [
    [
      'o thresholds ao lado do bloco coverage (fora dele), numa linha',
      edit(
        withoutFloor,
        '    projects: [],',
        `    ${FLOOR_BLOCK},\n    projects: [],`,
      ),
    ],
    [
      'o thresholds dentro de um projeto (fora do bloco coverage)',
      edit(
        withoutFloor,
        'projects: [],',
        `projects: [{ test: { ${FLOOR_BLOCK} } }],`,
      ),
    ],
    [
      'o thresholds antes do bloco coverage (fora dele), e um coverage sem piso depois',
      edit(
        withoutFloor,
        '    coverage: {',
        `    ${FLOOR_BLOCK},\n    coverage: {`,
      ),
    ],
    [
      'o bloco coverage citado duas vezes',
      edit(
        config(FLOOR),
        'projects: [],',
        "projects: [{ test: { coverage: { provider: 'v8' } } }],",
      ),
    ],
    [
      "uma chave computada ['thresh' + 'olds'] com a isca num comentário",
      edit(
        edit(
          config(FLOOR),
          `      ${FLOOR_BLOCK},\n`,
          "      ['thresh' + 'olds']: { lines: 1, functions: 1, branches: 1, statements: 1 },\n",
        ),
        '    projects: [],',
        `${DECOY}    projects: [],`,
      ),
    ],
    [
      "uma chave computada de template (cover${''}age) com a isca num comentário",
      edit(
        edit(
          edit(config(FLOOR), `      ${FLOOR_BLOCK},\n`, ''),
          '    coverage: {',
          "    [`cover${''}age`]: {",
        ),
        '    projects: [],',
        `${DECOY}    projects: [],`,
      ),
    ],
    [
      'uma chave computada longe do piso (num projeto), com o piso na forma certa',
      edit(
        config(FLOOR),
        'projects: [],',
        "projects: [{ test: { [`na${'me'}`]: 'unit' } }],",
      ),
    ],
    [
      'uma chave computada por identificador ([nome]:)',
      edit(
        config(FLOOR),
        'projects: [],',
        "projects: [{ test: { [nome]: 'unit' } }],",
      ),
    ],
    [
      'um ...spread no começo do bloco coverage',
      edit(
        config(FLOOR),
        "      provider: 'v8',",
        "      ...extra,\n      provider: 'v8',",
      ),
    ],
    [
      'um ...spread no fim do bloco coverage, depois do thresholds',
      edit(
        config(FLOOR),
        `${FLOOR_BLOCK},\n`,
        `${FLOOR_BLOCK},\n      ...extra,\n`,
      ),
    ],
  ];

  // Cada forma ruim, de cada lado: o outro lado é o piso na forma certa e igual.
  const BOTH_SIDES = BAD_SHAPES.flatMap(([label, text]) => [
    { name: `${label} no PR`, base: config(FLOOR), head: text },
    { name: `${label} na base`, base: text, head: config(FLOOR) },
  ]);

  it.each(BOTH_SIDES)(
    'AI-49 $name reprova, mesmo com o piso igual',
    ({ base, head }) => {
      expect(coverageFloorViolations(base, head)).not.toEqual([]);
    },
  );

  // Controles negativos: o ... fora do bloco coverage e os colchetes de lista não são chave computada nem spread
  // do bloco, e o vitest.config.ts do repositório (que tem o ...configDefaults.exclude) continua passando.
  it('AI-49 controle: um ...configDefaults.exclude fora do bloco coverage passa, nos dois lados', () => {
    const spread = edit(
      config(FLOOR),
      'projects: [],',
      'projects: [{ test: { exclude: [...configDefaults.exclude] } }],',
    );

    expect(coverageFloorViolations(config(FLOOR), spread)).toEqual([]);
    expect(coverageFloorViolations(spread, config(FLOOR))).toEqual([]);
  });

  it('AI-49 controle: o vitest.config.ts do repositório, que tem ...configDefaults.exclude fora do bloco coverage, passa', () => {
    const text = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');

    expect(text).toContain('...configDefaults.exclude');
    expect(coverageFloorViolations(text, text)).toEqual([]);
  });
});

// O piso longo (AI-49): quatro pisos de 100 passam das 80 colunas do Prettier com a indentação do arquivo. O
// `// prettier-ignore` logo acima mantém a linha inteira, e a conferência a lê do mesmo jeito. Sem ele, o Prettier
// quebra o objeto em várias linhas, forma que a conferência reprova.
describe('AI-49 o piso longo com // prettier-ignore passa no Prettier e na conferência', () => {
  const LONG: Floor = {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
  };
  const prettierBin = join(repoRoot, 'node_modules', '.bin', 'prettier');

  function longConfig(withIgnore: boolean): string {
    const text = config(LONG);
    if (!withIgnore) return text;
    return text.replace(
      '      thresholds:',
      '      // prettier-ignore\n      thresholds:',
    );
  }

  // O arquivo fica numa pasta temporária fora do repositório; a configuração do projeto entra por --config.
  function runPrettier(
    content: string,
    mode: '--check' | 'format',
  ): { status: number | null; stdout: string; output: string } {
    const file = join(makeTempDir('ai49-prettier-'), 'vitest.config.ts');
    writeFileSync(file, content);
    const args = [
      '--config',
      join(repoRoot, '.prettierrc.json'),
      '--ignore-path',
      '/dev/null',
    ];
    if (mode === '--check') args.push('--check');
    const result = spawnSync(prettierBin, [...args, file], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  it('AI-49 a linha do piso de 100 passa das 80 colunas (premissa dos casos abaixo)', () => {
    const line = config(LONG)
      .split('\n')
      .find((candidate) => candidate.includes('thresholds'));

    expect(line?.length).toBeGreaterThan(80);
  });

  it('AI-49 o piso longo com // prettier-ignore passa na conferência, contra ele mesmo e contra um piso menor', () => {
    const text = longConfig(true);

    expect(text).toContain('// prettier-ignore\n      thresholds:');
    expect(coverageFloorViolations(text, text)).toEqual([]);
    expect(
      coverageFloorViolations(
        text,
        longConfig(true).replace('lines: 100', 'lines: 99'),
      ),
    ).toEqual([expect.stringContaining('lines')]);
  });

  it('AI-49 o piso longo com // prettier-ignore passa no prettier --check', () => {
    const result = runPrettier(longConfig(true), '--check');

    expect(result.output).not.toContain('Code style issues');
    expect(result.output).toContain(
      'All matched files use Prettier code style',
    );
    expect(result.status).toBe(0);
  });

  it('AI-49 o mesmo piso sem o // prettier-ignore reprova no prettier --check', () => {
    const result = runPrettier(longConfig(false), '--check');

    expect(result.output).toContain('Code style issues');
    expect(result.status).toBeGreaterThan(0);
  });

  it('AI-49 o mesmo piso sem o // prettier-ignore, como o Prettier o reformata em várias linhas, reprova na conferência', () => {
    const formatted = runPrettier(longConfig(false), 'format');

    expect(formatted.status).toBe(0);
    expect(formatted.stdout).toMatch(/thresholds: \{\n\s+lines: 100,/);
    expect(
      coverageFloorViolations(config(LONG), formatted.stdout).length,
    ).toBeGreaterThan(0);
    expect(
      coverageFloorViolations(formatted.stdout, formatted.stdout).length,
    ).toBeGreaterThan(0);
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
  // --allow-empty: com pisos e linha de base iguais aos da base o PR não muda arquivo, e o git recusaria o commit.
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'pr');
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

  it('AI-49 só o arquivo da linha de base falta na base (o PR que o cria): a ref existe e o CLI sai com 0', () => {
    const { run } = prSandbox({
      base: { config: config(FLOOR) },
      head: {
        config: config(FLOOR),
        baseline: baseline(BASE_FINGERPRINTS),
      },
    });
    const result = run();

    expect(result.status, result.stderr).toBe(0);
  });

  it('AI-49 BASE_REF apontando para uma ref que não existe sai com código diferente de 0 (sem a base não há o que comparar)', () => {
    const { dir } = prSandbox({
      base: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
      head: { config: config(FLOOR), baseline: baseline(BASE_FINGERPRINTS) },
    });
    const result = runScript(dir, FILE, { BASE_REF: 'ref-que-nao-existe' });

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  });
});
