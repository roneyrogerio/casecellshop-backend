import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { lintFilesByLine, type LintReport } from '../helpers/lint-tree.ts';

// AI-40 (AD-025): a regra de imports de `src/shared/`. O teste da pasta importa os helpers de `test/helpers/` só pelo
// atalho `#test-helpers/`; em toda a pasta, qualquer segmento `..` e qualquer barra invertida no import são barrados,
// e o código de produção não importa atalho `#` nenhum. O que vale é o que o oxlint decide, com o .oxlintrc.json do
// projeto numa árvore temporária (nada é escrito no repositório).

const RESTRICTED = /no-restricted-imports/;
// Regra do núcleo sempre ligada: prova que o oxlint leu a amostra (o arquivo não ficou de fora por ignore ou caminho).
const CANARY = /no-debugger/;

const SHORTCUT = '#test-helpers/clock.ts';
const OTHER_FOLDER = '../db/database.ts';
// O Node e o tsc leem a barra invertida como separador, então `./..\db\` sai da pasta. As barras duplicadas aqui chegam
// ao arquivo da amostra como `\\`, que o parser lê como uma barra invertida de verdade no specifier.
const BACKSLASH = './..\\\\db\\\\database.ts';

interface Sample {
  file: string;
  path: string;
  // O lint tem de reprovar o import com o no-restricted-imports, ou deixá-lo passar.
  expected: 'blocked' | 'pass';
  label: string;
}

// O logging.test.ts e o logging.ts têm override próprio (cópias da lista da pasta): cada um passa pelas mesmas amostras.
const TEST_FILES = ['src/shared/x.test.ts', 'src/shared/logging.test.ts'];
const PRODUCTION_FILES = ['src/shared/x.ts', 'src/shared/logging.ts'];

const SAMPLES: Sample[] = [
  ...TEST_FILES.flatMap((file): Sample[] => [
    {
      file,
      path: SHORTCUT,
      expected: 'pass',
      label: 'o teste importa o atalho #test-helpers/',
    },
    {
      file,
      path: OTHER_FOLDER,
      expected: 'blocked',
      label: 'o teste importa outra pasta de src/ por ..',
    },
    {
      file,
      path: '#test-helpers/../../src/db/database.ts',
      expected: 'blocked',
      label: 'o teste volta a src/ pelo atalho com ..',
    },
    {
      file,
      path: BACKSLASH,
      expected: 'blocked',
      label: 'o teste esconde o .. atrás de barra invertida',
    },
  ]),
  ...PRODUCTION_FILES.flatMap((file): Sample[] => [
    {
      file,
      path: SHORTCUT,
      expected: 'blocked',
      label: 'o código de produção importa o atalho #test-helpers/',
    },
    {
      file,
      path: OTHER_FOLDER,
      expected: 'blocked',
      label: 'o código de produção importa outra pasta de src/ por ..',
    },
  ]),
  // Controle: o import de um arquivo da própria pasta segue livre.
  {
    file: 'src/shared/own.test.ts',
    path: './logging.ts',
    expected: 'pass',
    label: 'o teste importa um arquivo da própria pasta',
  },
  {
    file: 'src/shared/own.ts',
    path: './logging.ts',
    expected: 'pass',
    label: 'o código de produção importa um arquivo da própria pasta',
  },
];

// Várias amostras dividem um arquivo (o override do logging.test.ts vale pelo nome): a linha 1 leva o canário e a
// amostra i do arquivo fica na linha i + 2.
function samplesOf(file: string): Sample[] {
  return SAMPLES.filter((entry) => entry.file === file);
}

function lineOf(sample: Sample): number {
  return samplesOf(sample.file).indexOf(sample) + 2;
}

// Um nome por import: dois imports com o mesmo nome no arquivo seriam erro de sintaxe e o oxlint não leria a amostra.
function contentOf(file: string): string {
  const imports = samplesOf(file).map(
    (entry, index) => `import { x${index} } from '${entry.path}';`,
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

describe('AI-40 o lint de src/shared/ deixa o teste importar #test-helpers/ e barra o .. e a barra invertida', () => {
  it.each(SAMPLES)('AI-40 $label ($file: $path)', (entry) => {
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
