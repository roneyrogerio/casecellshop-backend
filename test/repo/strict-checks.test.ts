import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/git-sandbox.ts';
import { normalizeOverrideGlob, overrideFilesMatch } from '../helpers/glob.ts';
import { typecheckSample } from '../helpers/lint-tree.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

interface TsConfig {
  compilerOptions: Record<string, unknown>;
}

interface OxlintConfig {
  rules: Record<string, unknown>;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8')) as T;
}

describe('AI-20 o tsconfig.json liga as opções estritas', () => {
  const options = readJson<TsConfig>('tsconfig.json').compilerOptions;

  it.each([
    'noImplicitReturns',
    'noImplicitOverride',
    'noFallthroughCasesInSwitch',
    'exactOptionalPropertyTypes',
  ])('AI-20 a opção %s está ligada no tsconfig.json', (option) => {
    expect(options[option]).toBe(true);
  });
});

describe('AI-20 o .oxlintrc.json liga como erro as regras de estilo', () => {
  const rules = readJson<OxlintConfig>('.oxlintrc.json').rules;

  it.each([
    'typescript/switch-exhaustiveness-check',
    'typescript/no-deprecated',
    'typescript/prefer-readonly',
    'typescript/consistent-type-definitions',
    'typescript/no-import-type-side-effects',
    'typescript/return-await',
    'unicorn/prefer-node-protocol',
    'unicorn/prefer-structured-clone',
    'unicorn/prefer-at',
    'eslint/no-var',
    'eslint/prefer-const',
  ])('AI-20 a regra %s está como "error" no .oxlintrc.json', (rule) => {
    expect(rules[rule]).toBe('error');
  });
});

// Um override do .oxlintrc.json cujo `files` alcança .ts não pode desligar as regras do AI-20: sem isto, uma pasta
// inteira escaparia do estilo, e o teste do `rules` do topo continuaria verde.
const STYLE_RULES = [
  'typescript/switch-exhaustiveness-check',
  'typescript/no-deprecated',
  'typescript/prefer-readonly',
  'typescript/consistent-type-definitions',
  'typescript/no-import-type-side-effects',
  'typescript/return-await',
  'unicorn/prefer-node-protocol',
  'unicorn/prefer-structured-clone',
  'unicorn/prefer-at',
  'eslint/no-var',
  'eslint/prefer-const',
];

// Os arquivos gerados pelo kysely-codegen (FND-09): o único lugar onde `consistent-type-definitions` pode ficar desligado,
// porque o gerador escreve `interface` e `type` do jeito dele.
const GENERATED_TYPE_FILES = [
  'src/db/types/store.ts',
  'src/db/types/erp-sim.ts',
];
const GENERATED_ONLY_RULES = ['typescript/consistent-type-definitions'];

// O único glob (já normalizado) que, além dos caminhos exatos de `GENERATED_TYPE_FILES`, vale como "só os gerados".
const GENERATED_TYPE_GLOB = 'src/db/types/*.ts';

// As formas de glob, já normalizadas pelo `GlobSet`, que casam todo .ts, de qualquer pasta e de qualquer nome
// (conferidas com o `overrideFilesMatch` sobre nomes de várias iniciais, pastas fundas e pastas com ponto: ver o teste
// da lista). Só há formas com `/`: sem `/`, o `GlobSet` põe `**/` na frente, e `!*.ts` vira `**/!*.ts`, em que o `!`
// deixa de ser negação. Lista fechada: uma forma que não cobre todo .ts não entra, e o glob negado com ela passa a
// valer como alcançando .ts.
const COVERS_ALL_TS = [
  '**/*.ts',
  '**/*.[jt]s',
  '**/*.[tj]s',
  '**/*.?s',
  '**/*.{js,ts}',
  '**/*.{ts,js}',
  '**/*',
  '**/**',
];

// Uma extensão literal é um ponto seguido só de letras e dígitos, sem `*`, `?`, `[`, `{` nem `!`.
const LITERAL_EXTENSION = /\.([A-Za-z0-9]+)$/;
const LITERAL_EXTENSION_GROUP = /\.\{([A-Za-z0-9]+(?:,[A-Za-z0-9]+)*)\}$/;

// Decide pelo glob já normalizado (`normalizeOverrideGlob`, o mesmo do `GlobSet`), sem amostra de caminho.
// 1. Número ímpar de `!` no início (o glob inteiro é negado, pasta e nome juntos): alcança .ts, a não ser que o corpo
//    positivo (sem os `!`) seja uma forma de `COVERS_ALL_TS`, e então o `!` exclui todo .ts. Um `!**/a*.[jt]s` exclui
//    os nomes "a…" e ainda alcança `src/http/server.ts`; `!src/*.[jt]s` é "tudo que não é src/<nome>.js|ts".
// 2. Número par (zero inclusive: o glob positivo; `!!x` volta ao positivo): alcança .ts, a não ser que o último trecho
//    termine numa extensão literal diferente de `ts` (`.js`, `.json`) ou num grupo `.{a,b,…}` só de extensões
//    literais diferentes de `ts`. Uma classe ou um `?` na extensão (`*.[jt]s`, `*.?s`) não é literal.
// 3. Qualquer outra forma alcança .ts. O lado é conservador: no pior caso dá falso vermelho, nunca falso verde.
// Sem `/`, o glob ganha `**/` na frente e o `!` do início vira literal: `!*.ts` é `**/!*.ts`, que casa `src/!x.ts`
// (um .ts) e só alcança nomes que começam por `!`.
function reachesTs(pattern: string): boolean {
  const glob = normalizeOverrideGlob(pattern);
  const bangs = /^!*/.exec(glob)?.[0].length ?? 0;
  const body = glob.slice(bangs);
  if (bangs % 2 === 1) return !COVERS_ALL_TS.includes(body);
  const lastSegment = body.slice(body.lastIndexOf('/') + 1);
  const extension = LITERAL_EXTENSION.exec(lastSegment)?.[1];
  if (extension !== undefined) return extension === 'ts';
  const group = LITERAL_EXTENSION_GROUP.exec(lastSegment)?.[1];
  if (group !== undefined) return group.split(',').includes('ts');
  return true;
}

function overrideReachesTs(files: readonly string[]): boolean {
  return files.some(reachesTs);
}

// A exceção vale só quando cada glob que alcança .ts é, depois da normalização, `src/db/types/*.ts` ou um caminho
// exato de `GENERATED_TYPE_FILES`. Lista fechada: nenhum outro glob prova que se limita aos gerados, nem o que casa
// só `store.ts` entre as amostras (`**/s*.ts`).
function onlyReachesGeneratedFiles(files: readonly string[]): boolean {
  return files
    .filter(reachesTs)
    .map(normalizeOverrideGlob)
    .every(
      (glob) =>
        glob === GENERATED_TYPE_GLOB || GENERATED_TYPE_FILES.includes(glob),
    );
}

function isOn(setting: unknown): boolean {
  const level = Array.isArray(setting) ? (setting as unknown[])[0] : setting;
  return level === 'error' || level === 2;
}

interface Override {
  files: string[];
  rules?: Record<string, unknown>;
}

// As violações, uma frase por override: desliga uma das onze regras para arquivos .ts que não são os gerados.
function styleOverrideViolations(overrides: readonly Override[]): string[] {
  const violations: string[] = [];
  for (const override of overrides) {
    if (!overrideReachesTs(override.files)) continue;
    const disabled = STYLE_RULES.filter(
      (rule) =>
        override.rules !== undefined &&
        rule in override.rules &&
        !isOn(override.rules[rule]),
    );
    if (disabled.length === 0) continue;
    const onlyGenerated = onlyReachesGeneratedFiles(override.files);
    const onlyAllowedRules = disabled.every((rule) =>
      GENERATED_ONLY_RULES.includes(rule),
    );
    if (onlyGenerated && onlyAllowedRules) continue;
    violations.push(
      `${override.files.join(', ')} desliga ${disabled.join(', ')}`,
    );
  }
  return violations;
}

describe('AI-20 os overrides do .oxlintrc.json que alcançam .ts não desligam as regras de estilo', () => {
  const { overrides = [] } = readJson<
    OxlintConfig & { overrides?: Override[] }
  >('.oxlintrc.json');

  it('AI-20 nenhum override para .ts desliga uma das onze regras, salvo consistent-type-definitions nos tipos gerados', () => {
    expect(styleOverrideViolations(overrides)).toEqual([]);
  });

  it('AI-20 os dois overrides conhecidos para .ts existem e só desligam o que o critério aceita', () => {
    const tsOverrides = overrides.filter((override) =>
      overrideReachesTs(override.files),
    );
    const disabledBy = (files: string): string[] =>
      Object.entries(
        tsOverrides.find((override) => override.files.includes(files))?.rules ??
          {},
      )
        .filter(([, setting]) => !isOn(setting))
        .map(([rule]) => rule)
        .sort();

    expect(disabledBy('**/migrations/**/*.ts')).toEqual([
      'typescript/no-explicit-any',
    ]);
    expect(disabledBy('src/db/types/*.ts')).toEqual([
      'typescript/consistent-type-definitions',
      'typescript/no-empty-object-type',
    ]);
  });

  // Controles negativos: a conferência enxerga o override que a deixaria passar.
  it.each(STYLE_RULES)(
    'AI-20 controle: um override de **/*.ts que desliga %s reprova',
    (rule) => {
      expect(
        styleOverrideViolations([
          { files: ['**/*.ts'], rules: { [rule]: 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['uma pasta', ['src/**/*.ts']],
    ['só os testes', ['**/*.test.ts']],
    ['o glob *.ts', ['*.ts']],
    ['todos os arquivos', ['**/*']],
    ['as chaves {ts,js}', ['**/*.{ts,js}']],
    ['uma pasta de scripts', ['scripts/*.ts']],
  ])(
    'AI-20 controle: um override para %s que desliga return-await reprova',
    (_label, files) => {
      expect(
        styleOverrideViolations([
          { files, rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  // Pastas que nenhum caminho de amostra cita: o glob alcança .ts pelo fim dele, e não por casar uma amostra.
  it.each(STYLE_RULES)(
    'AI-20 controle: um override de src/http/**/*.ts que desliga %s reprova',
    (rule) => {
      expect(
        styleOverrideViolations([
          { files: ['src/http/**/*.ts'], rules: { [rule]: 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['uma pasta fora das amostras, com **', ['src/http/**/*.ts']],
    ['uma pasta fora das amostras, com *', ['src/http/*.ts']],
    ['um arquivo fora das amostras', ['src/http/routes.ts']],
    ['uma pasta e tudo dentro dela', ['src/http/**']],
    ['uma pasta e os arquivos dela, com *', ['src/http/*']],
    ['o grupo {js,ts}', ['src/http/**/*.{js,ts}']],
    ['o grupo {ts,tsx}', ['src/http/**/*.{ts,tsx}']],
    ['a classe [jt] (A6 do #12)', ['src/http/**/*.[jt]s']],
    ['a classe [jt] na raiz', ['**/*.[jt]s']],
    ['o coringa ?s (A6 do #12)', ['src/http/*.?s']],
    ['o coringa ?s com **', ['**/*.?s']],
    // O `!` do glob inteiro nega pasta e nome juntos (A1 do #35): `!src/*.[jt]s` casa todo arquivo que não é
    // `src/<nome>.js|ts`, então alcança .ts fora de `src/`.
    ['a classe [jt] negada, com pasta', ['!src/*.[jt]s']],
    ['o coringa ?s e a classe [a-z] negados, com pasta', ['!src/[a-z]*.?s']],
    ['o coringa ?s negado, com pasta e **', ['!src/**/*.?s']],
    [
      'a classe [jt] negada, com pasta, entre dois globs',
      ['x.js', '!lib/*.[jt]s'],
    ],
    ['dois negados, que voltam ao positivo', ['!!src/*.[jt]s']],
    // A4 da Revisão 2 do #35: o `!` exclui um nome que nenhuma amostra tem (`arquivo.ts`), mas ainda alcança
    // `src/http/server.ts`. A decisão não pode depender de a amostra casar com o glob negado.
    ['a classe [jt] negada, com nome que exclui só os "a…"', ['!**/a*.[jt]s']],
    [
      'o coringa ?s negado, com nome que exclui só "a" a "m"',
      ['!**/[a-m]*.?s'],
    ],
    ['um nome inteiro negado', ['!**/server.ts']],
    ['três negados, que valem um', ['!!!**/a*.[jt]s']],
  ])(
    'AI-20 controle: um override para %s que desliga return-await reprova',
    (_label, files) => {
      expect(
        styleOverrideViolations([
          { files, rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  it('AI-20 controle: consistent-type-definitions desligada numa pasta fora das amostras reprova, porque ela não se limita aos tipos gerados', () => {
    const off = { 'typescript/consistent-type-definitions': 'off' };

    expect(
      styleOverrideViolations([{ files: ['src/http/**/*.ts'], rules: off }]),
    ).toHaveLength(1);
    expect(
      styleOverrideViolations([
        { files: ['src/db/types/*.ts', 'src/http/**/*.ts'], rules: off },
      ]),
    ).toHaveLength(1);
  });

  it.each([
    ['só os .js', ['src/http/**/*.js']],
    ['os .js, .mjs e .cjs', ['src/http/**/*.{js,mjs,cjs}']],
    ['só os .md', ['docs/**/*.md']],
    ['os .json', ['src/http/*.json']],
    // O `!` com `**/` na frente nega todo .ts, de qualquer pasta: o override só alcança o que não é .ts.
    ['a classe [jt] negada em qualquer pasta', ['!**/*.[jt]s']],
    ['o coringa ?s negado em qualquer pasta', ['!**/*.?s']],
  ])(
    'AI-20 controle: um override para %s, que não alcança .ts, pode desligar return-await',
    (_label, files) => {
      expect(
        styleOverrideViolations([
          { files, rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toEqual([]);
    },
  );

  // Lado conservador da regra (Revisão 3 do #35): uma extensão com classe ou `?` não é literal, então a regra não a
  // prova diferente de ts e o glob vale como alcançando .ts, mesmo quando na prática só casaria `.js` ou `.mjs`. O pior
  // caso é um falso vermelho, nunca um falso verde. Antes da Revisão 3 estes dois globs não alcançavam .ts.
  it.each([
    ['a classe [jm]s, que na prática não casa .ts', ['src/http/**/*.[jm]s']],
    ['o coringa ?js, que na prática não casa .ts', ['src/http/*.?js']],
  ])(
    'AI-20 controle: um override para %s vale como alcançando .ts, então desligar return-await reprova',
    (_label, files) => {
      expect(
        styleOverrideViolations([
          { files, rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  // A6 da Revisão 3 do #35: o glob positivo cujo último trecho tem classe ou `?` e não casa o nome de amostra
  // `arquivo.ts` ainda casa `src/http/server.ts`. A decisão não pode depender de nome de amostra.
  it.each([['src/http/server.[jt]s'], ['src/http/server.?s'], ['**/s*.[jt]s']])(
    'AI-20 controle: o glob %s alcança .ts, então desligar qualquer das onze regras reprova (A6)',
    (glob) => {
      expect(overrideFilesMatch([glob], 'src/http/server.ts')).toBe(true);
      for (const rule of STYLE_RULES) {
        expect(
          styleOverrideViolations([
            { files: [glob], rules: { [rule]: 'off' } },
          ]),
        ).toHaveLength(1);
      }
    },
  );

  // A7 da Revisão 3 do #35: estes globs casam, entre os gerados, só `src/db/types/store.ts`, mas também casam
  // `src/http/server.ts`. A exceção do `consistent-type-definitions` é uma lista fechada, sem amostra.
  it.each([['**/s*.ts'], ['**/{store,server}.ts'], ['!**/[!s]*.ts']])(
    'AI-20 controle: o glob %s não vale como "só os tipos gerados", então desligar consistent-type-definitions reprova (A7)',
    (glob) => {
      expect(overrideFilesMatch([glob], 'src/http/server.ts')).toBe(true);
      expect(
        styleOverrideViolations([
          {
            files: [glob],
            rules: { 'typescript/consistent-type-definitions': 'off' },
          },
        ]),
      ).toHaveLength(1);
    },
  );

  // A8 da Revisão 3 do #35: sem `/`, o `GlobSet` põe `**/` na frente e o `!` vira literal. O glob `**/!*.ts` casa
  // `src/!x.ts`, que é um `.ts`, e só alcança nomes que começam por `!`.
  it.each([['!*.ts'], ['!*.?s'], ['!*.[jt]s'], ['!*'], ['!**']])(
    'AI-20 controle: o glob %s, sem "/", tem o ! literal e alcança .ts por casar nomes iniciados por !, então desligar return-await reprova (A8)',
    (glob) => {
      expect(overrideFilesMatch([glob], 'src/!x.ts')).toBe(true);
      expect(overrideFilesMatch([glob], 'src/x.ts')).toBe(false);
      expect(
        styleOverrideViolations([
          { files: [glob], rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  // Extensão literal (um ponto seguido só de letras e dígitos) diferente de `ts` no fim do glob: não alcança .ts.
  it.each([['**/*.js'], ['**/*.{js,mjs}'], ['**/*.json']])(
    'AI-20 controle: o glob %s termina em extensão literal que não é ts, então não alcança .ts',
    (glob) => {
      expect(
        styleOverrideViolations([
          { files: [glob], rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toEqual([]);
    },
  );

  it.each([['**/*.{js,ts}'], ['**/*.t?'], ['**/x'], ['**/*.d.ts']])(
    'AI-20 controle: o glob %s alcança .ts, então desligar return-await reprova',
    (glob) => {
      expect(
        styleOverrideViolations([
          { files: [glob], rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  // A lista fechada de formas que cobrem todo .ts: cada uma casa, pelo `overrideFilesMatch`, .ts de várias iniciais,
  // pastas fundas e pasta com ponto. Uma forma que falhar aqui sai da lista.
  const TS_VARIED_PATHS = [
    'a.ts',
    'zebra.ts',
    'Z.ts',
    '1.ts',
    '_x.ts',
    'a-b.c.ts',
    '.hidden.ts',
    'x.test.ts',
    'x.d.ts',
    'src/app.ts',
    'src/http/server.ts',
    'a/b/c/d/e/f.ts',
    '.claude/hooks/x.ts',
    'a.b/c.d/e.ts',
    '.git/x.ts',
    'node_modules/p/i.ts',
    'migrations/store/20260101000000_x.ts',
    'src/!x.ts',
    'a b/c d.ts',
    'a.js.ts',
  ];

  it.each(COVERS_ALL_TS)(
    'AI-20 controle: a forma %s casa todo .ts, então a lista fechada pode tê-la',
    (form) => {
      expect(
        TS_VARIED_PATHS.filter((path) => !overrideFilesMatch([form], path)),
      ).toEqual([]);
    },
  );

  it.each(COVERS_ALL_TS)(
    'AI-20 controle: a forma %s já está normalizada (tem "/"), então o GlobSet não muda o glob',
    (form) => {
      expect(normalizeOverrideGlob(form)).toBe(form);
    },
  );

  // Sem `/`, o `GlobSet` põe `**/` na frente: o `!` deixa de ser o início do glob e vira literal.
  it.each([
    ['*.ts', '**/*.ts'],
    ['!*.ts', '**/!*.ts'],
    ['!*', '**/!*'],
    ['./x.ts', 'x.ts'],
    ['!src/*.ts', '!src/*.ts'],
  ])(
    'AI-20 a normalização do glob %s é %s, como a do GlobSet do oxlint',
    (pattern, normalized) => {
      expect(normalizeOverrideGlob(pattern)).toBe(normalized);
    },
  );

  // Sem `/` não há forma na lista fechada: `*.ts` e o resto alcançam .ts quando positivos, e o `!` na frente é literal.
  it.each([['*.ts'], ['*.?s'], ['*.[jt]s'], ['*'], ['**']])(
    'AI-20 controle: o glob %s, sem "/", alcança .ts, com um, dois ou três ! na frente',
    (form) => {
      const off = { 'typescript/return-await': 'off' };

      for (const glob of [form, `!${form}`, `!!${form}`, `!!!${form}`]) {
        expect(
          styleOverrideViolations([{ files: [glob], rules: off }]),
        ).toHaveLength(1);
      }
    },
  );

  // O oráculo da decisão negativa: um glob que a regra diz não alcançar .ts não pode casar nenhum caminho .ts, pelo
  // `overrideFilesMatch`. Uma regra que erra para o lado do falso verde reprova aqui.
  it.each([
    ['**/*.js'],
    ['**/*.mjs'],
    ['**/*.cjs'],
    ['**/*.json'],
    ['**/*.md'],
    ['**/*.{js,mjs}'],
    ['src/http/**/*.{js,mjs,cjs}'],
    ['docs/**/*.md'],
    ['!**/*.[jt]s'],
    ['!**/*.?s'],
    ['!**/*.ts'],
    ['**/!x.js'],
    ['!x.js'],
  ])(
    'AI-20 controle: o glob %s, que a regra diz não alcançar .ts, não casa nenhum caminho .ts',
    (glob) => {
      expect(reachesTs(glob)).toBe(false);
      expect(
        TS_VARIED_PATHS.filter((path) => overrideFilesMatch([glob], path)),
      ).toEqual([]);
    },
  );

  it.each(COVERS_ALL_TS)(
    'AI-20 controle: um override de !%s, que exclui todo .ts, pode desligar return-await; sem o ! reprova',
    (form) => {
      const off = { 'typescript/return-await': 'off' };

      expect(
        styleOverrideViolations([{ files: [`!${form}`], rules: off }]),
      ).toEqual([]);
      expect(
        styleOverrideViolations([{ files: [form], rules: off }]),
      ).toHaveLength(1);
      // Número par de `!` volta ao positivo.
      expect(
        styleOverrideViolations([{ files: [`!!${form}`], rules: off }]),
      ).toHaveLength(1);
    },
  );

  it.each([
    ['só os .js negados', ['!**/*.js']],
    ['só os .md negados', ['!**/*.md']],
    ['as chaves {js,mjs} negadas', ['!**/*.{js,mjs}']],
    ['a classe [jm]s negada', ['!**/*.[jm]s']],
    ['uma pasta negada com **', ['!src/**']],
    ['os .test.ts negados', ['!**/*.test.ts']],
  ])(
    'AI-20 controle: um override para %s ainda alcança .ts, então desligar return-await reprova',
    (_label, files) => {
      expect(
        styleOverrideViolations([
          { files, rules: { 'typescript/return-await': 'off' } },
        ]),
      ).toHaveLength(1);
    },
  );

  it('AI-20 controle: consistent-type-definitions desligada fora dos arquivos gerados reprova', () => {
    const off = { 'typescript/consistent-type-definitions': 'off' };

    expect(
      styleOverrideViolations([{ files: ['src/db/types/*.ts'], rules: off }]),
    ).toEqual([]);
    expect(
      styleOverrideViolations([{ files: ['src/db/*.ts'], rules: off }]),
    ).toHaveLength(1);
    expect(
      styleOverrideViolations([{ files: ['src/**/*.ts'], rules: off }]),
    ).toHaveLength(1);
    expect(
      styleOverrideViolations([
        { files: ['src/db/types/*.ts', 'src/app.ts'], rules: off },
      ]),
    ).toHaveLength(1);
  });

  it('AI-20 controle: a exceção do consistent-type-definitions é uma lista fechada: src/db/types/*.ts, normalizado, ou um caminho gerado exato', () => {
    const off = { 'typescript/consistent-type-definitions': 'off' };
    const accepted = [
      ['src/db/types/*.ts'],
      ['./src/db/types/*.ts'],
      ['src/db/types/store.ts'],
      ['src/db/types/store.ts', 'src/db/types/erp-sim.ts'],
      ['src/db/types/*.ts', 'src/db/types/erp-sim.ts'],
      // Um glob que não alcança .ts não conta na lista.
      ['src/db/types/*.ts', '**/*.js'],
    ];
    const refused = [
      ['src/db/types/*.[jt]s'],
      ['src/db/types/s*.ts'],
      ['src/db/types/{store,server}.ts'],
      ['src/db/types/**'],
      ['src/db/types/*'],
      ['src/db/types/**/*.ts'],
      ['**/types/*.ts'],
      ['src/db/types/store.ts', 'src/http/server.ts'],
      ['src/db/types/*.ts', 'src/db/types/x.ts'],
      ['!src/http/*.ts'],
    ];

    for (const files of accepted)
      expect(styleOverrideViolations([{ files, rules: off }])).toEqual([]);
    for (const files of refused)
      expect(styleOverrideViolations([{ files, rules: off }])).toHaveLength(1);
  });

  it('AI-20 controle: os tipos gerados não podem desligar nenhuma outra das onze regras', () => {
    const files = ['src/db/types/*.ts'];

    expect(
      styleOverrideViolations([
        { files, rules: { 'typescript/return-await': 'off' } },
      ]),
    ).toHaveLength(1);
    expect(
      styleOverrideViolations([
        {
          files,
          rules: {
            'typescript/consistent-type-definitions': 'off',
            'eslint/prefer-const': 'off',
          },
        },
      ]),
    ).toHaveLength(1);
  });

  it.each([['warn'], [0], [['off']], [['warn', {}]]])(
    'AI-20 controle: baixar a regra para %j também reprova',
    (setting) => {
      expect(
        styleOverrideViolations([
          { files: ['**/*.ts'], rules: { 'eslint/no-var': setting } },
        ]),
      ).toHaveLength(1);
    },
  );

  it('AI-20 controle: o que o critério aceita passa', () => {
    expect(
      styleOverrideViolations([
        {
          files: ['**/migrations/**/*.ts'],
          rules: { 'typescript/no-explicit-any': 'off' },
        },
        {
          files: ['src/db/types/*.ts'],
          rules: {
            'typescript/consistent-type-definitions': 'off',
            'typescript/no-empty-object-type': 'off',
          },
        },
        {
          files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
          rules: {
            'typescript/return-await': 'off',
            'eslint/prefer-const': 'off',
          },
        },
        { files: ['**/*.ts'], rules: { 'eslint/no-var': 'error' } },
        { files: ['**/*.ts'], rules: { 'typescript/no-explicit-any': 'off' } },
      ]),
    ).toEqual([]);
  });
});

// Pasta no tmpdir do sistema, e não no repositório (mesma razão do test-layout): um lint paralelo
// ou uma execução interrompida esbarraria no arquivo de amostra.
describe('AI-20 controle negativo do lint: switch sem todos os casos da união reprova', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'ai20-lint-'));
    // As regras com tipos resolvem os módulos a partir da pasta da amostra.
    symlinkSync(
      path.join(root, 'node_modules'),
      path.join(tree, 'node_modules'),
      'dir',
    );
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function lint(source: string): { status: number | null; output: string } {
    const file = path.join(tree, 'amostra.ts');
    writeFileSync(file, source);
    const result = runCommand(
      path.join(root, 'node_modules', '.bin', 'oxlint'),
      ['-c', path.join(root, '.oxlintrc.json'), file],
      { cwd: root },
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  const header = `type Cor = 'a' | 'b';\n\nexport function nome(cor: Cor): string {\n  switch (cor) {\n    case 'a':\n      return 'A';\n`;

  it('AI-20 um switch que trata só "a" da união "a" | "b" reprova com switch-exhaustiveness-check', () => {
    const result = lint(`${header}  }\n  return '';\n}\n`);

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).toContain('switch-exhaustiveness-check');
  }, 60_000);

  it('AI-20 o mesmo arquivo tratando "a" e "b" passa no lint', () => {
    const result = lint(
      `${header}    case 'b':\n      return 'B';\n  }\n  return '';\n}\n`,
    );

    expect(result.output).not.toContain('switch-exhaustiveness-check');
    expect(result.status).toBe(0);
  }, 60_000);
});

describe('AI-20 controle negativo do typecheck: undefined explícito em propriedade opcional reprova', () => {
  afterEach(cleanupTempDirs);

  function typecheck(source: string): {
    status: number | null;
    output: string;
  } {
    return typecheckSample('ai20-tsc-', source);
  }

  it('AI-20 propriedade opcional recebendo undefined explícito reprova no tsc com exactOptionalPropertyTypes', () => {
    const result = typecheck(
      `type A = { x?: number };\nexport const a: A = { x: undefined };\n`,
    );

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exactOptionalPropertyTypes');
  }, 60_000);

  it('AI-20 o mesmo arquivo sem o undefined explícito passa no tsc', () => {
    const result = typecheck(
      `type A = { x?: number };\nexport const a: A = {};\n`,
    );

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
