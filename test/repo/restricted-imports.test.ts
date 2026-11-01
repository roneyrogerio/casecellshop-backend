import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../helpers/glob.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// Imports que os testes não fazem, travados pelo `no-restricted-imports` do oxlint e conferidos aqui com o
// .oxlintrc.json lido como dado: a configuração efetiva de cada arquivo (o valor de cima, trocado por cada override
// que casa, na ordem) tem de reprovar o import em toda a pasta e liberá-lo só nos arquivos da lista.
//
// - FND-14: os contêineres sobem num lugar só, por rodada. Um teste que sobe o próprio PostgreSQL ou ElasticMQ com
//   `PostgreSqlContainer`, `GenericContainer` ou `DockerComposeEnvironment` volta ao contêiner por arquivo.
// - FND-13 ("Processos"): todo processo filho síncrono dos testes de repositório passa pelo `runCommand` (test/helpers/run-node.ts),
//   que sempre leva `timeout`. Um `spawnSync`, `execSync` ou `execFileSync` direto volta ao processo sem prazo.
//
// A regra é uma só por arquivo (o override de baixo substitui o de cima): quem escreve a configuração junta as opções
// dos dois critérios num mesmo arquivo, e a conferência de cada critério olha só os imports dele.

const RULE = 'no-restricted-imports';
// A17: o import('…') de um módulo restrito, que o no-restricted-imports não vê quando a entrada tem importNames.
const DYNAMIC_RULE = 'test-imports/no-restricted-dynamic-import';
const DYNAMIC_PLUGIN = './scripts/lint-rules/test-imports.ts';

interface ImportUse {
  module: string;
  name: string;
}

interface Spec {
  id: string;
  // Os globs das pastas que a regra cobre, e as pastas lidas do disco para a lista de arquivos.
  globs: string[];
  roots: string[];
  // Os arquivos liberados (a lista do critério).
  allowed: string[];
  // Um arquivo qualquer, fora da lista, para os controles.
  sample: string;
  // Inclui o `default` de cada módulo (A22): sem ele na configuração, o import padrão escapa da regra.
  restricted: ImportUse[];
  // O que as pastas já importam do mesmo módulo e continua livre.
  free: ImportUse[];
  // Os módulos que o import dinâmico não pode trazer (a regra test-imports/no-restricted-dynamic-import).
  dynamic: string[];
  // Pastas do disco que ficam fora da leitura (cópias do repositório dos agentes) e quais arquivos entram.
  skipDirs?: string[];
  keep?: (file: string) => boolean;
}

const SPECS: Spec[] = [
  {
    id: 'FND-14',
    globs: ['test/integration/**/*.ts', 'test/helpers/**/*.ts'],
    roots: ['test/integration', 'test/helpers'],
    // O globalSetup da rodada, o banco de migração (FND-11), o ElasticMQ reiniciado, o compose e o teste que para o
    // contêiner e o controle negativo de execução do fuzzing (FND-16), que roda a imagem do Schemathesis contra
    // servidores do próprio teste.
    allowed: [
      'test/helpers/compose.ts',
      'test/helpers/elasticmq-container.ts',
      'test/helpers/migration-database.ts',
      'test/integration/foundation/api-fuzz-negative-control.test.ts',
      'test/integration/foundation/container-shutdown.test.ts',
      'test/integration/global-setup.ts',
    ],
    sample: 'test/integration/checkout/checkout.test.ts',
    restricted: [
      { module: '@testcontainers/postgresql', name: 'PostgreSqlContainer' },
      { module: '@testcontainers/postgresql', name: 'default' },
      { module: 'testcontainers', name: 'GenericContainer' },
      { module: 'testcontainers', name: 'DockerComposeEnvironment' },
      { module: 'testcontainers', name: 'default' },
    ],
    free: [
      { module: 'testcontainers', name: 'StartedDockerComposeEnvironment' },
      { module: 'testcontainers', name: 'getContainerRuntimeClient' },
    ],
    dynamic: ['testcontainers', '@testcontainers/postgresql'],
  },
  {
    id: 'FND-13',
    // A19: os testes de .claude/ (só *.test.ts, fora das cópias do repositório em .claude/worktrees/) entram.
    globs: [
      'test/repo/**/*.ts',
      'test/helpers/**/*.ts',
      '.claude/**/*.test.ts',
    ],
    roots: ['test/repo', 'test/helpers', '.claude'],
    allowed: ['test/helpers/run-node.ts'],
    sample: 'test/repo/formatter.test.ts',
    restricted: [
      { module: 'node:child_process', name: 'spawnSync' },
      { module: 'node:child_process', name: 'execSync' },
      { module: 'node:child_process', name: 'execFileSync' },
      { module: 'node:child_process', name: 'default' },
    ],
    free: [
      { module: 'node:child_process', name: 'execFile' },
      { module: 'node:child_process', name: 'spawn' },
    ],
    dynamic: ['node:child_process'],
    skipDirs: ['.claude/worktrees'],
    keep: (file) => !file.startsWith('.claude/') || file.endsWith('.test.ts'),
  },
];

interface RestrictionEntry {
  name?: string;
  group?: string[];
  regex?: string;
  importNames?: string[];
  allowImportNames?: string[];
}
interface RestrictionOptions {
  paths?: (string | RestrictionEntry)[];
  patterns?: (string | RestrictionEntry)[];
}
interface Override {
  files?: string[];
  rules?: Record<string, unknown>;
}
interface OxlintConfig {
  jsPlugins?: string[];
  rules?: Record<string, unknown>;
  overrides?: Override[];
}

function severityOf(setting: unknown): unknown {
  return Array.isArray(setting) ? (setting as unknown[])[0] : setting;
}

function optionsOf(setting: unknown): RestrictionOptions {
  const options: RestrictionOptions | undefined = Array.isArray(setting)
    ? ((setting as unknown[])[1] as RestrictionOptions | undefined)
    : undefined;
  return options ?? {};
}

function effectiveSetting(
  config: OxlintConfig,
  file: string,
  rule: string = RULE,
): unknown {
  let setting = config.rules?.[rule];
  for (const override of config.overrides ?? []) {
    const matches = (override.files ?? []).some((glob) =>
      globToRegExp(glob).test(file),
    );
    if (matches && override.rules && rule in override.rules)
      setting = override.rules[rule];
  }
  return setting;
}

function entryMatches(
  entry: string | RestrictionEntry,
  use: ImportUse,
): boolean {
  const { name, group, regex, importNames, allowImportNames } =
    typeof entry === 'string' ? ({ name: entry } as RestrictionEntry) : entry;
  const moduleMatches =
    name === use.module ||
    (group ?? []).some(
      (pattern) =>
        pattern === use.module || globToRegExp(pattern).test(use.module),
    ) ||
    (regex !== undefined && new RegExp(regex).test(use.module));
  if (!moduleMatches) return false;
  if (importNames !== undefined) return importNames.includes(use.name);
  if (allowImportNames !== undefined)
    return !allowImportNames.includes(use.name);
  return true;
}

// A regra está ligada como `error` para o arquivo e algum item das opções (`paths` ou `patterns`) reprova o import.
function isRestricted(
  config: OxlintConfig,
  file: string,
  use: ImportUse,
): boolean {
  const setting = effectiveSetting(config, file);
  if (severityOf(setting) !== 'error') return false;
  const { paths = [], patterns = [] } = optionsOf(setting);
  return [...paths, ...patterns].some((entry) => entryMatches(entry, use));
}

interface DefectPhrases<T> {
  restricted: (file: string, item: T) => boolean;
  // A frase do arquivo fora da lista que pode importar, e a do arquivo da lista que a regra ainda trava.
  open: (file: string, item: T) => string;
  closed: (file: string, item: T) => string;
}

function listDefects<T>(
  files: readonly string[],
  spec: Spec,
  items: readonly T[],
  phrases: DefectPhrases<T>,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    const allowed = spec.allowed.includes(file);
    for (const item of items) {
      const restricted = phrases.restricted(file, item);
      if (!allowed && !restricted) found.push(phrases.open(file, item));
      if (allowed && restricted) found.push(phrases.closed(file, item));
    }
  }
  return found;
}

// Uma frase por defeito: arquivo fora da lista que pode importar, arquivo da lista que a regra ainda trava, ou
// import livre que a regra trava.
function violations(
  config: OxlintConfig,
  files: readonly string[],
  spec: Spec,
): string[] {
  const found = listDefects(files, spec, spec.restricted, {
    restricted: (file, use) => isRestricted(config, file, use),
    open: (file, use) => `${file} pode importar ${use.name} de ${use.module}`,
    closed: (file, use) =>
      `${file} (exceção do ${spec.id}) não pode importar ${use.name}`,
  });
  for (const file of files) {
    for (const use of spec.free)
      if (isRestricted(config, file, use))
        found.push(`${file} não pode importar ${use.name} de ${use.module}`);
  }
  return found;
}

// Os arquivos .ts de uma pasta, sem as pastas de `skipDirs` e só os que `keep` aceita.
function filesUnder(
  dir: string,
  skipDirs: readonly string[] = [],
  keep: (file: string) => boolean = () => true,
): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory())
        return skipDirs.includes(path) ? [] : filesUnder(path, skipDirs, keep);
      return entry.name.endsWith('.ts') && keep(path) ? [path] : [];
    },
  );
}

function specFiles(spec: Spec): string[] {
  return spec.roots
    .flatMap((root) => filesUnder(root, spec.skipDirs, spec.keep))
    .sort();
}

// A17: a regra do import dinâmico está como `error` para o arquivo e lista o módulo em algum item de `paths`.
function isDynamicRestricted(
  config: OxlintConfig,
  file: string,
  module: string,
): boolean {
  const setting = effectiveSetting(config, file, DYNAMIC_RULE);
  if (severityOf(setting) !== 'error') return false;
  const { paths = [] } = optionsOf(setting);
  return paths.some(
    (entry) => typeof entry !== 'string' && entry.name === module,
  );
}

function loadsDynamicPlugin(source: OxlintConfig): boolean {
  return (source.jsPlugins ?? []).includes(DYNAMIC_PLUGIN);
}

// Uma frase por defeito: arquivo fora da lista que pode trazer o módulo por import(…), ou da lista que a regra trava.
function dynamicViolations(
  config: OxlintConfig,
  files: readonly string[],
  spec: Spec,
): string[] {
  return listDefects(files, spec, spec.dynamic, {
    restricted: (file, module) => isDynamicRestricted(config, file, module),
    open: (file, module) => `${file} pode importar dinamicamente ${module}`,
    closed: (file, module) =>
      `${file} (exceção do ${spec.id}) não pode importar dinamicamente ${module}`,
  });
}

// Os itens `paths` de uma restrição dos imports da lista, agrupados por módulo.
function pathsOf(uses: ImportUse[]): RestrictionEntry[] {
  const byModule = new Map<string, string[]>();
  for (const use of uses)
    byModule.set(use.module, [...(byModule.get(use.module) ?? []), use.name]);
  return [...byModule].map(([name, importNames]) => ({ name, importNames }));
}

function restrictFolders(spec: Spec, options: RestrictionOptions): Override {
  return { files: spec.globs, rules: { [RULE]: ['error', options] } };
}

// A configuração correta do critério, escrita aqui: base dos controles negativos, que não dependem de como a do
// projeto foi escrita.
function good(spec: Spec): OxlintConfig {
  return {
    overrides: [
      restrictFolders(spec, { paths: pathsOf(spec.restricted) }),
      { files: spec.allowed, rules: { [RULE]: 'off' } },
    ],
  };
}

// A mesma restrição na forma `patterns` com `regex`, a que o resto do .oxlintrc.json usa.
function goodPatterns(spec: Spec): OxlintConfig {
  return {
    overrides: [
      restrictFolders(spec, {
        patterns: pathsOf(spec.restricted).map(({ name, importNames }) => ({
          regex: `^${(name ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`,
          ...(importNames ? { importNames } : {}),
        })),
      }),
      { files: spec.allowed, rules: { [RULE]: 'off' } },
    ],
  };
}

function withOverride(source: OxlintConfig, override: Override): OxlintConfig {
  const copy = structuredClone(source);
  copy.overrides = [...(copy.overrides ?? []), override];
  return copy;
}

function withSeverity(
  source: OxlintConfig,
  severity: string,
  rule: string = RULE,
): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? []) {
    const setting = override.rules?.[rule];
    if (
      override.rules &&
      Array.isArray(setting) &&
      severityOf(setting) === 'error'
    )
      override.rules[rule] = [severity, ...(setting as unknown[]).slice(1)];
  }
  return copy;
}

// A22: a configuração correta, mas sem o `default` nos importNames de todo módulo restrito.
function withoutDefaultImport(source: OxlintConfig): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? []) {
    const setting = override.rules?.[RULE];
    if (!Array.isArray(setting)) continue;
    for (const entry of optionsOf(setting).paths ?? [])
      if (typeof entry !== 'string' && entry.importNames)
        entry.importNames = entry.importNames.filter(
          (name) => name !== 'default',
        );
  }
  return copy;
}

// A configuração correta do import dinâmico, escrita aqui: a regra lista os módulos do critério nas pastas e fica
// desligada nas exceções.
function goodDynamic(spec: Spec): OxlintConfig {
  const paths = spec.dynamic.map((name) => ({
    name,
    message: `Import dinâmico de ${name} proibido (${spec.id}).`,
  }));
  return {
    overrides: [
      { files: spec.globs, rules: { [DYNAMIC_RULE]: ['error', { paths }] } },
      { files: spec.allowed, rules: { [DYNAMIC_RULE]: 'off' } },
    ],
  };
}

// A mesma configuração sem o primeiro módulo da lista de cada item da regra do import dinâmico.
function withoutDynamicModule(
  source: OxlintConfig,
  module: string,
): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? []) {
    const setting = override.rules?.[DYNAMIC_RULE];
    if (!Array.isArray(setting)) continue;
    const options = (setting as unknown[])[1] as RestrictionOptions;
    options.paths = (options.paths ?? []).filter(
      (entry) => typeof entry === 'string' || entry.name !== module,
    );
  }
  return copy;
}

function withoutException(source: OxlintConfig, file: string): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? [])
    override.files = (override.files ?? []).filter((glob) => glob !== file);
  return copy;
}

const config = JSON.parse(
  readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8'),
) as OxlintConfig;

describe.each(SPECS)(
  '$id imports restritos pelo no-restricted-imports do .oxlintrc.json',
  (spec) => {
    const files = specFiles(spec);
    const first = spec.restricted[0] as ImportUse;
    const line = (file: string, use: ImportUse) =>
      `${file} pode importar ${use.name} de ${use.module}`;

    it(`${spec.id} o .oxlintrc.json reprova ${spec.restricted.map((use) => use.name).join(', ')} nas pastas do critério, salvo nos arquivos da lista`, () => {
      expect(violations(config, files, spec)).toEqual([]);
    });

    it(`${spec.id} a leitura enxerga as pastas e a lista de exceções (controle positivo)`, () => {
      expect(files).toEqual(expect.arrayContaining(spec.allowed));
      expect(files).toContain(spec.sample);
    });

    // Controles do verificador, sobre configurações escritas aqui.
    it.each([
      ['paths', good(spec)],
      ['patterns com regex', goodPatterns(spec)],
    ])(
      `${spec.id} controle positivo: a configuração correta na forma %s não tem violação`,
      (_label, correct) => {
        expect(violations(correct, files, spec)).toEqual([]);
      },
    );

    it(`${spec.id} controle negativo: sem a regra, todo arquivo fora da lista reprova nos imports restritos`, () => {
      const found = violations({ overrides: [] }, files, spec);

      for (const use of spec.restricted)
        expect(found).toContain(line(spec.sample, use));
    });

    it.each(['warn', 'off'])(
      `${spec.id} controle negativo: com a regra como %s, a conferência reprova`,
      (severity) => {
        const found = violations(
          withSeverity(good(spec), severity),
          files,
          spec,
        );

        expect(found).toContain(line(spec.sample, first));
      },
    );

    it(`${spec.id} controle negativo: uma exceção a mais (um arquivo qualquer liberado) reprova, em todos os imports`, () => {
      const found = violations(
        withOverride(good(spec), {
          files: [spec.sample],
          rules: { [RULE]: 'off' },
        }),
        files,
        spec,
      );

      expect(found).toEqual(
        spec.restricted.map((use) => line(spec.sample, use)),
      );
    });

    it(`${spec.id} controle negativo: um glob de exceção largo (a pasta inteira) reprova os arquivos fora da lista`, () => {
      const found = violations(
        withOverride(good(spec), {
          files: spec.globs,
          rules: { [RULE]: 'off' },
        }),
        files,
        spec,
      );

      expect(found).toContain(line(spec.sample, first));
    });

    it(`${spec.id} controle negativo: restringir só o primeiro import deixa os outros passar`, () => {
      const found = violations(
        withOverride(
          { overrides: [] },
          restrictFolders(spec, {
            paths: [{ name: first.module, importNames: [first.name] }],
          }),
        ),
        files,
        spec,
      );

      expect(found).not.toContain(line(spec.sample, first));
      for (const use of spec.restricted.slice(1))
        expect(found).toContain(line(spec.sample, use));
    });

    it(`${spec.id} controle negativo: um arquivo da lista que a regra ainda trava reprova`, () => {
      const [exempt] = spec.allowed as [string];

      const found = violations(
        withoutException(good(spec), exempt),
        files,
        spec,
      );

      expect(found).toEqual(
        spec.restricted.map(
          (use) =>
            `${exempt} (exceção do ${spec.id}) não pode importar ${use.name}`,
        ),
      );
    });

    it(`${spec.id} controle negativo: restringir o módulo inteiro trava o que o critério deixa livre`, () => {
      const [free] = spec.free as [ImportUse];

      const found = violations(
        withOverride(
          good(spec),
          restrictFolders(spec, {
            paths: [{ name: free.module }],
          }),
        ),
        files,
        spec,
      );

      expect(found).toContain(
        `${spec.sample} não pode importar ${free.name} de ${free.module}`,
      );
    });

    // A22: o import padrão é uma das formas que o critério trava; sem o `default` nos importNames ele escapa.
    it(`${spec.id} controle negativo: sem o default nos importNames, a conferência reprova o import padrão de cada módulo`, () => {
      const found = violations(withoutDefaultImport(good(spec)), files, spec);
      const defaults = spec.restricted.filter((use) => use.name === 'default');

      // Um default por módulo restrito: a tabela do critério o exige.
      expect(defaults.map((use) => use.module).sort()).toEqual(
        [...new Set(spec.restricted.map((use) => use.module))].sort(),
      );
      for (const use of defaults)
        expect(found).toContain(line(spec.sample, use));
    });

    it(`${spec.id} controle negativo: o .oxlintrc.json sem o default nos importNames reprova o import padrão`, () => {
      const found = violations(withoutDefaultImport(config), files, spec);
      const defaults = spec.restricted.filter((use) => use.name === 'default');

      for (const use of defaults)
        expect(found).toContain(line(spec.sample, use));
    });

    // A17: a regra test-imports/no-restricted-dynamic-import lida como dado, nas mesmas pastas e exceções.
    it(`${spec.id} o .oxlintrc.json liga a regra do import dinâmico com ${spec.dynamic.join(', ')} nas pastas do critério, salvo nos arquivos da lista`, () => {
      expect(dynamicViolations(config, files, spec)).toEqual([]);
    });

    it(`${spec.id} o .oxlintrc.json carrega o plugin test-imports em jsPlugins`, () => {
      expect(loadsDynamicPlugin(config)).toBe(true);
    });

    it(`${spec.id} controle negativo: sem o plugin test-imports em jsPlugins, a conferência do plugin reprova`, () => {
      const without = structuredClone(config);
      without.jsPlugins = (without.jsPlugins ?? []).filter(
        (plugin) => plugin !== DYNAMIC_PLUGIN,
      );

      expect(loadsDynamicPlugin(without)).toBe(false);
    });

    it(`${spec.id} controle positivo: a configuração correta do import dinâmico não tem violação`, () => {
      expect(dynamicViolations(goodDynamic(spec), files, spec)).toEqual([]);
    });

    const dynamicLine = (file: string, module: string) =>
      `${file} pode importar dinamicamente ${module}`;

    it(`${spec.id} controle negativo: sem a regra do import dinâmico, todo arquivo fora da lista reprova em cada módulo`, () => {
      const found = dynamicViolations({ overrides: [] }, files, spec);

      for (const module of spec.dynamic)
        expect(found).toContain(dynamicLine(spec.sample, module));
    });

    it.each(['warn', 'off'])(
      `${spec.id} controle negativo: com a regra do import dinâmico como %s, a conferência reprova`,
      (severity) => {
        const found = dynamicViolations(
          withSeverity(goodDynamic(spec), severity, DYNAMIC_RULE),
          files,
          spec,
        );

        for (const module of spec.dynamic)
          expect(found).toContain(dynamicLine(spec.sample, module));
      },
    );

    it(`${spec.id} controle negativo: com um módulo a menos na lista da regra, a conferência reprova esse módulo`, () => {
      const [dropped] = spec.dynamic as [string];

      const found = dynamicViolations(
        withoutDynamicModule(goodDynamic(spec), dropped),
        files,
        spec,
      );

      expect(found).toContain(dynamicLine(spec.sample, dropped));
      for (const module of spec.dynamic.slice(1))
        expect(found).not.toContain(dynamicLine(spec.sample, module));
    });

    it(`${spec.id} controle negativo: uma exceção a mais na regra do import dinâmico reprova, em todos os módulos`, () => {
      const found = dynamicViolations(
        withOverride(goodDynamic(spec), {
          files: [spec.sample],
          rules: { [DYNAMIC_RULE]: 'off' },
        }),
        files,
        spec,
      );

      expect(found).toEqual(
        spec.dynamic.map((module) => dynamicLine(spec.sample, module)),
      );
    });

    it(`${spec.id} controle negativo: um arquivo da lista que a regra do import dinâmico ainda trava reprova`, () => {
      const [exempt] = spec.allowed as [string];

      const found = dynamicViolations(
        withoutException(goodDynamic(spec), exempt),
        files,
        spec,
      );

      expect(found).toEqual(
        spec.dynamic.map(
          (module) =>
            `${exempt} (exceção do ${spec.id}) não pode importar dinamicamente ${module}`,
        ),
      );
    });
  },
);

// A19: os testes de .claude/ entram no FND-13, e as cópias do repositório dos agentes ficam de fora.
describe('FND-13 a leitura dos testes de .claude/', () => {
  const spec = SPECS.find((candidate) => candidate.id === 'FND-13') as Spec;
  const files = specFiles(spec);

  it('FND-13 a conferência lê os *.test.ts de .claude/ e nenhuma cópia em .claude/worktrees/ (controle positivo)', () => {
    expect(files).toEqual(
      expect.arrayContaining([
        '.claude/hooks/subagent-stop.test.ts',
        '.claude/hooks/path-guard.test.ts',
        '.claude/hooks/format-edited.test.ts',
        '.claude/hooks/subagent-start.test.ts',
      ]),
    );
    expect(
      files.filter((file) => file.startsWith('.claude/worktrees/')),
    ).toEqual([]);
  });

  it('FND-13 o .oxlintrc.json reprova o spawnSync nos testes de .claude/ (a pasta entra no critério)', () => {
    for (const file of files.filter((name) => name.startsWith('.claude/')))
      for (const use of spec.restricted)
        expect(isRestricted(config, file, use), `${file} ${use.name}`).toBe(
          true,
        );
  });

  it('FND-13 controle negativo: sem a pasta .claude/ nos globs, a conferência reprova os testes de .claude/', () => {
    const narrow: OxlintConfig = {
      overrides: [
        {
          files: ['test/repo/**/*.ts', 'test/helpers/**/*.ts'],
          rules: {
            [RULE]: ['error', { paths: pathsOf(spec.restricted) }],
          },
        },
        { files: spec.allowed, rules: { [RULE]: 'off' } },
      ],
    };

    const found = violations(narrow, files, spec);

    expect(found).toContain(
      '.claude/hooks/subagent-stop.test.ts pode importar spawnSync de node:child_process',
    );
  });

  it('FND-13 controle negativo: run-node.ts é a única exceção, e uma exceção a mais em .claude/ reprova', () => {
    const found = violations(
      withOverride(
        {
          overrides: [
            {
              files: spec.globs,
              rules: {
                [RULE]: ['error', { paths: pathsOf(spec.restricted) }],
              },
            },
            { files: spec.allowed, rules: { [RULE]: 'off' } },
          ],
        },
        { files: ['.claude/**/*.test.ts'], rules: { [RULE]: 'off' } },
      ),
      files,
      spec,
    );

    expect(found).toContain(
      '.claude/hooks/subagent-stop.test.ts pode importar spawnSync de node:child_process',
    );
  });
});
