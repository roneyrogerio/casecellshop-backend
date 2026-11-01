import { describe, expect, it } from 'vitest';
import { globToRegExp } from './glob.ts';

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

describe('FND-13 globToRegExp', () => {
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

  it.each(NESTED_BRACES)(
    'FND-13 chaves aninhadas viram alternativas só dentro das chaves: $glob',
    (testCase) => {
      expectCase(testCase);
    },
  );
});
