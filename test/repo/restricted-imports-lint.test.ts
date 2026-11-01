import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, writeFileIn } from '../helpers/git-sandbox.ts';
import { newLintTree, oxlintBin } from '../helpers/lint-tree.ts';
import { runCommand } from '../helpers/run-node.ts';

// FND-13 ("Ligação do lint") e FND-14: o oxlint de verdade, com o .oxlintrc.json do projeto, numa árvore temporária
// (newLintTree: links para a configuração e para o plugin, nada escrito no repositório). Complementa
// test/repo/restricted-imports.test.ts, que lê a configuração como dado: lá a conferência pode errar a leitura dos
// `files` ou das opções; aqui o que reprova ou passa é o que o oxlint decide. Cada pasta restrita recebe, por módulo
// restrito, o import por nome, o padrão, o de namespace e o dinâmico; as exceções recebem o que liberam e o que não.
// Uma execução só sobre todas as amostras (cada oxlint é um processo); a saída é lida por arquivo e por linha.

const STATIC_RULE = /no-restricted-imports/;
const DYNAMIC_RULE = /no-restricted-dynamic-import/;
// Regra do núcleo sempre ligada: prova que o oxlint leu a amostra (o arquivo não ficou de fora por ignore ou caminho).
const CANARY_RULE = /no-debugger/;

interface Module {
  name: string;
  // Os nomes que o critério trava por nome; o resto do módulo é livre.
  restricted: string[];
  free: string[];
}

const CHILD: Module = {
  name: 'node:child_process',
  restricted: ['spawnSync', 'execSync', 'execFileSync'],
  free: ['spawn', 'execFile'],
};
const CONTAINERS: Module = {
  name: 'testcontainers',
  restricted: ['GenericContainer', 'DockerComposeEnvironment'],
  free: ['StartedDockerComposeEnvironment', 'getContainerRuntimeClient'],
};
const POSTGRES: Module = {
  name: '@testcontainers/postgresql',
  restricted: ['PostgreSqlContainer'],
  free: [],
};

interface Sample {
  file: string;
  // Módulos cujos imports restritos têm de reprovar neste arquivo.
  blocks: Module[];
  // Módulos cujos imports restritos têm de passar neste arquivo (a exceção libera).
  allows: Module[];
}

const SAMPLES: Sample[] = [
  { file: 'test/repo/amostra.test.ts', blocks: [CHILD], allows: [] },
  {
    file: 'test/helpers/amostra.ts',
    blocks: [CHILD, CONTAINERS, POSTGRES],
    allows: [],
  },
  {
    file: 'test/integration/area/amostra.test.ts',
    blocks: [CONTAINERS, POSTGRES],
    allows: [],
  },
  // A19: os testes de .claude/ entram no critério.
  { file: '.claude/hooks/amostra.test.ts', blocks: [CHILD], allows: [] },
  // As exceções: o que a exceção libera passa, e o resto da pasta continua travado.
  {
    file: 'test/helpers/run-node.ts',
    blocks: [CONTAINERS, POSTGRES],
    allows: [CHILD],
  },
  ...[
    'test/helpers/compose.ts',
    'test/helpers/elasticmq-container.ts',
    'test/helpers/migration-database.ts',
  ].map((file) => ({ file, blocks: [CHILD], allows: [CONTAINERS, POSTGRES] })),
  ...[
    'test/integration/global-setup.ts',
    'test/integration/foundation/container-shutdown.test.ts',
    'test/integration/foundation/api-fuzz-negative-control.test.ts',
  ].map((file) => ({
    file,
    blocks: [],
    allows: [CHILD, CONTAINERS, POSTGRES],
  })),
  // Controle: fora das pastas do critério nada é travado.
  {
    file: 'lib/amostra.ts',
    blocks: [],
    allows: [CHILD, CONTAINERS, POSTGRES],
  },
];

type Expectation = 'static' | 'dynamic' | 'pass';

interface Line {
  text: string;
  // O que o oxlint tem de dizer nesta linha, e a frase que descreve a forma no defeito.
  expected: Expectation;
  label: string;
}

// Uma linha por forma, cada uma com o nome local próprio (`unicorn`/`no-redeclare` não confundem as formas).
function linesFor(sample: Sample): Line[] {
  const lines: Line[] = [
    { text: 'debugger;', expected: 'pass', label: 'canário' },
  ];
  let id = 0;
  const add = (text: string, expected: Expectation, label: string) =>
    lines.push({ text, expected, label });
  const forms = (module: Module, blocked: boolean) => {
    const staticRule: Expectation = blocked ? 'static' : 'pass';
    const dynamicRule: Expectation = blocked ? 'dynamic' : 'pass';
    for (const name of module.restricted) {
      id += 1;
      add(
        `import { ${name} as named${id} } from '${module.name}';`,
        staticRule,
        `import por nome de ${name} de ${module.name}`,
      );
    }
    id += 1;
    add(
      `import default${id} from '${module.name}';`,
      staticRule,
      `import padrão de ${module.name}`,
    );
    id += 1;
    add(
      `import * as namespace${id} from '${module.name}';`,
      staticRule,
      `import de namespace de ${module.name}`,
    );
    id += 1;
    add(
      `const dynamic${id} = await import('${module.name}');`,
      dynamicRule,
      `import dinâmico de ${module.name}`,
    );
  };
  for (const module of sample.blocks) forms(module, true);
  for (const module of sample.allows) forms(module, false);
  for (const module of [...sample.blocks, ...sample.allows]) {
    for (const name of module.free) {
      id += 1;
      add(
        `import { ${name} as free${id} } from '${module.name}';`,
        'pass',
        `import por nome de ${name} de ${module.name} (livre)`,
      );
    }
  }
  return lines;
}

interface Diagnostic {
  code: string;
  filename: string;
  message: string;
  labels?: { span?: { line?: number } }[];
}

interface Report {
  tree: string;
  byFile: Map<string, Map<number, string[]>>;
  stdout: string;
}

let cached: Report | undefined;

// Roda o oxlint uma vez, sobre todas as amostras, e agrupa os códigos de erro por arquivo e por linha.
function report(): Report {
  if (cached) return cached;
  const tree = newLintTree('fnd13-lint-wiring-');
  for (const sample of SAMPLES)
    writeFileIn(
      tree,
      sample.file,
      `${linesFor(sample)
        .map((line) => line.text)
        .join('\n')}\n`,
    );
  const result = runCommand(
    oxlintBin,
    [
      '-c',
      join(tree, '.oxlintrc.json'),
      '-f',
      'json',
      ...SAMPLES.map((sample) => sample.file),
    ],
    { cwd: tree },
  );
  const parsed = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  const byFile = new Map<string, Map<number, string[]>>();
  for (const diagnostic of parsed.diagnostics) {
    const line = diagnostic.labels?.[0]?.span?.line ?? 0;
    const lines =
      byFile.get(diagnostic.filename) ?? new Map<number, string[]>();
    lines.set(line, [...(lines.get(line) ?? []), diagnostic.code]);
    byFile.set(diagnostic.filename, lines);
  }
  cached = { tree, byFile, stdout: result.stdout };
  return cached;
}

// Uma frase por defeito do arquivo: a forma que devia reprovar e passou, a que devia passar e reprovou, ou a que
// reprovou pela regra errada ou mais de uma vez.
function defects(sample: Sample): string[] {
  const lines = report().byFile.get(sample.file) ?? new Map<number, string[]>();
  const found: string[] = [];
  linesFor(sample).forEach((line, index) => {
    const codes = lines.get(index + 1) ?? [];
    const restricting = codes.filter(
      (code) => STATIC_RULE.test(code) || DYNAMIC_RULE.test(code),
    );
    const where = `${sample.file}:${index + 1} ${line.label}`;
    if (line.label === 'canário') {
      if (!codes.some((code) => CANARY_RULE.test(code)))
        found.push(`${where}: o oxlint não leu a amostra`);
      return;
    }
    if (line.expected === 'pass') {
      if (restricting.length > 0)
        found.push(
          `${where}: devia passar e reprovou (${restricting.join(', ')})`,
        );
      return;
    }
    const wanted = line.expected === 'static' ? STATIC_RULE : DYNAMIC_RULE;
    if (restricting.length !== 1 || !wanted.test(restricting[0] ?? ''))
      found.push(
        `${where}: devia reprovar uma vez pela regra ${wanted.source} e deu [${restricting.join(', ')}]`,
      );
  });
  return found;
}

afterAll(cleanupTempDirs);

describe('FND-13 e FND-14 o oxlint com o .oxlintrc.json do projeto, numa árvore temporária', () => {
  it.each(
    SAMPLES.filter(
      (sample) => sample.blocks.length > 0 && sample.allows.length === 0,
    ),
  )(
    'FND-13 e FND-14 em $file o import por nome, o padrão, o de namespace e o dinâmico de cada módulo restrito reprovam, e os nomes livres passam',
    (sample) => {
      expect(defects(sample)).toEqual([]);
    },
  );

  it.each(
    SAMPLES.filter(
      (sample) => sample.allows.length > 0 && sample.file !== 'lib/amostra.ts',
    ),
  )(
    'FND-13 e FND-14 na exceção $file o que ela libera passa, e o que ela não libera reprova',
    (sample) => {
      expect(defects(sample)).toEqual([]);
    },
  );

  it('FND-13 controle negativo: fora das pastas do critério (lib/) nenhum import é travado', () => {
    const [control] = SAMPLES.filter(
      (sample) => sample.file === 'lib/amostra.ts',
    );

    expect(defects(control as Sample)).toEqual([]);
  });

  it('FND-13 controle positivo: o oxlint reprovou ao menos um import restrito (a leitura da saída enxerga as linhas)', () => {
    const lines = report().byFile.get('test/repo/amostra.test.ts');

    expect(lines).toBeDefined();
    expect(
      [...(lines?.values() ?? [])]
        .flat()
        .filter((code) => STATIC_RULE.test(code)).length,
    ).toBeGreaterThan(0);
  });
});
