import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { lintFilesByLine, type LintReport } from '../helpers/lint-tree.ts';

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
  ];
  // Um nome por import: dois imports com o mesmo nome no arquivo seriam erro de sintaxe e o oxlint não leria a amostra.
  const samples: Sample[] = blockedInTest.map((path, index) => ({
    file: 'src/shared/escape.test.ts',
    import: `import { x${index} } from '${path}';`,
    expected: 'blocked',
    label: `o teste de src/shared/ tenta escapar por ${path}`,
  }));
  samples.push(
    {
      file: 'src/shared/escape.test.ts',
      import: "import { sub } from '../../test/helpers/sub/x.ts';",
      expected: 'pass',
      label:
        'o teste de src/shared/ importa uma subpasta de test/helpers/ sem ..',
    },
    // O arquivo do override próprio do logging.test.ts: a mesma regra, pelo nome dele.
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
