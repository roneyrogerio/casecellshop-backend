import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globToRegExp, overrideFilesMatch } from './glob.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import { PARITY_TIMEOUT_MS, runOxlint, singleRuleConfig } from './lint-tree.ts';

// FND-13 e FND-14: a conferência do lint lida como dado (`files` dos overrides do .oxlintrc.json) decide pelo
// `globToRegExp`; se ele traduz errado, a conferência libera ou reprova o arquivo errado sem avisar.

interface GlobCase {
  glob: string;
  matches: string[];
  rejects: string[];
}

// O que a configuração do lint já usa e o helper já traduzia certo: o controle da correção.
const SUPPORTED: GlobCase[] = [
  {
    glob: 'src/*.ts',
    matches: ['src/a.ts', 'src/.ts'],
    rejects: ['src/a/b.ts', 'src/a.tsx', 'lib/a.ts'],
  },
  {
    glob: '**/*.ts',
    matches: ['a.ts', 'src/a.ts', 'src/a/b/c.ts'],
    rejects: ['a.js', 'src/a.ts.map'],
  },
  {
    glob: 'src/**',
    matches: ['src/a', 'src/a/b/c.ts'],
    rejects: ['lib/a'],
  },
  {
    glob: 'test/**/helpers',
    matches: ['test/helpers', 'test/a/b/helpers'],
    rejects: ['test/helpers/x', 'tests/helpers'],
  },
  {
    glob: 'a?c',
    matches: ['abc', 'a-c'],
    rejects: ['ac', 'abbc', 'a/c'],
  },
  {
    glob: '*.[jt]s',
    matches: ['a.js', 'a.ts'],
    rejects: ['a.cs', 'a.jts'],
  },
  {
    glob: '*.{ts,js}',
    matches: ['a.ts', 'a.js'],
    rejects: ['a.cs', 'a.ts,js', 'a.'],
  },
  {
    glob: 'a.b',
    matches: ['a.b'],
    rejects: ['axb'],
  },
  {
    glob: 'a,b',
    matches: ['a,b'],
    rejects: ['a', 'b'],
  },
];

// Os dois defeitos achados na revisão (A18): vírgula fora de chaves depois de um grupo, e classe negada `[!…]`.
const COMMA_OUTSIDE_BRACES: GlobCase[] = [
  {
    glob: '{a,b}/x,y',
    matches: ['a/x,y', 'b/x,y'],
    rejects: ['a/x', 'a/y', 'b/y', 'y'],
  },
  {
    glob: '{a,b}x,y',
    matches: ['ax,y', 'bx,y'],
    rejects: ['ax', 'y', 'by'],
  },
  {
    glob: 'x,{a,b}',
    matches: ['x,a', 'x,b'],
    rejects: ['x', 'a', 'b', 'xa'],
  },
  {
    glob: '{a,b}/x,y/{c,d}.ts',
    matches: ['a/x,y/c.ts', 'b/x,y/d.ts'],
    rejects: ['a/x', 'y/c.ts', 'a/x,y/e.ts'],
  },
];

// A classe negada traduzida para `[^…]` vale para estes casos, em que a classe fica dentro de um trecho do caminho.
// Fora deles o oxlint não segue a regex: no fast-glob 1.1.1 que ele traz, `[!x]` e `[^x]` casam também a `/` (a
// paridade com o oxlint real está em "FND-13 paridade dos files dos overrides com o oxlint").
const NEGATED_CLASS: GlobCase[] = [
  {
    glob: 'a[!x]',
    matches: ['ab', 'a1', 'a!'],
    rejects: ['ax', 'a'],
  },
  {
    glob: '[!a-c].ts',
    matches: ['d.ts', 'z.ts', '!.ts'],
    rejects: ['a.ts', 'b.ts', 'c.ts'],
  },
  {
    glob: 'src/[!_]*.ts',
    matches: ['src/a.ts', 'src/main.ts'],
    rejects: ['src/_a.ts'],
  },
];

// O primeiro `]` depois do `[` e do `!` ou `^` opcional é membro da classe (fast-glob 1.1.1, medido na paridade); a
// classe fecha no `]` seguinte. Na regex gerada, `]`, `\` e `^` membros precisam de escape para a classe JavaScript
// ter o mesmo conjunto (`[]]` em JavaScript é uma classe vazia seguida de `]`, que não casa nada).
const CLASS_MEMBERS: GlobCase[] = [
  {
    glob: 'a[]]b',
    matches: ['a]b'],
    rejects: ['ab', 'axb', 'a]]b'],
  },
  {
    glob: 'a[!]]b',
    matches: ['axb', 'a^b', 'a/b'],
    rejects: ['a]b', 'ab'],
  },
  {
    glob: 'a[^]]b',
    matches: ['axb', 'a!b'],
    rejects: ['a]b'],
  },
  {
    glob: 'a[x^]b',
    matches: ['axb', 'a^b'],
    rejects: ['ayb', 'a]b', 'ab'],
  },
  {
    glob: 'a[]x]b',
    matches: ['a]b', 'axb'],
    rejects: ['ayb'],
  },
];

// A `\` escapa o caractere seguinte, dentro e fora da classe (fast-glob 1.1.1, medido na paridade). Uma classe com `\]`
// não fecha nesse `]`. O `unescape` do fast-glob troca `\n`, `\r`, `\t` e `\b` pelos caracteres de controle (LF, CR, TAB
// e 0x08), `\a` por `a`, e qualquer outro `\x` por `x`. Os nomes das amostras têm `\` ou caractere de controle só aqui,
// no casamento do helper: o oxlint nunca casou um caminho com `\`.
const ESCAPES: GlobCase[] = [
  {
    glob: 'q/a[\\]]b.js',
    matches: ['q/a]b.js'],
    rejects: ['q/ab.js', 'q/a\\b.js', 'q/a]]b.js'],
  },
  {
    glob: 'q/a[x\\y]b.js',
    matches: ['q/axb.js', 'q/ayb.js'],
    rejects: ['q/a\\b.js', 'q/azb.js'],
  },
  {
    glob: 'q/a\\[b.js',
    matches: ['q/a[b.js'],
    rejects: ['q/ab.js', 'q/a\\b.js'],
  },
  {
    glob: 'q/a[\\-]b.js',
    matches: ['q/a-b.js'],
    rejects: ['q/a\\b.js', 'q/axb.js'],
  },
  {
    glob: 'q/a\\*b.js',
    matches: ['q/a*b.js'],
    rejects: ['q/axb.js', 'q/ab.js'],
  },
  {
    glob: 'q/a\\{x,y}b.js',
    matches: ['q/a{x,y}b.js'],
    rejects: ['q/axb.js', 'q/ayb.js'],
  },
  {
    glob: 'a\\\\b',
    matches: ['a\\b'],
    rejects: ['ab'],
  },
  // `\n`, `\r`, `\t` e `\b` viram caracteres de controle, e não a letra (medido: `q/a\nb.js` não casa `q/anb.js`).
  {
    glob: 'q/a\\nb.js',
    matches: ['q/a\nb.js'],
    rejects: ['q/anb.js'],
  },
  {
    glob: 'q/a[\\n]b.js',
    matches: ['q/a\nb.js'],
    rejects: ['q/anb.js'],
  },
  {
    glob: 'q/a\\bb.js',
    matches: ['q/a\x08b.js'],
    rejects: ['q/abb.js'],
  },
  {
    glob: 'a\\rb',
    matches: ['a\rb'],
    rejects: ['arb'],
  },
  {
    glob: 'a\\tb',
    matches: ['a\tb'],
    rejects: ['atb'],
  },
  // `\a` é o `a` literal (diferente de `\b`).
  {
    glob: 'q/a\\ab.js',
    matches: ['q/aab.js'],
    rejects: ['q/a\x07b.js', 'q/ab.js'],
  },
  // Nas duas pontas de um intervalo a `\x` também vale o `x`: `a\-c` são `a`, `-` e `c`, e `b-\c` é o intervalo b a c.
  {
    glob: 'q/a[a\\-c]b.js',
    matches: ['q/a-b.js', 'q/aab.js', 'q/acb.js'],
    rejects: ['q/abb.js'],
  },
  {
    glob: 'q/a[b-\\c]b.js',
    matches: ['q/abb.js', 'q/acb.js'],
    rejects: ['q/aab.js', 'q/a-b.js'],
  },
  {
    glob: 'q/a[\\b-\\n]b.js',
    matches: ['q/a\x08b.js', 'q/a\nb.js', 'q/a\tb.js'],
    rejects: ['q/abb.js', 'q/anb.js'],
  },
];

// Chaves aninhadas: o helper conta a profundidade, então a vírgula só vira alternativa dentro de alguma chave.
const NESTED_BRACES: GlobCase[] = [
  {
    glob: '{a,{b,c}}/x',
    matches: ['a/x', 'b/x', 'c/x'],
    rejects: ['d/x', 'a', 'x'],
  },
  {
    glob: '{a,b{c,d}}/x,y',
    matches: ['a/x,y', 'bc/x,y', 'bd/x,y'],
    rejects: ['b/x,y', 'a/x', 'bc/y'],
  },
];

function expectCase({ glob, matches, rejects }: GlobCase) {
  const regExp = globToRegExp(glob);
  expect({
    glob,
    matched: matches.filter((sample) => regExp.test(sample)),
    rejected: rejects.filter((sample) => !regExp.test(sample)),
  }).toEqual({ glob, matched: matches, rejected: rejects });
}

// A9 da Revisão 4 do #35: o oxlint recusa a configuração inteira com um destes globs (medido na paridade abaixo), e o
// helper lança um erro em vez de inventar um casamento. O último caso tem uma `\` no fim.
const INVALID_GLOBS: string[][] = [
  ['**/{*.ts,*.js'],
  ['src/{a.ts,b.js'],
  ['**/[ab.ts'],
  ['a\\'],
  // O `]` logo depois do `[` (ou do `[!`, `[^`) é membro da classe, e não o fecho: sem outro `]`, a classe fica aberta.
  ['a[]b.js'],
  ['a[!]b.js'],
  ['a[^]b.js'],
  // O `\]` não fecha a classe: ela continua aberta.
  ['a[\\]b.js'],
  // O inválido entre válidos também recusa a configuração toda, em qualquer posição.
  ['**/*.js', '**/[ab.ts'],
  ['{src/**/*.ts,x.{js}', '**/*.js'],
];

describe('FND-13 globToRegExp', () => {
  it.each(INVALID_GLOBS)(
    'FND-13 o glob inválido lança um erro que diz que o oxlint recusa a configuração: %s',
    (...files) => {
      expect(() => overrideFilesMatch(files, 'x.ts')).toThrow(
        /inválido.*o oxlint recusa a configuração/,
      );
    },
  );

  it.each([
    ['{a,b}'],
    ['{a,{b,c}}/x'],
    ['[ab]'],
    ['a[!x]'],
    ['**/*.{ts,js}'],
    ['a\\\\'],
  ])('FND-13 o glob com chaves e classes fechadas não lança: %s', (glob) => {
    expect(() => globToRegExp(glob)).not.toThrow();
  });

  it.each(SUPPORTED)(
    'FND-13 traduz o que a configuração já usa: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(COMMA_OUTSIDE_BRACES)(
    'FND-13 a vírgula fora de chaves é literal, mesmo depois de um grupo: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(NEGATED_CLASS)(
    'FND-13 a classe negada [!…] casa o que não está nela: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(CLASS_MEMBERS)(
    'FND-13 o ] logo depois do [ (ou do [!) é membro da classe, e ] ^ \\ membros são escapados: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(ESCAPES)(
    'FND-13 a \\ escapa o caractere seguinte, dentro e fora da classe: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(NESTED_BRACES)(
    'FND-13 chaves aninhadas viram alternativas só dentro das chaves: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );
});

// ---------------------------------------------------------------- paridade com o oxlint instalado

// O que o oxlint reporta é a medida: cada teste roda o binário do projeto sobre uma árvore temporária (fora do
// repositório) e compara o que ele casou com o que o helper diz. Um processo por glob, feitos uma vez no `beforeAll`.

// Um arquivo por amostra com `debugger;`: o oxlint reporta o arquivo se o override com `no-debugger` o casar.
const FILE_SAMPLES = [
  'a/b.js',
  'axb.js',
  'ayb.js',
  'sub/x.ts',
  'x.ts',
  'a/b/c.ts',
  // Nome que começa por `!`: mede que, sem `/`, o `!` do glob é literal (`!*.ts` vira `**/!*.ts`) e não nega.
  'sub/!x.ts',
  // Nomes com `]` e `^` entre o `a` e o `b`: medem o `]` e o `^` como membros da classe.
  'a]b.js',
  'a^b.js',
  // Pasta `q/` das amostras de escape: o nome tem o caractere que a `\` do glob tira do significado (`]`, `[`, `-`,
  // `*`, `{`). Nenhum nome tem `\`: o oxlint nunca casou um caminho com `\`.
  'q/a]b.js',
  'q/axb.js',
  'q/ayb.js',
  'q/a[b.js',
  'q/a-b.js',
  'q/a*b.js',
  'q/a{x,y}b.js',
  // Letras `n`, `b`, `a` e `c`: o `\n` e o `\b` do glob não as casam (viram LF e 0x08), o `\a` casa o `a`.
  'q/anb.js',
  'q/abb.js',
  'q/aab.js',
  'q/acb.js',
];

// A `\` escapa o caractere seguinte (fast-glob 1.1.1), dentro e fora da classe: o glob e o que o oxlint deve casar.
// `\n`, `\r`, `\t` e `\b` não são letras: viram LF, CR, TAB e 0x08 (o `unescape` do fast-glob), então não casam nada.
const ESCAPE_EXPECTED: [string, string[]][] = [
  ['q/a[\\]]b.js', ['q/a]b.js']],
  ['q/a[x\\y]b.js', ['q/axb.js', 'q/ayb.js']],
  ['q/a\\[b.js', ['q/a[b.js']],
  ['q/a[\\-]b.js', ['q/a-b.js']],
  ['q/a\\*b.js', ['q/a*b.js']],
  ['q/a\\{x,y}b.js', ['q/a{x,y}b.js']],
  ['q/a\\nb.js', []],
  ['q/a[\\n]b.js', []],
  ['q/a\\bb.js', []],
  ['q/a\\ab.js', ['q/aab.js']],
  ['q/a[a\\-c]b.js', ['q/a-b.js', 'q/aab.js', 'q/acb.js']],
  ['q/a[b-\\c]b.js', ['q/abb.js', 'q/acb.js']],
];

// Cada caso é o `files` inteiro de um override: um padrão só, ou vários (o `GlobSet` casa se algum casar).
const OVERRIDE_FILES: string[][] = [
  ...ESCAPE_EXPECTED.map(([glob]) => [glob]),
  ['a[!x]b.js'],
  ['a[^x]b.js'],
  ['a[/y]b.js'],
  ['a[xy]b.js'],
  // O `]` logo depois do `[` ou do `[!`/`[^` é membro; o `^` que não está no início da classe também.
  ['a[]]b.js'],
  ['a[!]]b.js'],
  ['a[^]]b.js'],
  ['a[x^]b.js'],
  ['a[]x]b.js'],
  ['a?b.js'],
  ['*.ts'],
  ['./x.ts'],
  ['sub/*.ts'],
  ['**/*.ts'],
  ['a/**'],
  ['{a,sub}/**/*.ts'],
  ['!**/*.js'],
  ['!*.ts'],
  ['!!**/*.js'],
  ['x.ts'],
  ['./sub/x.ts'],
  ['./*.ts'],
  // O `!` vale para o glob inteiro, pasta e nome (A1 do #35).
  ['!sub/*.[jt]s'],
  ['!sub/[a-z]*.?s'],
  ['!**/*.[jt]s'],
  // Mais de um padrão (A3 do #35): o conjunto casa se algum padrão casar, e um `!` dentro dele não exclui nada.
  ['**/*.ts', '!x.ts'],
  ['!x.ts', '**/*.ts'],
  ['sub/*.ts', 'x.ts'],
  ['!sub/*.ts', '!x.ts'],
  // Controle: o `!x.ts` sozinho (sem `/`, vira `**/!x.ts`, um nome literal) só casa o `sub/!x.ts`, então o `x.ts` que o
  // conjunto `['**/*.ts', '!x.ts']` reporta vem do `**/*.ts`, e não do `!x.ts`.
  ['!x.ts'],
];

function filesLabel(files: readonly string[]): string {
  return JSON.stringify(files);
}

// O oxlint recusa a configuração inteira com um glob inválido: ou sai com um status que não é 0 nem 1, ou diz
// "Invalid glob pattern" (em stdout ou stderr).
function oxlintRefusedGlob(run: {
  status: number | null;
  stdout: string;
  stderr: string;
}): boolean {
  return (
    (run.status !== 0 && run.status !== 1) ||
    /Invalid glob pattern/.test(run.stdout + run.stderr)
  );
}

describe('FND-13 paridade dos files dos overrides com o oxlint', () => {
  const measured = new Map<string, string[]>();
  // Falhas inesperadas: um glob válido que o oxlint recusou ou que escreveu em stderr, e um glob inválido que ele aceitou.
  const failures: string[] = [];
  // Os globs inválidos que o oxlint recusou, como esperado.
  const refused = new Set<string>();
  // A saída do oxlint (status, stdout e stderr) para cada glob inválido.
  const details = new Map<string, string>();

  function runOverride(tree: string, files: string[], name: string) {
    return runOxlint(
      tree,
      singleRuleConfig([{ files, rules: { 'no-debugger': 'error' } }]),
      name,
    );
  }

  beforeAll(() => {
    const tree = makeTempDir('glob-parity-');
    for (const file of FILE_SAMPLES) writeFileIn(tree, file, 'debugger;\n');
    OVERRIDE_FILES.forEach((files, index) => {
      const run = runOverride(tree, files, `override-${String(index)}.json`);
      // A recusa da configuração sai em stdout com status 1 (medido), igual ao status de achados do lint: só olhar o
      // status e o stderr deixaria um glob válido recusado passar com zero relatórios.
      if (
        run.stderr !== '' ||
        (run.status !== 0 && run.status !== 1) ||
        oxlintRefusedGlob(run)
      )
        failures.push(
          `${filesLabel(files)}: status ${String(run.status)} ${run.stdout}${run.stderr}`,
        );
      measured.set(
        filesLabel(files),
        run.reports.map((report) => report.file).sort(),
      );
    });
    INVALID_GLOBS.forEach((files, index) => {
      const run = runOverride(tree, files, `invalid-${String(index)}.json`);
      details.set(
        filesLabel(files),
        `status ${String(run.status)} ${run.stdout}${run.stderr}`,
      );
      if (oxlintRefusedGlob(run)) refused.add(filesLabel(files));
      else
        failures.push(
          `${filesLabel(files)}: o oxlint devia recusar o glob inválido, mas saiu com status ${String(run.status)} e ${String(run.reports.length)} relatórios`,
        );
    });
  }, PARITY_TIMEOUT_MS);

  afterAll(cleanupTempDirs);

  it('FND-13 controle: o oxlint rodou a regra e reportou arquivos em algum glob', () => {
    expect(failures).toEqual([]);
    const reportedSomething = [...measured.values()].some(
      (files) => files.length > 0,
    );
    expect(reportedSomething).toBe(true);
    // O oxlint também deixa de reportar o que o glob não casa: o `?` não casa a `/`, então a/b.js fica de fora.
    // Os globs sem `/` ganham `**/` e alcançam também a pasta `q/` das amostras de escape: aqui só se olha a raiz.
    const atRoot = (files: string[]) =>
      measured.get(filesLabel(files))?.filter((file) => !file.startsWith('q/'));
    expect(atRoot(['a?b.js'])).toEqual([
      'a]b.js',
      'a^b.js',
      'axb.js',
      'ayb.js',
    ]);
    // O primeiro `]` da classe é membro: `a[]]b.js` casa só `a]b.js`, e a negada casa o resto (não o `a]b.js`).
    expect(atRoot(['a[]]b.js'])).toEqual(['a]b.js']);
    // A classe negada casa também a `/` (fast-glob 1.1.1), por isso o `a/b.js` entra.
    expect(atRoot(['a[!]]b.js'])).toEqual([
      'a/b.js',
      'a^b.js',
      'axb.js',
      'ayb.js',
    ]);
    // O `^` fora do início da classe é membro, e não negação.
    expect(atRoot(['a[x^]b.js'])).toEqual(['a^b.js', 'axb.js']);
    // A `\` escapa o caractere seguinte, dentro e fora da classe (medido): cada glob casa só o arquivo indicado, e a
    // `\` não é membro da classe (nenhuma amostra tem `\` no nome: o oxlint não casa um caminho com `\`).
    for (const [glob, expected] of ESCAPE_EXPECTED)
      expect({ glob, matched: measured.get(filesLabel([glob])) }).toEqual({
        glob,
        matched: expected,
      });
    // Um `!x.ts` dentro do conjunto não exclui o `x.ts`: sozinho ele é o nome literal `!x.ts` (só o `sub/!x.ts`), e o
    // conjunto reporta o `x.ts` pelo outro padrão, em qualquer ordem.
    expect(measured.get(filesLabel(['!x.ts']))).toEqual(['sub/!x.ts']);
    expect(measured.get(filesLabel(['**/*.ts', '!x.ts']))).toContain('x.ts');
    expect(measured.get(filesLabel(['!x.ts', '**/*.ts']))).toContain('x.ts');
    // O `!` sem `/` é literal, medido: `!*.ts` (`**/!*.ts`) não nega, só alcança o nome iniciado por `!`, e nenhum
    // dos outros .ts. Com esta amostra o "alcança .ts" do `!*.ts` deixa de ser só deduzido.
    expect(measured.get(filesLabel(['!*.ts']))).toEqual(['sub/!x.ts']);
  });

  it('FND-13 controle: o oxlint recusa a configuração com cada glob inválido, e uma falha inesperada reprova', () => {
    expect([...refused].sort()).toEqual(INVALID_GLOBS.map(filesLabel).sort());
    // Medido: o status é 1 (o mesmo dos achados do lint), então o que distingue a recusa é a mensagem.
    expect(
      INVALID_GLOBS.map(filesLabel).filter(
        (label) =>
          !/Failed to parse oxlint configuration file[\s\S]*Invalid glob pattern/.test(
            details.get(label) ?? '',
          ),
      ),
    ).toEqual([]);
  });

  it.each(
    INVALID_GLOBS.map((files): [string, string[]] => [
      filesLabel(files),
      files,
    ]),
  )(
    'FND-13 o oxlint recusa a configuração com o glob inválido, e o overrideFilesMatch lança: %s',
    (label, files) => {
      expect(refused.has(label)).toBe(true);
      expect(() => overrideFilesMatch(files, 'x.ts')).toThrow(
        /o oxlint recusa a configuração/,
      );
    },
  );

  it.each(
    OVERRIDE_FILES.map((files): [string, string[]] => [
      filesLabel(files),
      files,
    ]),
  )(
    'FND-13 o overrideFilesMatch casa as mesmas amostras que o oxlint: %s',
    (label, files) => {
      const expected = FILE_SAMPLES.filter((file) =>
        overrideFilesMatch(files, file),
      ).sort();
      expect(expected).toEqual(measured.get(label));
    },
  );
});
