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
  restricted: ImportUse[];
  // O que as pastas já importam do mesmo módulo e continua livre.
  free: ImportUse[];
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
      { module: 'testcontainers', name: 'GenericContainer' },
      { module: 'testcontainers', name: 'DockerComposeEnvironment' },
    ],
    free: [
      { module: 'testcontainers', name: 'StartedDockerComposeEnvironment' },
      { module: 'testcontainers', name: 'getContainerRuntimeClient' },
    ],
  },
  {
    id: 'FND-13',
    globs: ['test/repo/**/*.ts', 'test/helpers/**/*.ts'],
    roots: ['test/repo', 'test/helpers'],
    allowed: ['test/helpers/run-node.ts'],
    sample: 'test/repo/formatter.test.ts',
    restricted: [
      { module: 'node:child_process', name: 'spawnSync' },
      { module: 'node:child_process', name: 'execSync' },
      { module: 'node:child_process', name: 'execFileSync' },
    ],
    free: [
      { module: 'node:child_process', name: 'execFile' },
      { module: 'node:child_process', name: 'spawn' },
    ],
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

function effectiveSetting(config: OxlintConfig, file: string): unknown {
  let setting = config.rules?.[RULE];
  for (const override of config.overrides ?? []) {
    const matches = (override.files ?? []).some((glob) =>
      globToRegExp(glob).test(file),
    );
    if (matches && override.rules && RULE in override.rules)
      setting = override.rules[RULE];
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

// Uma frase por defeito: arquivo fora da lista que pode importar, arquivo da lista que a regra ainda trava, ou
// import livre que a regra trava.
function violations(
  config: OxlintConfig,
  files: readonly string[],
  spec: Spec,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    const allowed = spec.allowed.includes(file);
    for (const use of spec.restricted) {
      const restricted = isRestricted(config, file, use);
      if (!allowed && !restricted)
        found.push(`${file} pode importar ${use.name} de ${use.module}`);
      if (allowed && restricted)
        found.push(
          `${file} (exceção do ${spec.id}) não pode importar ${use.name}`,
        );
    }
    for (const use of spec.free)
      if (isRestricted(config, file, use))
        found.push(`${file} não pode importar ${use.name} de ${use.module}`);
  }
  return found;
}

function filesUnder(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return filesUnder(path);
      return entry.name.endsWith('.ts') ? [path] : [];
    },
  );
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

function withSeverity(source: OxlintConfig, severity: string): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? []) {
    const setting = override.rules?.[RULE];
    if (
      override.rules &&
      Array.isArray(setting) &&
      severityOf(setting) === 'error'
    )
      override.rules[RULE] = [severity, ...(setting as unknown[]).slice(1)];
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
    const files = spec.roots.flatMap(filesUnder).sort();
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
  },
);
