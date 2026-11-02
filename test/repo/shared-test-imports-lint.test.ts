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
];

let cached: LintReport | undefined;

function report(): LintReport {
  cached ??= lintFilesByLine(
    'ai40-shared-imports-',
    Object.fromEntries(
      SAMPLES.map((entry) => [entry.file, `debugger;\n${entry.import}\n`]),
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
    const restricting = (lines.get(2) ?? []).filter((code) =>
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
