import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

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

  it.each(['noImplicitReturns', 'noImplicitOverride', 'noFallthroughCasesInSwitch', 'exactOptionalPropertyTypes'])(
    'AI-20 a opção %s está ligada no tsconfig.json',
    (option) => {
      expect(options[option]).toBe(true);
    },
  );
});

describe('AI-20 o .oxlintrc.json liga como erro as regras de estilo', () => {
  const rules = readJson<OxlintConfig>('.oxlintrc.json').rules;

  it.each([
    'typescript/switch-exhaustiveness-check',
    'typescript/prefer-nullish-coalescing',
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

// Pasta no tmpdir do sistema, e não no repositório (mesma razão do test-layout): um lint paralelo
// ou uma execução interrompida esbarraria no arquivo de amostra.
describe('AI-20 controle negativo do lint: switch sem todos os casos da união reprova', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'ai20-lint-'));
    // As regras com tipos resolvem os módulos a partir da pasta da amostra.
    symlinkSync(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function lint(source: string): { status: number | null; output: string } {
    const file = path.join(tree, 'amostra.ts');
    writeFileSync(file, source);
    const result = spawnSync(
      path.join(root, 'node_modules', '.bin', 'oxlint'),
      ['-c', path.join(root, '.oxlintrc.json'), file],
      { cwd: root, encoding: 'utf8' },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const header = `type Cor = 'a' | 'b';\n\nexport function nome(cor: Cor): string {\n  switch (cor) {\n    case 'a':\n      return 'A';\n`;

  it('AI-20 um switch que trata só "a" da união "a" | "b" reprova com switch-exhaustiveness-check', () => {
    const result = lint(`${header}  }\n  return '';\n}\n`);

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).toContain('switch-exhaustiveness-check');
  }, 60_000);

  it('AI-20 o mesmo arquivo tratando "a" e "b" passa no lint', () => {
    const result = lint(`${header}    case 'b':\n      return 'B';\n  }\n  return '';\n}\n`);

    expect(result.output).not.toContain('switch-exhaustiveness-check');
    expect(result.status).toBe(0);
  }, 60_000);
});

describe('AI-20 controle negativo do typecheck: undefined explícito em propriedade opcional reprova', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'ai20-tsc-'));
    // A pasta herda as opções do repositório por caminho absoluto. `include` é refeito porque o herdado
    // valeria para as pastas do repositório; `typeRoots` aponta para o repositório porque, fora dele,
    // os tipos do Node não são achados.
    writeFileSync(
      path.join(tree, 'tsconfig.json'),
      JSON.stringify({
        extends: path.join(root, 'tsconfig.json'),
        compilerOptions: { typeRoots: [path.join(root, 'node_modules', '@types')] },
        include: ['amostra.mts'],
      }),
    );
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function typecheck(source: string): { status: number | null; output: string } {
    // `.mts`: fora do repositório não há `"type": "module"`, e o `export` da amostra seria lido como CommonJS.
    writeFileSync(path.join(tree, 'amostra.mts'), source);
    const result = spawnSync(
      path.join(root, 'node_modules', '.bin', 'tsc'),
      ['--noEmit', '-p', path.join(tree, 'tsconfig.json')],
      { cwd: root, encoding: 'utf8' },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it('AI-20 propriedade opcional recebendo undefined explícito reprova no tsc com exactOptionalPropertyTypes', () => {
    const result = typecheck(`type A = { x?: number };\nexport const a: A = { x: undefined };\n`);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exactOptionalPropertyTypes');
  }, 60_000);

  it('AI-20 o mesmo arquivo sem o undefined explícito passa no tsc', () => {
    const result = typecheck(`type A = { x?: number };\nexport const a: A = {};\n`);

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
