import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import {
  lintFilesByLine,
  PARITY_TIMEOUT_MS,
  runOxlint,
  singleRuleConfig,
  type LintReport,
} from '../helpers/lint-tree.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// AI-40 (AD-025): a regra de pastas de `src/shared/`. Produção em `src/shared/` não importa outra pasta, nem `test/`;
// o teste dele (`*.test.ts`) pode importar os helpers de `test/helpers/` (`../../test/helpers/...`), para não copiar
// o relógio manual, mas segue barrado em `../<outra pasta de src>`. O que vale é o que o oxlint decide, com o
// .oxlintrc.json do projeto numa árvore temporária (nada é escrito no repositório).

const RESTRICTED = /no-restricted-imports/;
// Regra do núcleo sempre ligada: prova que o oxlint leu a amostra (o arquivo não ficou de fora por ignore ou caminho).
const CANARY = /no-debugger/;

const HELPER_IMPORT =
  "import { createManualClock } from '../../test/helpers/clock.ts';";

interface Sample {
  file: string;
  import: string;
  // O lint tem de reprovar o import com o no-restricted-imports, ou deixá-lo passar.
  expected: 'blocked' | 'pass';
  label: string;
}

const SAMPLES: Sample[] = [
  {
    file: 'src/shared/x.test.ts',
    import: HELPER_IMPORT,
    expected: 'pass',
    label: 'o teste de src/shared/ importa test/helpers/',
  },
  {
    file: 'src/shared/db.test.ts',
    import: "import { createDb } from '../db/database.ts';",
    expected: 'blocked',
    label: 'o teste de src/shared/ importa outra pasta de src/ (../db)',
  },
  {
    file: 'src/shared/sibling.test.ts',
    import: "import { createDb } from '../../src/db/database.ts';",
    expected: 'blocked',
    label: 'o teste de src/shared/ importa outra pasta de src/ por ../../src/',
  },
  {
    file: 'src/shared/x.ts',
    import: HELPER_IMPORT,
    expected: 'blocked',
    label: 'o código de produção de src/shared/ importa test/helpers/',
  },
  // Controle: o import de um arquivo da própria pasta segue livre no teste e na produção.
  {
    file: 'src/shared/own.test.ts',
    import: "import { createLogger } from './logging.ts';",
    expected: 'pass',
    label: 'o teste de src/shared/ importa um arquivo da própria pasta',
  },
  {
    file: 'src/shared/own.ts',
    import: "import { createLogger } from './logging.ts';",
    expected: 'pass',
    label: 'o código de produção de src/shared/ importa um arquivo da pasta',
  },
  ...escapeSamples(),
];

// Tentativas de escapar da regra: o `..` escondido atrás de `./`, `//`, `/./` ou de uma volta por `test/`. O padrão
// da regra não pode depender de lookahead (o oxlint ignora um padrão com lookahead sem avisar), então o que vale
// aqui é o resultado do oxlint sobre cada caminho.
function escapeSamples(): Sample[] {
  // O Node e o tsc leem a barra invertida como separador, então `./..\db\` sai da pasta. O arquivo da amostra leva
  // `\\` (duas barras) em cada separador: com uma só, o parser leria `\d` como `d` e o specifier perderia a barra
  // invertida que a regra tem de barrar. Por isso o literal abaixo tem quatro barras por separador.
  const backslash = './..\\\\db\\\\database.ts';
  const blockedInTest = [
    '.././db/database.ts',
    '../../test/../src/db/database.ts',
    '../..//src/db/database.ts',
    '../../test/integration/x.ts',
    '../../scripts/x.ts',
    './../db/x.ts',
    '../../test/helpers/../x.ts',
    '../../test/helpers/./x.ts',
    '../../src/db/x.ts',
    backslash,
    // Uma amostra por padrão que nenhuma das de cima barra sozinha, citando cada padrão pelo que ele barra e não pela
    // posição na lista (que já mudou): o `//` (o `file:///` não tem `..`), o `..` sozinho ou `../..` (sem nada depois)
    // e o prefixo de `test/helpers/` sem arquivo (`../../test/helpers/`, com a barra final).
    'file:///src/db/x.ts',
    '..',
    '../../test/helpers/',
  ];
  // O logging.test.ts tem um override próprio (a lista é uma cópia da dos testes da pasta): passa por ele cada amostra
  // dos testes da pasta, para uma divergência entre as duas cópias reprovar o teste.
  const testFiles = ['src/shared/escape.test.ts', 'src/shared/logging.test.ts'];
  const samples: Sample[] = [];
  for (const file of testFiles) {
    // Um nome por import: dois imports com o mesmo nome no arquivo seriam erro de sintaxe e o oxlint não leria a amostra.
    blockedInTest.forEach((path, index) =>
      samples.push({
        file,
        import: `import { x${index} } from '${path}';`,
        expected: 'blocked',
        label: `o teste de src/shared/ tenta escapar por ${path}`,
      }),
    );
    samples.push({
      file,
      import: "import { sub } from '../../test/helpers/sub/x.ts';",
      expected: 'pass',
      label:
        'o teste de src/shared/ importa uma subpasta de test/helpers/ sem ..',
    });
  }
  samples.push(
    {
      file: 'src/shared/logging.test.ts',
      import: "import { clock } from '../../test/helpers/clock.ts';",
      expected: 'pass',
      label: 'o logging.test.ts importa test/helpers/',
    },
    {
      file: 'src/shared/logging.test.ts',
      import: "import { db } from '../db/database.ts';",
      expected: 'blocked',
      label: 'o logging.test.ts importa outra pasta de src/ (../db)',
    },
    // A produção não tem a porta de test/helpers/ e barra qualquer segmento `..`, também escondido atrás de `./`.
    {
      file: 'src/shared/escape.ts',
      import: "import { dotSlash } from './../db/x.ts';",
      expected: 'blocked',
      label: 'o código de produção de src/shared/ tenta escapar por ./../db/',
    },
    {
      file: 'src/shared/escape.ts',
      import: "import { slashDot } from '.././db/database.ts';",
      expected: 'blocked',
      label: 'o código de produção de src/shared/ tenta escapar por .././db/',
    },
    {
      file: 'src/shared/escape.ts',
      import: `import { backslash } from '${backslash}';`,
      expected: 'blocked',
      label: `o código de produção de src/shared/ tenta escapar por ${backslash}`,
    },
    {
      file: 'src/shared/logging.ts',
      import: `import { backslash } from '${backslash}';`,
      expected: 'blocked',
      label: `o logging.ts tenta escapar por ${backslash}`,
    },
  );
  return samples;
}

// Várias amostras dividem um arquivo (o override do logging.test.ts vale pelo nome): a linha 1 leva o canário e a
// amostra i do arquivo fica na linha i + 2.
function lineOf(sample: Sample): number {
  return (
    SAMPLES.filter((other) => other.file === sample.file).indexOf(sample) + 2
  );
}

function contentOf(file: string): string {
  const imports = SAMPLES.filter((entry) => entry.file === file).map(
    (entry) => entry.import,
  );
  return `debugger;\n${imports.join('\n')}\n`;
}

let cached: LintReport | undefined;

function report(): LintReport {
  cached ??= lintFilesByLine(
    'ai40-shared-imports-',
    Object.fromEntries(
      [...new Set(SAMPLES.map((entry) => entry.file))].map((file) => [
        file,
        contentOf(file),
      ]),
    ),
  );
  return cached;
}

afterAll(cleanupTempDirs);

describe('AI-40 o lint de src/shared/ deixa o teste importar test/helpers/ e segue barrando as outras pastas de src/', () => {
  it.each(SAMPLES)('AI-40 $label ($file)', (entry) => {
    const lines =
      report().byFile.get(entry.file) ?? new Map<number, string[]>();
    const canary = lines.get(1) ?? [];
    const restricting = (lines.get(lineOf(entry)) ?? []).filter((code) =>
      RESTRICTED.test(code),
    );

    expect(
      canary.some((code) => CANARY.test(code)),
      'o oxlint leu a amostra',
    ).toBe(true);
    expect(
      restricting.length > 0,
      `${entry.label}: o no-restricted-imports ${restricting.join(', ')}`,
    ).toBe(entry.expected === 'blocked');
  });
});

interface RestrictOptions {
  patterns: { regex: string }[];
}

// As opções do no-restricted-imports do override do `files` dado, lidas do .oxlintrc.json real.
function optionsOf(files: string): RestrictOptions {
  const config = JSON.parse(
    readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'),
  ) as {
    overrides: { files: string[]; rules: Record<string, unknown> }[];
  };
  const rule = config.overrides.find((override) =>
    override.files.includes(files),
  )?.rules['no-restricted-imports'] as [string, RestrictOptions] | undefined;
  if (rule === undefined) throw new Error(`sem override para ${files}`);
  return rule[1];
}

function oxlintReportsImport(
  options: RestrictOptions,
  path: string,
  name: string,
): boolean {
  const tree = makeTempDir('ai40-control-');
  writeFileIn(tree, 'x.ts', `import { x } from '${path}';\n`);
  const run = runOxlint(
    tree,
    singleRuleConfig([], { 'no-restricted-imports': ['error', options] }),
    name,
  );
  return run.reports.some((report) => report.file === 'x.ts');
}

// Controle das três amostras de `blockedInTest` que só um padrão barra: sem esse padrão o oxlint deixa o import passar,
// então a amostra prova o padrão (e, passada pelo logging.test.ts, a cópia dele). Cada cópia da regra é lida do
// .oxlintrc.json real, e o padrão a tirar é o único da lista que casa o caminho.
describe('AI-40 controle: cada amostra só barrada por um padrão deixa de reprovar sem ele', () => {
  const soloSamples = ['file:///src/db/x.ts', '..', '../../test/helpers/'];
  const copies = ['src/shared/**/*.test.ts', 'src/shared/logging.test.ts'];

  it.each(
    copies.flatMap((files) => soloSamples.map((path) => ({ files, path }))),
  )(
    'AI-40 $path só é barrado por um padrão de $files',
    ({ files, path }) => {
      const options = optionsOf(files);
      const matching = options.patterns.filter(({ regex }) =>
        new RegExp(regex).test(path),
      );
      expect(matching, 'padrões da cópia que casam o caminho').toHaveLength(1);

      expect(oxlintReportsImport(options, path, 'full.json')).toBe(true);
      expect(
        oxlintReportsImport(
          {
            patterns: options.patterns.filter(
              (pattern) => !matching.includes(pattern),
            ),
          },
          path,
          'without.json',
        ),
      ).toBe(false);
    },
    PARITY_TIMEOUT_MS,
  );
});
