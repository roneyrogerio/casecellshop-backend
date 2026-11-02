import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { lintFilesByLine, type LintReport } from '../helpers/lint-tree.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// OBS-07 (AD-029, A17): o lint só deixa importar o `pino` em `src/shared/logging.ts`. O resto de `src/` recebe um
// `AppLogger` opaco, e é essa regra que impede um arquivo de trazer o logger cru e escrever um log por fora do
// `eventLogger`. O que vale é o que o oxlint decide, com o .oxlintrc.json do projeto numa árvore temporária (a
// restrição é uma regra por arquivo: a que vale para `src/checkout/` ou para `src/app.ts` é a do último override que
// casa, e a do `pino` tem de estar junta com a de cada pasta). Os testes de `src/` (`*.test.ts`) montam o logger do
// pino para o código de produção e continuam livres. O `await import('pino')` é de outra regra, a local
// `test-imports/no-restricted-dynamic-import`, que vale em `src/` pela mesma lista de exceções.

const RESTRICTED = /no-restricted-imports/;
const DYNAMIC = /no-restricted-dynamic-import/;
// Regra do núcleo sempre ligada: prova que o oxlint leu a amostra (o arquivo não ficou de fora por ignore ou caminho).
const CANARY = /no-debugger/;
const LOGGER_FILE = 'src/shared/logging.ts';

// Cada pasta de `src/` com um import de outra pasta que o AD-025 já proíbe nela: o `pino` entra sem derrubar a regra
// que já existia no mesmo override. `undefined` é a pasta sem restrição de pasta hoje.
const FOLDERS: Readonly<Record<string, string | undefined>> = {
  billing: '../checkout/repository.ts',
  cache: '../checkout/repository.ts',
  catalog: '../checkout/repository.ts',
  checkout: '../billing/worker.ts',
  contract: '../checkout/repository.ts',
  db: '../checkout/repository.ts',
  erp: '../checkout/repository.ts',
  health: '../billing/worker.ts',
  http: '../checkout/repository.ts',
  main: undefined,
  orders: '../checkout/repository.ts',
  queue: '../checkout/repository.ts',
  shared: '../http/problem.ts',
};

type Expectation = 'blocked' | 'pass' | 'kept';

interface Line {
  text: string;
  expected: Expectation;
  label: string;
  // O import('pino') é de outra regra do lint (a local test-imports/no-restricted-dynamic-import).
  dynamic?: true;
}

interface Sample {
  file: string;
  lines: Line[];
}

// Uma forma de importar o pino por linha, cada uma com o nome local próprio.
function pinoForms(expected: 'blocked' | 'pass'): Line[] {
  return [
    {
      text: "import { pino as named } from 'pino';",
      expected,
      label: 'import por nome',
    },
    {
      text: "import standard from 'pino';",
      expected,
      label: 'import padrão',
    },
    {
      text: "import * as everything from 'pino';",
      expected,
      label: 'import de namespace',
    },
    {
      text: "import type { Logger as RawLogger } from 'pino';",
      expected,
      label: 'import de tipo',
    },
    {
      text: "const dynamicPino = await import('pino');",
      expected,
      label: "import dinâmico (await import('pino'))",
      dynamic: true,
    },
  ];
}

function sample(file: string, expected: 'blocked' | 'pass', kept?: string) {
  const lines: Line[] = [
    { text: 'debugger;', expected: 'pass', label: 'canário' },
    ...pinoForms(expected),
  ];
  if (kept !== undefined)
    lines.push({
      text: `import { x as keptImport } from '${kept}';`,
      expected: 'kept',
      label: `a regra de pastas de sempre (${kept})`,
    });
  return { file, lines } satisfies Sample;
}

const SAMPLES: Sample[] = [
  // O arquivo do logger é a única exceção, e só para o pino: a regra de pastas de `src/shared/` continua nele.
  sample(LOGGER_FILE, 'pass', FOLDERS['shared']),
  sample('src/app.ts', 'blocked', './main/api.ts'),
  sample('src/amostra.ts', 'blocked'),
  ...Object.entries(FOLDERS).flatMap(([folder, kept]) => [
    sample(`src/${folder}/amostra.ts`, 'blocked', kept),
    // Os testes de src/ montam o logger do pino para o código de produção: livres.
    sample(`src/${folder}/amostra.test.ts`, 'pass'),
  ]),
  // Fora de `src/` o pino é livre (os helpers de teste e os scripts o importam).
  sample('lib/amostra.ts', 'pass'),
  sample('test/helpers/amostra.ts', 'pass'),
];

let cached: LintReport | undefined;

function report(): LintReport {
  cached ??= lintFilesByLine(
    'obs07-pino-import-',
    Object.fromEntries(
      SAMPLES.map((entry) => [
        entry.file,
        `${entry.lines.map((line) => line.text).join('\n')}\n`,
      ]),
    ),
  );
  return cached;
}

// Uma frase por defeito do arquivo: o import que devia reprovar e passou, o que devia passar e reprovou, a regra
// antiga que sumiu do override, ou o oxlint que não leu a amostra.
function defects(entry: Sample): string[] {
  const lines = report().byFile.get(entry.file) ?? new Map<number, string[]>();
  const found: string[] = [];
  entry.lines.forEach((line, index) => {
    const codes = lines.get(index + 1) ?? [];
    const rule = line.dynamic ? DYNAMIC : RESTRICTED;
    const restricting = codes.filter((code) => rule.test(code));
    const where = `${entry.file}:${index + 1} ${line.label}`;
    if (line.label === 'canário') {
      if (!codes.some((code) => CANARY.test(code)))
        found.push(`${where}: o oxlint não leu a amostra`);
    } else if (line.expected === 'pass' && restricting.length > 0) {
      found.push(`${where}: devia passar e reprovou`);
    } else if (line.expected !== 'pass' && restricting.length === 0) {
      found.push(
        line.expected === 'kept'
          ? `${where}: a regra que já existia deixou de reprovar`
          : `${where}: devia reprovar pela regra ${rule.source} e passou`,
      );
    }
  });
  return found;
}

afterAll(cleanupTempDirs);

const blocked = SAMPLES.filter((entry) =>
  entry.lines.some((line) => line.expected === 'blocked'),
);

describe('OBS-07 o lint só deixa importar o pino em src/shared/logging.ts (A17)', () => {
  it.each(blocked)(
    'OBS-07 em $file o import do pino (por nome, padrão, namespace, de tipo e dinâmico) reprova, e a regra de pastas de sempre continua',
    (entry) => {
      expect(defects(entry)).toEqual([]);
    },
  );

  it('OBS-07 src/shared/logging.ts importa o pino sem reprovar, e a regra de pastas de src/shared/ continua nele', () => {
    const logger = SAMPLES.find((entry) => entry.file === LOGGER_FILE);

    expect(defects(logger as Sample)).toEqual([]);
  });

  it.each(
    SAMPLES.filter(
      (entry) =>
        entry.file.endsWith('.test.ts') || !entry.file.startsWith('src/'),
    ),
  )(
    'OBS-07 em $file (teste de src/ ou arquivo fora de src/) o pino é livre',
    (entry) => {
      expect(defects(entry)).toEqual([]);
    },
  );

  it('OBS-07 controle positivo: o oxlint reprovou ao menos um import do pino (a leitura da saída enxerga as linhas)', () => {
    const lines = report().byFile.get('src/checkout/amostra.ts');

    expect(lines).toBeDefined();
    expect(
      [...(lines?.values() ?? [])]
        .flat()
        .filter((code) => RESTRICTED.test(code)).length,
    ).toBeGreaterThan(0);
  });

  it('OBS-07 controle: a lista de pastas cobre toda pasta de src/ (uma pasta nova entra aqui e no lint)', () => {
    const folders = readdirSync(join(repoRoot, 'src'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    expect(Object.keys(FOLDERS)).toEqual(expect.arrayContaining(folders));
  });
});
