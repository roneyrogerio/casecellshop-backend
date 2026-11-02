import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { globMatch, invalidGlobReason, overrideFilesMatch } from './glob.ts';
import { cleanupTempDirs, makeTempDir, writeFileIn } from './git-sandbox.ts';
import { PARITY_TIMEOUT_MS, runOxlint, singleRuleConfig } from './lint-tree.ts';
import { propertyTimeoutMs, readPropertyConfig } from './property-setup.ts';

// FND-13 e FND-14: a conferência do lint lida como dado (`files` dos overrides do .oxlintrc.json) decide pelo
// `globMatch` (o porte do `glob_match` do fast-glob 1.1.1); se ele casa errado, a conferência libera ou reprova o
// arquivo errado sem avisar. A
// comparação diferencial por propriedade, no fim do arquivo, usa a semente e o número de casos globais do fast-check.

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

// A classe negada (`[!x]`, `[^x]`) casa qualquer byte fora dela. Estes casos deixam a classe dentro de um trecho do
// caminho, onde o resultado é o óbvio. Diante de uma `/` o oxlint casa mais do que se espera: no fast-glob 1.1.1 que ele
// traz, `[!x]` e `[^x]` casam também a `/` (a paridade com o oxlint real está em "FND-13 paridade dos files dos
// overrides com o oxlint").
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
// classe fecha no `]` seguinte. Os membros `]` e `^` (este fora do início) contam como qualquer outro membro: `[]]` casa
// o `]` (e não é uma classe vazia seguida de `]`, como seria em JavaScript), e `[x^]` casa o `^`.
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

// Intervalo invertido (`z-a`): vazio, então a classe não casa nada, e a negada casa qualquer caractere (medido na
// paridade, que também mede a `}` solta e a `}` dentro de uma classe entre chaves). O oxlint aceita o glob.
const EMPTY_RANGES: GlobCase[] = [
  {
    glob: 'q/a[z-a]b.js',
    matches: [],
    rejects: ['q/azb.js', 'q/aab.js', 'q/amb.js', 'q/a-b.js'],
  },
  {
    glob: 'q/a[m-a]b.js',
    matches: [],
    rejects: ['q/azb.js', 'q/aab.js', 'q/amb.js'],
  },
  {
    glob: 'q/a[!z-a]b.js',
    matches: ['q/azb.js', 'q/aab.js', 'q/amb.js', 'q/a/b.js'],
    rejects: ['q/ab.js'],
  },
  // O intervalo vazio some, e o resto da classe segue valendo; o intervalo certo (`a-a`, uma letra só) não some.
  {
    glob: 'q/a[xz-a]b.js',
    matches: ['q/axb.js'],
    rejects: ['q/azb.js', 'q/aab.js'],
  },
  {
    glob: 'q/a[z-ax]b.js',
    matches: ['q/axb.js'],
    rejects: ['q/azb.js', 'q/aab.js'],
  },
  {
    glob: 'q/a[!xz-a]b.js',
    matches: ['q/azb.js', 'q/aab.js'],
    rejects: ['q/axb.js'],
  },
  {
    glob: 'q/a[a-a]b.js',
    matches: ['q/aab.js'],
    rejects: ['q/abb.js', 'q/azb.js'],
  },
  // Os extremos escapados contam pelo caractere que a `\` produz: `\n` (LF, 10) vem antes do `a`, então `[a-\n]` é
  // invertido, e `[\n-a]` não.
  {
    glob: 'q/a[a-\\n]b.js',
    matches: [],
    rejects: ['q/aab.js', 'q/anb.js'],
  },
  {
    glob: 'q/a[\\n-a]b.js',
    matches: ['q/aab.js', 'q/a\nb.js'],
    rejects: ['q/anb.js'],
  },
];

// A `}` sem `{` aberta é literal; dentro de uma classe que está dentro de chaves, a `}` não fecha as chaves (medido).
const LOOSE_BRACES: GlobCase[] = [
  {
    glob: 'q/a}b.js',
    matches: ['q/a}b.js'],
    rejects: ['q/ab.js', 'q/}b.js'],
  },
  {
    glob: 'q/{a,[}]}b.js',
    matches: ['q/ab.js', 'q/}b.js'],
    rejects: ['q/a}b.js', 'q/b.js'],
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

// O `**` só casa pastas quando é o trecho inteiro (A13/A14 da Revisão 6, divergência 1 do script diferencial): no começo
// do glob, depois de `/`, depois de `{` ou de `,` em chaves, e antes de `/` ou do fim do glob. Em qualquer outro lugar
// (`q/**.js`, `q/**b.js`, `q/a**b.js`, `q/a**`, `***`) vale como um `*` (medido no oxlint 1.90.0, ver as amostras em
// `FILE_SAMPLES` e a paridade abaixo). Um `**` seguido de `/**` que é o trecho inteiro junta-se num só.
const STAR_RUNS: GlobCase[] = [
  {
    glob: 'q/**.js',
    matches: ['q/a.js', 'q/ab.js'],
    rejects: ['q/r/ab.js', 'q/r/s/ab.js'],
  },
  {
    glob: 'q/**b.js',
    matches: ['q/ab.js', 'q/a-b.js', 'q/a]b.js', 'q/b.js'],
    rejects: ['q/r/ab.js', 'q/a/b.js'],
  },
  {
    glob: 'q/a**b.js',
    matches: ['q/ab.js', 'q/a-b.js'],
    rejects: ['q/a/b.js'],
  },
  {
    glob: 'q/a**',
    matches: ['q/a.js', 'q/ab.js'],
    rejects: ['q/a/b.js'],
  },
  {
    glob: 'q/**',
    matches: ['q/a.js', 'q/r/ab.js', 'q/r/s/ab.js'],
    rejects: ['r/a.js'],
  },
  {
    glob: 'q/***/b.js',
    matches: ['q/r/b.js'],
    rejects: ['q/r/s/b.js', 'q/b.js'],
  },
  {
    glob: 'q/**/b.js',
    matches: ['q/b.js', 'q/r/b.js', 'q/r/s/b.js'],
    rejects: ['q/r/ab.js'],
  },
  {
    glob: 'q/{**/b.js,a.js}',
    matches: ['q/b.js', 'q/r/s/b.js', 'q/a.js'],
    rejects: ['q/r/ab.js'],
  },
  {
    glob: 'q/{a,**}/b.js',
    matches: ['q/a/b.js', 'q/r/b.js'],
    rejects: ['q/r/s/b.js', 'q/b.js'],
  },
  {
    glob: 'q/{**}/b.js',
    matches: ['q/r/b.js'],
    rejects: ['q/r/s/b.js'],
  },
  // A chave escapada não abre trecho, e a barra escapada abre.
  {
    glob: 'q/\\{**/b.js',
    matches: ['q/{a/b.js'],
    rejects: ['q/{a/s/b.js'],
  },
  {
    glob: 'q/a\\/**/b.js',
    matches: ['q/a/b.js', 'q/a/s/b.js'],
    rejects: ['q/ab.js'],
  },
  // `**/**` é o trecho inteiro mesmo depois de outro caractere; `/**` que continua num nome não junta.
  {
    glob: 'q/x**/**',
    matches: ['q/xb.js', 'q/xy.js', 'q/x/y.js'],
    rejects: ['q/ab.js'],
  },
  {
    glob: 'q/x**/**/y.js',
    matches: ['q/xy.js', 'q/x/y.js'],
    rejects: ['q/xb.js'],
  },
  {
    glob: 'q/x**/**.js',
    matches: ['q/x/y.js'],
    rejects: ['q/xb.js', 'q/xy.js'],
  },
];

// Intervalo invertido seguido de `-` (A13 da Revisão 6, divergência 2): o `-` só forma intervalo logo depois de um
// membro, então o `-` que sobra quando o intervalo vazio some é um membro, e não o começo de um intervalo novo.
const DASH_AFTER_EMPTY_RANGE: GlobCase[] = [
  {
    glob: 'q/a[az-a-c]b.js',
    matches: ['q/aab.js', 'q/a-b.js', 'q/acb.js'],
    rejects: ['q/abb.js', 'q/azb.js'],
  },
  {
    glob: 'q/a[xz-a-c]b.js',
    matches: ['q/axb.js', 'q/a-b.js', 'q/acb.js'],
    rejects: ['q/abb.js', 'q/aab.js', 'q/azb.js'],
  },
  // O caso do script: o `{-a-a` fica `{-a` (vazio), o `-` é membro e o `a-a` é uma letra.
  {
    glob: 'q/**/[^[x][!b-bx][\\!{-a-a].js',
    matches: ['q/r/aa-.js', 'q/r/aa!.js'],
    rejects: ['q/r/aa,.js', 'q/r/aab.js', 'q/r/xab.js'],
  },
];

// Chaves vazias e `!` dentro de chaves: `{}`, `{a,}` e `{,a}` têm uma alternativa vazia, o `!`
// dentro de chaves é literal, e a `}` solta de um grupo só (ou de grupos aninhados) é literal.
const EMPTY_AND_LOOSE_BRACES: GlobCase[] = [
  {
    glob: 'q/a{}b.js',
    matches: ['q/ab.js'],
    rejects: ['q/a.js', 'q/b.js'],
  },
  {
    glob: 'q/{a,}b.js',
    matches: ['q/ab.js', 'q/b.js'],
    rejects: ['q/a.js'],
  },
  {
    glob: 'q/{,a}b.js',
    matches: ['q/ab.js', 'q/b.js'],
    rejects: ['q/a.js'],
  },
  {
    glob: 'q/a{b,}.js',
    matches: ['q/a.js', 'q/ab.js'],
    rejects: ['q/b.js'],
  },
  {
    glob: 'q/{a,{b,}}.js',
    matches: ['q/a.js', 'q/b.js'],
    rejects: ['q/ab.js'],
  },
  {
    glob: 'q/{!a,b}.js',
    matches: ['q/!a.js', 'q/b.js'],
    rejects: ['q/a.js'],
  },
  {
    glob: 'q/a{!,b}.js',
    matches: ['q/a!.js', 'q/ab.js'],
    rejects: ['q/a.js'],
  },
  {
    glob: 'q/a{b}}.js',
    matches: ['q/ab}.js'],
    rejects: ['q/ab.js'],
  },
  {
    glob: 'q/{a}}{b}.js',
    matches: ['q/a}b.js'],
    rejects: ['q/ab.js'],
  },
];

// Os globs em que o oxlint casa de um jeito que uma expressão regular não reproduz (a pilha de chaves, o `*` único que
// guarda só o último ponto de retorno, o salto de volta ao `**`). O porte do `glob_match` os acompanha porque tem a
// mesma estrutura do Rust. O oráculo é o que o oxlint casa (`matches`) e o que ele não casa (`rejects`), medido na
// paridade abaixo; o que a regex de antes diria vai no comentário de cada caso.
const OXLINT_QUIRKS: GlobCase[] = [
  // O `}` sobrante some depois do segundo grupo; a regex de antes pediria o `}` no nome (`q/ab}.js`).
  { glob: 'q/{a}{b}}.js', matches: ['q/ab.js'], rejects: ['q/ab}.js'] },
  // A `,` solta vira separador de alternativas depois do segundo grupo: não casa nada, nem `q/ab,c.js`.
  { glob: 'q/{a}{b},c.js', matches: [], rejects: ['q/ab,c.js'] },
  // O que sobra depende do caminho: a pasta `a` faz o primeiro grupo casar e o segundo falhar, e o `}` volta a ser
  // literal. A regex de antes casaria `q/a/ab.js` e não `q/a/ab}.js`.
  {
    glob: '**/{a}{b}}.js',
    matches: ['ab.js', 'q/ab.js', 'q/b/ab.js', 'q/a/ab}.js'],
    rejects: ['ab}.js', 'q/ab}.js', 'q/a/ab.js'],
  },
  // As duas divergências de chaves do script diferencial (sementes 7, 23, 42 e 101).
  {
    glob: '**/a{}*{?,!![\\acc]}}.js',
    matches: ['ab.js', 'a}.js'],
    rejects: ['ab}.js'],
  },
  {
    glob: 'a/{a,{^a,a.\\{},\\{[x-x]^}{{[^c\\^]?,a,}!\\?,[{\\]],*[a-bb\\[\\^]{!a},[!]-],?}}c.js',
    matches: ['a/abc.js'],
    rejects: [],
  },
  // O oxlint guarda só o último `*` para voltar atrás: o segundo `*`, que para na `/`, apaga o primeiro. A regex
  // de antes casaria `q/a/b.js` (`*` = `a`, a classe negada = `/`, `*` vazio); o oxlint casa só `q/ab.js`.
  { glob: 'q/*[^c]*b.js', matches: ['q/ab.js'], rejects: ['q/a/b.js'] },
  // O gap do helper de antes, por regex: um `?` antes de `**/` e um grupo depois. O oxlint casa `b/xa.js` (o `**` que
  // não é trecho inteiro e o salto de volta ao `**` do começo); a regex de antes não casaria.
  {
    glob: '**/?**/{a}.js',
    matches: ['b/a.js', 'b/xa.js', 'ba/a.js'],
    rejects: ['a.js'],
  },
  // O `**` no começo de uma alternativa de um grupo que abre no meio de um trecho: `ax.js` casa e `a/ax.js` não (a regex
  // de antes casaria os dois).
  {
    glob: '**/a{**/x}.js',
    matches: ['ax.js', 'a/x.js'],
    rejects: ['a/ax.js'],
  },
];

// Os vizinhos que a regex de antes também acertava: `}` solta com um grupo só, grupos em sequência sem `}` ou `,` soltos
// depois, e a classe que casa a `/` com um `*` só.
const OXLINT_NEIGHBOURS = [
  'q/a{b}}.js',
  'q/{a}}{b}.js',
  'q/{a}{b}.js',
  'q/{a,b}/{c,d}/*.ts',
  'q/{a{b}}}.js',
  'q/*[^c]b.js',
  'q/[^c]*b.js',
];

function expectCase({ glob, matches, rejects }: GlobCase) {
  expect({
    glob,
    matched: matches.filter((sample) => globMatch(glob, sample)),
    rejected: rejects.filter((sample) => !globMatch(glob, sample)),
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
  // Chaves aninhadas além do limite de 10 do `validate` (`MAX_BRACE_NESTING`): 11 abertas ao mesmo tempo.
  ['{{{{{{{{{{{a}}}}}}}}}}}.js'],
];

describe('FND-13 globMatch', () => {
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
  ])('FND-13 o glob com chaves e classes fechadas é válido: %s', (glob) => {
    expect(invalidGlobReason(glob)).toBeUndefined();
  });

  it.each([
    ['**/{*.ts,*.js', 'chave aberta'],
    ['**/[ab.ts', 'classe de caracteres aberta'],
    ['a\\', 'barra invertida no fim'],
    ['{{{{{{{{{{{a}}}}}}}}}}}.js', 'chaves aninhadas demais'],
    // Os `!` do início não fazem parte do padrão, e a `}` solta não fecha nada.
    ['!!**/{*.ts', 'chave aberta'],
  ])(
    'FND-13 invalidGlobReason diz o motivo do glob recusado: %s',
    (glob, reason) => {
      expect(invalidGlobReason(glob)).toContain(reason);
    },
  );

  it('FND-13 dez chaves aninhadas são válidas e onze são recusadas (o limite do validate)', () => {
    const nested = (depth: number) =>
      `${'{'.repeat(depth)}a${'}'.repeat(depth)}`;
    expect(invalidGlobReason(nested(10))).toBeUndefined();
    expect(invalidGlobReason(nested(11))).toContain('chaves aninhadas demais');
    // Um glob inválido nunca casa, nem negado (o `!` não o torna válido).
    expect(globMatch(nested(11), 'a')).toBe(false);
    expect(globMatch(`!${nested(11)}`, 'b')).toBe(false);
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

  it.each(EMPTY_RANGES)(
    'FND-13 o intervalo invertido é vazio, e não um erro de expressão regular: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(LOOSE_BRACES)(
    'FND-13 a } solta é literal, e a } numa classe dentro de chaves não as fecha: $glob',
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

  it.each(STAR_RUNS)(
    'FND-13 o ** só casa pastas quando é o trecho inteiro, e vale como * em qualquer outro lugar: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(DASH_AFTER_EMPTY_RANGE)(
    'FND-13 o - que sobra depois de um intervalo invertido é membro, e não o começo de outro intervalo: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(EMPTY_AND_LOOSE_BRACES)(
    'FND-13 chaves vazias, ! dentro de chaves e } solta de um grupo só casam como o oxlint: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );

  it.each(OXLINT_QUIRKS)(
    'FND-13 o porte acompanha o oxlint onde uma expressão regular erraria: $glob',
    (testCase) => {
      const files = [testCase.glob];
      expect({
        glob: testCase.glob,
        matched: testCase.matches.filter((sample) =>
          overrideFilesMatch(files, sample),
        ),
        rejected: testCase.rejects.filter(
          (sample) => !overrideFilesMatch(files, sample),
        ),
      }).toEqual({
        glob: testCase.glob,
        matched: testCase.matches,
        rejected: testCase.rejects,
      });
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
  // Letras `z` e `m` (pontas de intervalo invertido), nome sem a letra do meio, `}` no nome (solto e logo depois do
  // `b`) e a `/` entre o `a` e o `b` (a classe negada a casa).
  'q/azb.js',
  'q/amb.js',
  'q/ab.js',
  'q/}b.js',
  'q/a}b.js',
  'q/a/b.js',
  // Níveis de pasta diferentes para o `**` (`q/`, `q/r/`, `q/r/s/`), e nomes de uma letra: `q/**.js` e `q/**b.js` não
  // descem para `q/r/`, e `q/***/b.js` para em `q/r/b.js`.
  'q/a.js',
  'q/b.js',
  'q/r/ab.js',
  'q/r/a-b.js',
  'q/r/b.js',
  'q/r/s/ab.js',
  'q/r/s/b.js',
  'q/a/s/b.js',
  // Pastas `{a` (o `\{**` não abre trecho), `x` (cadeia `x**/**`) e nomes `xb`, `xy`.
  'q/{a/b.js',
  'q/{a/s/b.js',
  'q/xb.js',
  'q/xy.js',
  'q/x/y.js',
  // Nomes de três letras para as classes em sequência (`[^[x][!b-bx][\!{-a-a]`): o terceiro é `-`, `!`, `,` ou `b`.
  'q/r/aa-.js',
  'q/r/aa!.js',
  'q/r/aa,.js',
  'q/r/aab.js',
  'q/r/xab.js',
  // Chaves vazias, `!` em chaves e a `}` solta: `}` e `!` e `,` nos nomes.
  'q/!a.js',
  'q/a!.js',
  'q/ab}.js',
  'q/ab,c.js',
  'ab.js',
  'a-.js',
  'a}.js',
  'ab}.js',
  'a/abc.js',
  // Os caminhos dos globs em que o `}` sobrante depende do caminho que o casamento fez: o oxlint casa um e não casa
  // outro, diferente do que a regex de antes decidia só pelo glob.
  'q/b/ab.js',
  'q/a/ab.js',
  'q/a/ab}.js',
  // O `**/?**/{a}.js` e o `**/a{**/x}.js`.
  'a.js',
  'b/a.js',
  'b/xa.js',
  'ba/a.js',
  'ax.js',
  'a/x.js',
  'a/ax.js',
];

// Intervalo invertido (`z-a`) e `}` solta, medidos no oxlint 1.90.0: o intervalo invertido é vazio (a classe não casa
// nada, e o oxlint aceita a configuração em vez de recusar); a `}` sem `{` aberta é literal; e a `}` dentro de uma
// classe que está dentro de chaves não fecha as chaves.
const RANGE_AND_BRACE_EXPECTED: [string, string[]][] = [
  ['q/a[z-a]b.js', []],
  ['q/a[m-a]b.js', []],
  [
    'q/a[!z-a]b.js',
    [
      'q/a*b.js',
      'q/a-b.js',
      'q/a/b.js',
      'q/a[b.js',
      'q/a]b.js',
      'q/aab.js',
      'q/abb.js',
      'q/acb.js',
      'q/amb.js',
      'q/anb.js',
      'q/axb.js',
      'q/ayb.js',
      'q/azb.js',
      'q/a}b.js',
    ],
  ],
  ['q/a}b.js', ['q/a}b.js']],
  ['q/{a,[}]}b.js', ['q/ab.js', 'q/}b.js']],
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
  // Sem repetir: os globs do oráculo fixo também estão nas tabelas do helper.
  ...[
    ...new Set([
      ...RANGE_AND_BRACE_EXPECTED.map(([glob]) => glob),
      ...EMPTY_RANGES.map(({ glob }) => glob),
      ...LOOSE_BRACES.map(({ glob }) => glob),
      ...STAR_RUNS.map(({ glob }) => glob),
      ...DASH_AFTER_EMPTY_RANGE.map(({ glob }) => glob),
      ...EMPTY_AND_LOOSE_BRACES.map(({ glob }) => glob),
      ...OXLINT_QUIRKS.map(({ glob }) => glob),
      ...OXLINT_NEIGHBOURS,
    ]),
  ].map((glob) => [glob]),
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
    // Intervalo invertido e `}` solta (medido): cada glob casa só o que a tabela diz.
    for (const [glob, expected] of RANGE_AND_BRACE_EXPECTED)
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

  it.each(OXLINT_QUIRKS)(
    'FND-13 o oxlint casa os casos difíceis do oráculo fixo, e o overrideFilesMatch o acompanha: $glob',
    ({ glob, matches, rejects }) => {
      const reported = measured.get(filesLabel([glob])) ?? [];
      expect({
        glob,
        matched: matches.filter((sample) => reported.includes(sample)),
        unmatched: rejects.filter((sample) => !reported.includes(sample)),
      }).toEqual({ glob, matched: matches, unmatched: rejects });
      // O controle da medição: o oxlint reportou o arquivo de algum glob do oráculo (a regra rodou).
      expect(reported.length > 0 || matches.length === 0).toBe(true);
    },
  );

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

// ---------------------------------------------------------------- comparação diferencial por propriedade (FND-13)

// Os casos fixos acima pegam a classe de divergência que alguém já viu; a propriedade pega a que ninguém viu. Ela gera
// globs pela gramática do script de conferência da sessão principal (nomes curtos com os caracteres que o glob trata
// de modo especial; `*`, `?`, classes com intervalos, escapes e membros soltos; grupos de até três alternativas, com
// dois níveis; pasta na frente; `!` no começo) e acrescenta o `**`, a `/` e a `\/` no meio do glob, que o script só
// gera por acaso (`**`, `/`, `**/`, `/**`, `/**/`, `\/`, `***`). Para cada glob roda o oxlint uma vez, sobre uma
// árvore de amostras fixas, e compara o que ele reporta com o `overrideFilesMatch`. O helper é um porte do
// `glob_match`, então não há glob que ele recuse por não saber casar: só o inválido, que o oxlint recusa também. As
// amostras não são as do script (que sorteia as dele a cada execução): são fixas, para o teste não variar com nada
// além da semente do fast-check.

const PROPERTY_NAME_CHARS = [
  'a',
  'b',
  'c',
  'x',
  '-',
  ']',
  '[',
  '^',
  '!',
  '{',
  '}',
  ',',
  '*',
  '?',
  '.',
];

// Gerador pseudoaleatório pequeno e fixo: as amostras não mudam de uma execução para outra, senão o teste ficaria
// instável (o que varia por execução é só a semente do fast-check, e ela é impressa na falha).
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Nomes de uma a três letras sorteadas dos caracteres especiais, em cinco pastas, mais nomes fixos. O nome `.js`
// (sem nada antes do ponto) fica de fora: o oxlint não lê esse arquivo.
function propertySamples(): string[] {
  const random = mulberry32(99);
  const samples = new Set<string>();
  const fixedNames = [
    'a.js',
    'ab.js',
    'a-b.js',
    'abc.js',
    'x.js',
    'a]b.js',
    '-.js',
    'b.js',
    'ab}.js',
    'a}.js',
    'a,b.js',
    'a/b.js',
  ];
  for (const folder of ['', 'q/', 'q/r/', 'a/', 'a/b/']) {
    for (let count = 0; count < 16; count += 1) {
      const length = 1 + Math.floor(random() * 3);
      let name = '';
      for (let letter = 0; letter < length; letter += 1)
        name +=
          PROPERTY_NAME_CHARS[
            Math.floor(random() * PROPERTY_NAME_CHARS.length)
          ] ?? '';
      if (name !== '.') samples.add(`${folder}${name}.js`);
    }
    for (const name of fixedNames) samples.add(`${folder}${name}`);
  }
  return [...samples];
}

const PROPERTY_SAMPLES = propertySamples();

const propertyLetter = fc.constantFrom('a', 'b', 'c', 'x', 'z');

const classItem = fc.oneof(
  {
    weight: 35,
    arbitrary: fc
      .tuple(propertyLetter, propertyLetter)
      .map(([low, high]) => `${low}-${high}`),
  },
  {
    weight: 15,
    arbitrary: fc
      .constantFrom('-', ']', '^', 'a', '!', '[')
      .map((char) => `\\${char}`),
  },
  {
    weight: 50,
    arbitrary: fc.constantFrom(
      'a',
      'b',
      'c',
      'x',
      '-',
      ']',
      '^',
      '!',
      '[',
      '{',
      '}',
      ',',
      '.',
    ),
  },
);

const characterClass = fc
  .tuple(
    fc.oneof(
      { weight: 7, arbitrary: fc.constant('') },
      { weight: 3, arbitrary: fc.constantFrom('!', '^') },
    ),
    fc.array(classItem, { minLength: 1, maxLength: 4 }),
  )
  .map(([negation, items]) => `[${negation}${items.join('')}]`);

const escapedPart = fc
  .constantFrom('*', '?', '[', ']', '{', '}', ',', 'a', '-')
  .map((char) => `\\${char}`);

// O `**` e a `/` no meio do glob, que o script só gera por acaso.
const slashPart = fc.constantFrom(
  '**',
  '/',
  '**/',
  '/**',
  '/**/',
  '\\/',
  '*/',
  '/*',
  '***',
  'q/',
  'r/',
);

// Os pesos do script (25% de caractere solto, 15% de `*` ou `?`, 25% de classe, 10% de escape, 15% de grupo até o
// segundo nível, 10% de `a` ou `b`) valem para 70% das partes; os outros 30% são do `slashPart`.
function partArbitrary(depth: number): fc.Arbitrary<string> {
  const options: { weight: number; arbitrary: fc.Arbitrary<string> }[] = [
    { weight: 30, arbitrary: slashPart },
    {
      weight: 17,
      arbitrary: fc.constantFrom(
        'a',
        'b',
        'c',
        'x',
        '-',
        '.',
        ',',
        '}',
        '^',
        '!',
      ),
    },
    { weight: 10, arbitrary: fc.constantFrom('*', '?') },
    { weight: 18, arbitrary: characterClass },
    { weight: 7, arbitrary: escapedPart },
    { weight: 7, arbitrary: fc.constantFrom('a', 'b') },
  ];
  if (depth < 2) options.push({ weight: 10, arbitrary: groupArbitrary(depth) });
  return fc.oneof(...options);
}

function segmentArbitrary(depth: number): fc.Arbitrary<string> {
  return fc
    .array(partArbitrary(depth), { minLength: 1, maxLength: 3 })
    .map((parts) => parts.join(''));
}

function groupArbitrary(depth: number): fc.Arbitrary<string> {
  return fc
    .array(segmentArbitrary(depth + 1), { minLength: 1, maxLength: 3 })
    .map((items) => `{${items.join(',')}}`);
}

const globArbitrary = fc
  .tuple(
    fc.oneof(
      { weight: 90, arbitrary: fc.constant('') },
      { weight: 8, arbitrary: fc.constant('!') },
      { weight: 2, arbitrary: fc.constant('!!') },
    ),
    fc.constantFrom('', 'q/', '**/', 'q/**/', '*/', 'q/r/', 'a/'),
    segmentArbitrary(0),
    fc.constantFrom('.js', '.js', '.js', '.js', '', '/**', '**'),
  )
  .map(([bang, folder, segment, tail]) => `${bang}${folder}${segment}${tail}`);

// Os nomes começam por `expect` para o `vitest/expect-expect` reconhecê-los como asserção (.oxlintrc.json).
function expectFalsifiedByParity(failed: boolean): void {
  expect(failed).toBe(true);
}

function expectParityProperty(
  property: fc.IPropertyWithHooks<[string]>,
  numRuns: number,
): void {
  fc.assert(property, { numRuns });
}

describe('FND-13 comparação diferencial dos files dos overrides com o oxlint', () => {
  let tree = '';

  beforeAll(() => {
    tree = makeTempDir('glob-property-');
    for (const file of PROPERTY_SAMPLES) writeFileIn(tree, file, 'debugger;\n');
  });

  afterAll(cleanupTempDirs);

  // Cada caso custa um processo do oxlint (medido: cerca de 64 ms sobre estas amostras, 3,2 s para 50 casos), e o `unit`
  // inteiro tem de caber no que uma pré-push aguenta. O padrão de 100 casos custaria cerca de 6,4 s só neste teste,
  // acima do que um teste de propriedade comum gasta; a metade, 50 casos, mede o suficiente com a semente fixa do PR, e
  // o agendado, que passa mais casos (`FAST_CHECK_NUM_RUNS`), roda a metade deles. O prazo conta cada caso como quatro
  // dos testes comuns (`propertyTimeoutMs(numRuns * 4)`: 160 ms por caso mais 5 s), porque um processo por caso é
  // mais lento que o caso comum de propriedade.
  const numRuns = Math.max(20, Math.floor(readPropertyConfig().numRuns / 2));

  interface Counters {
    compared: number;
    invalid: number;
  }

  // O que o helper diz de um glob: as amostras que casa, ou que o glob é inválido (o oxlint recusa a configuração).
  // Qualquer outro erro é um defeito e sobe.
  function verdictFor(
    glob: string,
    match: (glob: string, sample: string) => boolean,
  ): 'invalid' | string[] {
    try {
      return PROPERTY_SAMPLES.filter((sample) => match(glob, sample)).sort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/inválido/.test(message)) return 'invalid';
      throw error;
    }
  }

  // O que a propriedade confere para um glob: o que o oxlint reporta é o que `match` diz. O `match` é o
  // `overrideFilesMatch` de verdade, ou, no controle negativo, uma versão quebrada dele.
  function compareWithOxlint(
    glob: string,
    match: (glob: string, sample: string) => boolean,
    counters: Counters,
  ): void {
    const verdict = verdictFor(glob, match);
    const run = runOxlint(
      tree,
      singleRuleConfig([{ files: [glob], rules: { 'no-debugger': 'error' } }]),
      'property.json',
    );
    const invalid = verdict === 'invalid';
    expect({ glob, refused: oxlintRefusedGlob(run) }).toEqual({
      glob,
      refused: invalid,
    });
    expect({
      glob,
      // Com o glob inválido a recusa pode sair em stderr; o que se confere nele é só a recusa, acima.
      stderr: invalid ? '' : run.stderr,
      matched: [...new Set(run.reports.map((report) => report.file))].sort(),
    }).toEqual({
      glob,
      stderr: '',
      matched: invalid ? [] : verdict,
    });
    counters[invalid ? 'invalid' : 'compared'] += 1;
  }

  it(
    'FND-13 o overrideFilesMatch casa as mesmas amostras que o oxlint para globs gerados',
    () => {
      const counters: Counters = { compared: 0, invalid: 0 };
      expectParityProperty(
        fc.property(globArbitrary, (glob) => {
          compareWithOxlint(
            glob,
            (pattern, sample) => overrideFilesMatch([pattern], sample),
            counters,
          );
        }),
        numRuns,
      );
      // A propriedade só vale se comparou: o glob inválido é raro, e o oxlint rodou em quase todos.
      expect(counters.compared).toBeGreaterThan(numRuns * 0.8);
      expect(counters.invalid).toBeLessThan(numRuns * 0.2);
    },
    propertyTimeoutMs(numRuns * 4),
  );

  // Controle negativo: um helper que trata o `**` como um `*` (o defeito da divergência 1) tem de ser reprovado pela
  // mesma propriedade. Sem ele, uma propriedade que nunca compara (amostras erradas, `match` ignorado) passaria sempre.
  it(
    'FND-13 controle negativo: um helper que trata o ** como * é reprovado pela propriedade',
    () => {
      const counters: Counters = { compared: 0, invalid: 0 };
      const outcome = fc.check(
        fc.property(globArbitrary, (glob) => {
          compareWithOxlint(
            glob,
            (pattern, sample) =>
              overrideFilesMatch([pattern.replaceAll('**', '*')], sample),
            counters,
          );
        }),
        { numRuns: 50, endOnFailure: true },
      );
      expectFalsifiedByParity(outcome.failed);
      // A reprovação vem de uma asserção da comparação com o oxlint, e não de um erro qualquer do helper.
      expect(String(outcome.errorInstance)).toMatch(/^AssertionError/);
    },
    propertyTimeoutMs(50 * 4),
  );
});
