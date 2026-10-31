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
const GENERATED_TYPE_FILES = ['src/db/types/store.ts', 'src/db/types/erp-sim.ts'];
const GENERATED_ONLY_RULES = ['typescript/consistent-type-definitions'];

// Caminhos de amostra: servem só para saber a que arquivos um glob que alcança .ts se limita (os gerados).
const TS_SAMPLES = [
  'a.ts',
  'src/app.ts',
  'src/checkout/reserve.ts',
  'src/db/migrate.ts',
  'scripts/check-env.ts',
  'test/helpers/clock.ts',
  'test/integration/db/x.test.ts',
  'migrations/store/20260101000000_x.ts',
  '.claude/hooks/x.test.ts',
  ...GENERATED_TYPE_FILES,
];

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*' && glob.charAt(index + 1) === '*') {
      const slash = glob.charAt(index + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      source += '(?:';
    } else if (char === '}') {
      source += ')';
    } else if (char === ',' && source.includes('(?:')) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

// O glob alcança .ts quando termina em `.ts`, em `*` ou em `**`, ou num grupo `{…ts…}`. Os caminhos de amostra
// não servem para decidir: uma pasta que nenhuma amostra cita (src/http/**/*.ts) escaparia da conferência.
function reachesTs(glob: string): boolean {
  return /(?:\.ts|\*)$/.test(glob) || /\{[^}]*\bts\b[^}]*\}$/.test(glob);
}

function overrideReachesTs(files: readonly string[]): boolean {
  return files.some(reachesTs);
}

// Todo glob do override que alcança .ts casa ao menos um caminho de amostra e só arquivos gerados; um glob que
// nenhuma amostra casa (src/http/**/*.ts) não prova que se limita aos gerados.
function onlyReachesGeneratedFiles(files: readonly string[]): boolean {
  return files.filter(reachesTs).every((glob) => {
    const matched = TS_SAMPLES.filter((sample) => globToRegExp(glob).test(sample));
    return matched.length > 0 && matched.every((sample) => GENERATED_TYPE_FILES.includes(sample));
  });
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
    const disabled = STYLE_RULES.filter((rule) => override.rules !== undefined && rule in override.rules && !isOn(override.rules[rule]));
    if (disabled.length === 0) continue;
    const onlyGenerated = onlyReachesGeneratedFiles(override.files);
    const onlyAllowedRules = disabled.every((rule) => GENERATED_ONLY_RULES.includes(rule));
    if (onlyGenerated && onlyAllowedRules) continue;
    violations.push(`${override.files.join(', ')} desliga ${disabled.join(', ')}`);
  }
  return violations;
}

describe('AI-20 os overrides do .oxlintrc.json que alcançam .ts não desligam as regras de estilo', () => {
  const { overrides = [] } = readJson<OxlintConfig & { overrides?: Override[] }>('.oxlintrc.json');

  it('AI-20 nenhum override para .ts desliga uma das onze regras, salvo consistent-type-definitions nos tipos gerados', () => {
    expect(styleOverrideViolations(overrides)).toEqual([]);
  });

  it('AI-20 os dois overrides conhecidos para .ts existem e só desligam o que o critério aceita', () => {
    const tsOverrides = overrides.filter((override) => overrideReachesTs(override.files));
    const disabledBy = (files: string): string[] =>
      Object.entries(tsOverrides.find((override) => override.files.includes(files))?.rules ?? {})
        .filter(([, setting]) => !isOn(setting))
        .map(([rule]) => rule)
        .sort();

    expect(disabledBy('**/migrations/**/*.ts')).toEqual(['typescript/no-explicit-any']);
    expect(disabledBy('src/db/types/*.ts')).toEqual([
      'typescript/consistent-type-definitions',
      'typescript/no-empty-object-type',
    ]);
  });

  // Controles negativos: a conferência enxerga o override que a deixaria passar.
  it.each(STYLE_RULES)('AI-20 controle: um override de **/*.ts que desliga %s reprova', (rule) => {
    expect(styleOverrideViolations([{ files: ['**/*.ts'], rules: { [rule]: 'off' } }])).toHaveLength(1);
  });

  it.each([
    ['uma pasta', ['src/**/*.ts']],
    ['só os testes', ['**/*.test.ts']],
    ['o glob *.ts', ['*.ts']],
    ['todos os arquivos', ['**/*']],
    ['as chaves {ts,js}', ['**/*.{ts,js}']],
    ['uma pasta de scripts', ['scripts/*.ts']],
  ])('AI-20 controle: um override para %s que desliga return-await reprova', (_label, files) => {
    expect(styleOverrideViolations([{ files, rules: { 'typescript/return-await': 'off' } }])).toHaveLength(1);
  });

  // Pastas que nenhum caminho de amostra cita: o glob alcança .ts pelo fim dele, e não por casar uma amostra.
  it.each(STYLE_RULES)('AI-20 controle: um override de src/http/**/*.ts que desliga %s reprova', (rule) => {
    expect(styleOverrideViolations([{ files: ['src/http/**/*.ts'], rules: { [rule]: 'off' } }])).toHaveLength(1);
  });

  it.each([
    ['uma pasta fora das amostras, com **', ['src/http/**/*.ts']],
    ['uma pasta fora das amostras, com *', ['src/http/*.ts']],
    ['um arquivo fora das amostras', ['src/http/routes.ts']],
    ['uma pasta e tudo dentro dela', ['src/http/**']],
    ['uma pasta e os arquivos dela, com *', ['src/http/*']],
    ['o grupo {js,ts}', ['src/http/**/*.{js,ts}']],
    ['o grupo {ts,tsx}', ['src/http/**/*.{ts,tsx}']],
  ])('AI-20 controle: um override para %s que desliga return-await reprova', (_label, files) => {
    expect(styleOverrideViolations([{ files, rules: { 'typescript/return-await': 'off' } }])).toHaveLength(1);
  });

  it('AI-20 controle: consistent-type-definitions desligada numa pasta fora das amostras reprova, porque ela não se limita aos tipos gerados', () => {
    const off = { 'typescript/consistent-type-definitions': 'off' };

    expect(styleOverrideViolations([{ files: ['src/http/**/*.ts'], rules: off }])).toHaveLength(1);
    expect(styleOverrideViolations([{ files: ['src/db/types/*.ts', 'src/http/**/*.ts'], rules: off }])).toHaveLength(1);
  });

  it.each([
    ['só os .js', ['src/http/**/*.js']],
    ['os .js, .mjs e .cjs', ['src/http/**/*.{js,mjs,cjs}']],
    ['só os .md', ['docs/**/*.md']],
    ['os .json', ['src/http/*.json']],
  ])('AI-20 controle: um override para %s, que não alcança .ts, pode desligar return-await', (_label, files) => {
    expect(styleOverrideViolations([{ files, rules: { 'typescript/return-await': 'off' } }])).toEqual([]);
  });

  it('AI-20 controle: consistent-type-definitions desligada fora dos arquivos gerados reprova', () => {
    const off = { 'typescript/consistent-type-definitions': 'off' };

    expect(styleOverrideViolations([{ files: ['src/db/types/*.ts'], rules: off }])).toEqual([]);
    expect(styleOverrideViolations([{ files: ['src/db/*.ts'], rules: off }])).toHaveLength(1);
    expect(styleOverrideViolations([{ files: ['src/**/*.ts'], rules: off }])).toHaveLength(1);
    expect(styleOverrideViolations([{ files: ['src/db/types/*.ts', 'src/app.ts'], rules: off }])).toHaveLength(1);
  });

  it('AI-20 controle: os tipos gerados não podem desligar nenhuma outra das onze regras', () => {
    const files = ['src/db/types/*.ts'];

    expect(styleOverrideViolations([{ files, rules: { 'typescript/return-await': 'off' } }])).toHaveLength(1);
    expect(
      styleOverrideViolations([
        { files, rules: { 'typescript/consistent-type-definitions': 'off', 'eslint/prefer-const': 'off' } },
      ]),
    ).toHaveLength(1);
  });

  it.each([['warn'], [0], [['off']], [['warn', {}]]])('AI-20 controle: baixar a regra para %j também reprova', (setting) => {
    expect(styleOverrideViolations([{ files: ['**/*.ts'], rules: { 'eslint/no-var': setting } }])).toHaveLength(1);
  });

  it('AI-20 controle: o que o critério aceita passa', () => {
    expect(
      styleOverrideViolations([
        { files: ['**/migrations/**/*.ts'], rules: { 'typescript/no-explicit-any': 'off' } },
        { files: ['src/db/types/*.ts'], rules: { 'typescript/consistent-type-definitions': 'off', 'typescript/no-empty-object-type': 'off' } },
        { files: ['**/*.js', '**/*.mjs', '**/*.cjs'], rules: { 'typescript/return-await': 'off', 'eslint/prefer-const': 'off' } },
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
