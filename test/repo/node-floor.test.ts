import { execFile } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runCompose } from '../helpers/compose.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';

// FND-12: a versão do Node é imposta, não só declarada (AD-011). O `devEngines.runtime` com `onFail: error` faz o
// npm parar abaixo do piso, e a perna do piso do CI deixa de fora só os testes que sobem o `docker compose`, porque a
// imagem tem o Node do Dockerfile nas duas pernas.

const execFileAsync = promisify(execFile);

interface DevEnginesRuntime {
  name?: unknown;
  version?: unknown;
  onFail?: unknown;
}

interface Pkg {
  engines?: { node?: string };
  devEngines?: { runtime?: DevEnginesRuntime | DevEnginesRuntime[] };
}

interface Step {
  name?: string;
  if?: string;
  run?: string;
}

interface Job {
  strategy?: { matrix?: { node?: string[] } };
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
}

const realPkg = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
) as Pkg;
const realWorkflow = parse(
  readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
) as Workflow;

function floorOf(pkg: Pkg): string {
  return (pkg.engines?.node ?? '').replace(/^>=\s*/, '');
}

// --- devEngines -------------------------------------------------------------------------------------------------

// Cada conferência devolve as violações; a lista vazia é o que o package.json deve ter.
function devEnginesViolations(pkg: Pkg): string[] {
  const runtime = pkg.devEngines?.runtime;
  if (runtime === undefined) return ['devEngines.runtime ausente'];
  if (Array.isArray(runtime) || typeof runtime !== 'object')
    return ['devEngines.runtime não é um objeto'];
  const violations: string[] = [];
  if (runtime.name !== 'node')
    violations.push(
      `devEngines.runtime.name é ${JSON.stringify(runtime.name)}, e não "node"`,
    );
  if (
    typeof pkg.engines?.node !== 'string' ||
    runtime.version !== pkg.engines.node
  ) {
    violations.push(
      `devEngines.runtime.version é ${JSON.stringify(runtime.version)}, e não o engines.node ${JSON.stringify(pkg.engines?.node)}`,
    );
  }
  if (runtime.onFail !== 'error')
    violations.push(
      `devEngines.runtime.onFail é ${JSON.stringify(runtime.onFail)}, e não "error"`,
    );
  return violations;
}

// --- testes que sobem o docker compose --------------------------------------------------------------------------

// Achados pelo código-fonte, e não por uma lista fixa, para um teste de compose novo entrar sozinho: o ambiente do
// Testcontainers, o helper `upComposeProject` (test/helpers/compose.ts, que embrulha o ambiente) ou o comando
// `docker compose` rodado como processo. Uma menção em comentário não conta, e importar o helper sem chamar
// `upComposeProject(` também não: só quem sobe o projeto precisa da imagem do Dockerfile.
const COMPOSE_USAGE = [
  /\bDockerComposeEnvironment\b/,
  /\bupComposeProject\s*\(/,
  /['"`]docker['"`]\s*,\s*\[\s*['"`]compose['"`]/,
  /\b(?:exec|execFile|execSync|execFileSync|spawn|spawnSync)\w*\(\s*['"`]docker compose\b/,
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(path);
    return entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function composeTestsUnder(baseDir: string): string[] {
  return testFilesUnder(join(baseDir, 'test', 'integration'))
    .filter((file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      return COMPOSE_USAGE.some((pattern) => pattern.test(source));
    })
    .map((file) => relative(baseDir, file).split('\\').join('/'))
    .sort();
}

// --- o comando de teste de cada perna do CI ---------------------------------------------------------------------

// Avalia só as formas que o ci.yml usa na perna: `matrix.node == 'x'` (ou `!=`), a ternária `cond && 'a' || 'b'` do
// GitHub (onde 'a' vazio é falso) e `matrix.node`. Qualquer outra forma com `matrix.` quebra o teste com uma mensagem
// clara, em vez de passar sem conferir.
function conditionHolds(expression: string | undefined, leg: string): boolean {
  if (expression === undefined) return true;
  const bare = expression.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
  const match = /^matrix\.node\s*(==|!=)\s*'([^']*)'$/.exec(bare);
  if (match === null)
    throw new Error(`condição de step não suportada pelo teste: ${expression}`);
  return (match[1] === '==') === (leg === match[2]);
}

function evaluate(expression: string, leg: string): string {
  if (/^matrix\.node$/.test(expression)) return leg;
  const ternary =
    /^matrix\.node\s*(==|!=)\s*'([^']*)'\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'$/.exec(
      expression,
    );
  if (ternary === null)
    throw new Error(
      `expressão da matriz não suportada pelo teste: ${expression}`,
    );
  const holds = (ternary[1] === '==') === (leg === ternary[2]);
  const whenTrue = ternary[3] ?? '';
  return holds && whenTrue !== '' ? whenTrue : (ternary[4] ?? '');
}

function interpolate(run: string, leg: string): string {
  return run.replace(
    /\$\{\{\s*([\s\S]*?)\s*\}\}/g,
    (whole: string, expression: string) =>
      expression.includes('matrix.') ? evaluate(expression, leg) : whole,
  );
}

// AI-42: a matriz vive no job `test`; o `checks` roda uma vez e o `ci-ok` só agrega.
function matrixJob(workflow: Workflow): Job | undefined {
  return workflow.jobs?.test;
}

const IS_TEST_RUN = /^\s*npm\s+(?:run\s+)?test(?:\s|$)/;

// O comando de teste que a perna roda de fato, depois de avaliar os `if` e as expressões da matriz.
function effectiveTestCommands(workflow: Workflow, leg: string): string[] {
  return (matrixJob(workflow)?.steps ?? [])
    .filter(
      (step) =>
        IS_TEST_RUN.test(step.run ?? '') && conditionHolds(step.if, leg),
    )
    .map((step) => interpolate(step.run ?? '', leg).trim());
}

function tokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
}

function excludesOf(command: string): string[] {
  const all = tokens(command);
  const found: string[] = [];
  all.forEach((token, index) => {
    if (token.startsWith('--exclude='))
      found.push(token.slice('--exclude='.length));
    else if (token === '--exclude') found.push(all[index + 1] ?? '');
  });
  return found.map((path) => path.replace(/^\.\//, '')).sort();
}

// Os argumentos de relatório do passo de teste: o json alimenta a tabela (AI-18) e o github-actions anota a falha
// no diff (AI-42).
const REPORTER_ARGS = [
  '--reporter=default',
  '--reporter=github-actions',
  '--reporter=json',
  // Entre aspas: o shellcheck do actionlint (AI-43) reprova a variável sem aspas (SC2086).
  '--outputFile.json="$RUNNER_TEMP/vitest-report.json"',
];

// AI-37: a cobertura de src/ é medida uma vez só, na perna nvmrc. AI-49: o `json-summary` é o que o
// check-baselines lê, gravado em `$RUNNER_TEMP/coverage` (fora da árvore do repositório, entre aspas pelo SC2086); o
// `text` mantém o resumo no log, já que passar um reporter na linha de comando troca os padrões do Vitest.
const COVERAGE_ARGS = [
  '--coverage',
  '--coverage.reporter=text',
  '--coverage.reporter=json-summary',
  '--coverage.reportsDirectory="$RUNNER_TEMP/coverage"',
];

// Tira `--exclude=<arquivo>` e o par `--exclude <arquivo>`; o que sobra é o resto do comando.
function withoutExcludes(all: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < all.length; index += 1) {
    const token = all[index] ?? '';
    if (token === '--exclude') index += 1;
    else if (!token.startsWith('--exclude=')) kept.push(token);
  }
  return kept;
}

// O comando tem de ser, token a token, `npm test --` mais os argumentos de relatório, em qualquer ordem.
// AI-37 e AI-49: só a perna nvmrc acrescenta os argumentos de cobertura; a do piso não mede cobertura.
function closedArgsViolation(rest: string[], leg: string): string | null {
  const prefix = ['npm', 'test', '--'];
  if (JSON.stringify(rest.slice(0, prefix.length)) !== JSON.stringify(prefix))
    return 'não começa por `npm test --`';
  const args = rest.slice(prefix.length);
  const allowed =
    leg === 'nvmrc' ? [...REPORTER_ARGS, ...COVERAGE_ARGS] : REPORTER_ARGS;
  const expected = [...allowed].sort();
  if (JSON.stringify([...args].sort()) !== JSON.stringify(expected)) {
    return `argumentos ${JSON.stringify(args)} fora da lista fechada ${JSON.stringify(expected)}`;
  }
  return null;
}

function ciViolations(
  workflow: Workflow,
  pkg: Pkg,
  composeTests: string[],
): string[] {
  const matrix = matrixJob(workflow)?.strategy?.matrix?.node ?? [];
  const floor = floorOf(pkg);
  const violations: string[] = [];
  if (!matrix.includes('nvmrc'))
    violations.push('a matriz não tem a perna nvmrc');
  if (floor === '' || !matrix.includes(floor))
    violations.push(`a matriz não tem a perna do piso ${floor}`);

  for (const leg of ['nvmrc', floor]) {
    const commands = effectiveTestCommands(workflow, leg);
    if (commands.length !== 1) {
      violations.push(
        `perna ${leg}: ${commands.length} comandos de teste efetivos, esperado 1`,
      );
      continue;
    }
    const command = commands[0] ?? '';
    for (const arg of REPORTER_ARGS) {
      if (!tokens(command).includes(arg))
        violations.push(`perna ${leg}: falta o argumento ${arg}`);
    }
    // Lista fechada: depois de tirar os pares --exclude (que a perna do piso pode ter), sobra `npm test --` e os
    // argumentos de relatório, nada mais. Um `--project`, um filtro posicional ou um `-t` deixaria de rodar testes.
    const closed = closedArgsViolation(withoutExcludes(tokens(command)), leg);
    if (closed !== null) violations.push(`perna ${leg}: ${closed}: ${command}`);
    const excludes = excludesOf(command);
    if (leg === 'nvmrc') {
      if (command.includes('--exclude'))
        violations.push(`perna nvmrc: roda com --exclude: ${command}`);
    } else if (
      JSON.stringify(excludes) !== JSON.stringify([...composeTests].sort())
    ) {
      violations.push(
        `perna ${leg}: exclui ${JSON.stringify(excludes)}, esperado ${JSON.stringify([...composeTests].sort()).toString()}`,
      );
    }
  }
  return violations;
}

// --- linhas de base em memória ----------------------------------------------------------------------------------

const COMPOSE_A = 'test/integration/foundation/compose.test.ts';
const COMPOSE_B = 'test/integration/billing/worker-compose.test.ts';
// Em ordem alfabética, a mesma que o detector (composeTestsUnder) promete.
const BASE_COMPOSE = [COMPOSE_A, COMPOSE_B].sort();

const BASE_PKG: Pkg = {
  engines: { node: '>=24.12.0' },
  devEngines: {
    runtime: { name: 'node', version: '>=24.12.0', onFail: 'error' },
  },
};

const REPORTER =
  '--reporter=default --reporter=github-actions --reporter=json --outputFile.json="$RUNNER_TEMP/vitest-report.json"';

const COVERAGE = COVERAGE_ARGS.join(' ');

// Forma 1: um passo, com o argumento condicionado pela matriz.
const ONE_STEP = `
jobs:
  test:
    strategy:
      matrix:
        node: [nvmrc, '24.12.0']
    steps:
      - run: npm ci
      - run: >-
          npm test -- \${{ matrix.node == '24.12.0' && '--exclude ${COMPOSE_A} --exclude ${COMPOSE_B}' || '' }}
          ${REPORTER} \${{ matrix.node == 'nvmrc' && '${COVERAGE}' || '' }}
`;

// Forma 2: dois passos, cada um com o seu `if`.
const TWO_STEPS = `
jobs:
  test:
    strategy:
      matrix:
        node: [nvmrc, '24.12.0']
    steps:
      - run: npm ci
      - if: matrix.node == 'nvmrc'
        run: npm test -- ${REPORTER} ${COVERAGE}
      - if: \${{ matrix.node != 'nvmrc' }}
        run: npm test -- --exclude=${COMPOSE_A} --exclude=${COMPOSE_B} ${REPORTER}
`;

function variant(yamlText: string, edit: (text: string) => string): Workflow {
  return parse(edit(yamlText)) as Workflow;
}

// Acrescenta `extra` a cada perna, nas duas formas, e devolve os casos que NÃO reprovaram (o esperado é nenhum).
// `only` escolhe os casos pelo nome.
function escapedWith(
  extras: string[],
  only: (caseName: string) => boolean,
): string[] {
  const escaped: string[] = [];
  for (const extra of extras) {
    const cases: Record<string, Workflow> = {
      'um passo, perna nvmrc': variant(ONE_STEP, (t) =>
        t.replace(`'${COVERAGE}'`, `'${COVERAGE} ${extra}'`),
      ),
      'um passo, perna do piso': variant(ONE_STEP, (t) =>
        t.replace(
          `--exclude ${COMPOSE_B}'`,
          `--exclude ${COMPOSE_B} ${extra}'`,
        ),
      ),
      'dois passos, perna nvmrc': variant(TWO_STEPS, (t) =>
        t.replace(
          `run: npm test -- ${REPORTER}`,
          `run: npm test -- ${extra} ${REPORTER}`,
        ),
      ),
      'dois passos, perna do piso': variant(TWO_STEPS, (t) =>
        t.replace(
          `--exclude=${COMPOSE_B} ${REPORTER}`,
          `--exclude=${COMPOSE_B} ${extra} ${REPORTER}`,
        ),
      ),
    };
    for (const [name, workflow] of Object.entries(cases)) {
      if (
        only(name) &&
        ciViolations(workflow, BASE_PKG, BASE_COMPOSE).length === 0
      )
        escaped.push(`${name} com "${extra}"`);
    }
  }
  return escaped;
}

function pkgWith(runtime: Record<string, unknown> | undefined): Pkg {
  const copy = structuredClone(BASE_PKG);
  if (runtime === undefined) delete copy.devEngines;
  else copy.devEngines = { runtime };
  return copy;
}

// --- testes -----------------------------------------------------------------------------------------------------

describe('FND-12 o package.json impõe o piso do Node pelo devEngines', () => {
  it('FND-12 o devEngines.runtime é node, na versão do engines.node, com onFail error', () => {
    expect(devEnginesViolations(realPkg)).toEqual([]);
  });

  it('FND-12 controle negativo: outra faixa, onFail warn ou devEngines ausente reprovam; a base passa', () => {
    expect(devEnginesViolations(BASE_PKG)).toEqual([]);
    expect(
      devEnginesViolations(
        pkgWith({ name: 'node', version: '>=24.0.0', onFail: 'error' }),
      ),
    ).not.toEqual([]);
    expect(
      devEnginesViolations(
        pkgWith({ name: 'node', version: '>=24.12.0', onFail: 'warn' }),
      ),
    ).not.toEqual([]);
    expect(
      devEnginesViolations(pkgWith({ name: 'node', version: '>=24.12.0' })),
    ).not.toEqual([]);
    expect(
      devEnginesViolations(
        pkgWith({ name: 'bun', version: '>=24.12.0', onFail: 'error' }),
      ),
    ).not.toEqual([]);
    expect(devEnginesViolations(pkgWith(undefined))).not.toEqual([]);
    // A forma em lista não é a do critério: o runtime é um objeto.
    const asList: Pkg = {
      ...BASE_PKG,
      devEngines: {
        runtime: [{ name: 'node', version: '>=24.12.0', onFail: 'error' }],
      },
    };
    expect(devEnginesViolations(asList)).not.toEqual([]);
  });

  it('FND-12 abaixo do piso, npm run para com EBADDEVENGINES (o devEngines do repositório, com uma faixa que este Node não cumpre)', async () => {
    // Antes de gastar um processo: o campo do repositório tem de estar certo, senão o teste mediria outra coisa.
    expect(devEnginesViolations(realPkg)).toEqual([]);
    const runtime = realPkg.devEngines?.runtime as DevEnginesRuntime;

    const dir = mkdtempSync(join(tmpdir(), 'node-floor-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'node-floor-probe',
          version: '0.0.0',
          private: true,
          scripts: { probe: 'node -e 0' },
          devEngines: { runtime: { ...runtime, version: '>=999.0.0' } },
        }),
      );
      // Sem as variáveis npm_* do processo que roda este teste, o npm filho lê só o package.json da pasta.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.toLowerCase().startsWith('npm_'),
        ),
      );
      const result = await execFileAsync('npm', ['run', 'probe'], {
        cwd: dir,
        env,
        timeout: 60_000,
      }).then(
        () => ({ code: 0, output: '' }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          code: typeof error.code === 'number' ? error.code : 1,
          output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
        }),
      );
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('EBADDEVENGINES');
      // O critério pede a versão atual e a exigida na mensagem.
      expect(result.output).toContain('>=999.0.0');
      expect(result.output).toContain(process.versions.node);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('FND-12 os testes que sobem o docker compose são achados pelo código-fonte', () => {
  it('FND-12 o detector acha os testes de compose do repositório e nenhum outro de test/integration/', () => {
    expect(composeTestsUnder(root)).toEqual(BASE_COMPOSE);
  });

  it('FND-12 controle negativo: o detector acha um teste de compose novo e ignora comentário e outros testes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'node-floor-detector-'));
    try {
      const write = (path: string, content: string) => {
        mkdirSync(join(dir, path, '..'), { recursive: true });
        writeFileSync(join(dir, path), content);
      };
      write(
        'test/integration/a/env.test.ts',
        "import { DockerComposeEnvironment } from 'testcontainers';\n",
      );
      write(
        'test/integration/b/cli.test.ts',
        "await execFileAsync('docker', ['compose', 'up', '-d']);\n",
      );
      write(
        'test/integration/c/comment.test.ts',
        '// sobe o `docker compose` e usa a DockerComposeEnvironment\nexport {};\n',
      );
      write(
        'test/integration/d/plain.test.ts',
        "import { PostgreSqlContainer } from '@testcontainers/postgresql';\n",
      );
      // O helper de compose: chamar `upComposeProject(` conta; importá-lo (ou só o `runCompose`) sem subir não conta.
      write(
        'test/integration/e/helper.test.ts',
        "import { upComposeProject } from '../../helpers/compose.ts';\nawait upComposeProject('p', 'logs', async () => '');\n",
      );
      write(
        'test/integration/f/import-only.test.ts',
        "import { runCompose, upComposeProject } from '../../helpers/compose.ts';\nexport const unused = [runCompose, upComposeProject];\n",
      );
      write(
        'test/integration/g/helper-comment.test.ts',
        '// chama upComposeProject( para subir\nexport {};\n',
      );
      write(
        'test/repo/outside.test.ts',
        "import { DockerComposeEnvironment } from 'testcontainers';\n",
      );
      expect(composeTestsUnder(dir)).toEqual([
        'test/integration/a/env.test.ts',
        'test/integration/b/cli.test.ts',
        'test/integration/e/helper.test.ts',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // O detector só enxerga `upComposeProject(`. Um teste que subisse o projeto por `runCompose(p, ['up', …])` escaparia
  // dele e rodaria na perna do piso, sem a imagem do Dockerfile. Por isso o helper recusa o `up`: subir o projeto
  // só é possível por quem o detector acha. A recusa vem antes de qualquer chamada ao Docker.
  it.each([[['up', '-d']], [['--profile', 'app', 'up', '--wait']], [['up']]])(
    'FND-12 controle negativo: o runCompose recusa %j, então o up só passa por upComposeProject, que o detector acha',
    async (args) => {
      await expect(runCompose('node-floor-control', args)).rejects.toThrow(
        /upComposeProject/,
      );
    },
  );
});

describe('FND-12 a perna do piso do CI exclui só os testes que sobem o docker compose', () => {
  it('FND-12 no ci.yml, a perna nvmrc roda a suíte inteira e a do piso exclui exatamente os testes de compose', () => {
    expect(
      ciViolations(realWorkflow, realPkg, composeTestsUnder(root)),
    ).toEqual([]);
  });

  it('FND-12 as duas formas aceitas (um passo com argumento da matriz, ou dois passos com if) passam na base', () => {
    for (const text of [ONE_STEP, TWO_STEPS]) {
      const workflow = parse(text) as Workflow;
      expect(effectiveTestCommands(workflow, 'nvmrc')).toHaveLength(1);
      expect(effectiveTestCommands(workflow, '24.12.0')).toHaveLength(1);
      expect(ciViolations(workflow, BASE_PKG, BASE_COMPOSE)).toEqual([]);
    }
  });

  it('FND-12 controle negativo: a perna do piso que exclui outro arquivo, ou esquece um de compose, reprova', () => {
    for (const text of [ONE_STEP, TWO_STEPS]) {
      const extra = variant(text, (t) =>
        t
          .replace(
            `--exclude ${COMPOSE_B}'`,
            `--exclude ${COMPOSE_B} --exclude src/app.test.ts'`,
          )
          .replace(
            `--exclude=${COMPOSE_B} `,
            `--exclude=${COMPOSE_B} --exclude=src/app.test.ts `,
          ),
      );
      expect(ciViolations(extra, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);

      const missing = variant(text, (t) =>
        t
          .replace(` --exclude ${COMPOSE_B}`, '')
          .replace(` --exclude=${COMPOSE_B}`, ''),
      );
      expect(ciViolations(missing, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);

      const noExclude = variant(text, (t) =>
        t
          .replaceAll(` --exclude ${COMPOSE_A}`, '')
          .replaceAll(` --exclude ${COMPOSE_B}`, '')
          .replaceAll(` --exclude=${COMPOSE_A}`, '')
          .replaceAll(` --exclude=${COMPOSE_B}`, ''),
      );
      expect(ciViolations(noExclude, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
    }
    // Um teste de compose novo no repositório, que o ci.yml ainda não exclui.
    expect(
      ciViolations(parse(ONE_STEP) as Workflow, BASE_PKG, [
        ...BASE_COMPOSE,
        'test/integration/new/new-compose.test.ts',
      ]),
    ).not.toEqual([]);
  });

  it('FND-12 controle negativo: a perna nvmrc com qualquer --exclude reprova', () => {
    const oneStep = variant(ONE_STEP, (t) =>
      t.replace("matrix.node == '24.12.0' &&", "matrix.node != 'zzz' &&"),
    );
    expect(ciViolations(oneStep, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
    const twoSteps = variant(TWO_STEPS, (t) =>
      t.replace(
        'run: npm test -- --reporter=default',
        `run: npm test -- --exclude ${COMPOSE_A} --reporter=default`,
      ),
    );
    expect(ciViolations(twoSteps, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
  });

  it('FND-12 controle negativo: argumento a mais em qualquer perna (--project, filtro posicional, -t) para de rodar testes e reprova', () => {
    const extras = [
      '--project unit',
      '--project=unit',
      'src',
      '-t slow',
      '--testNamePattern slow',
      '--testNamePattern=slow',
    ];
    // Junta todos os casos que passaram sem reprovar, para a mensagem de falha listar cada um.
    expect(escapedWith(extras, () => true)).toEqual([]);
  });

  it('FND-12 controle negativo: a perna do piso com qualquer argumento de cobertura reprova', () => {
    expect(
      escapedWith([...COVERAGE_ARGS, '--coverage.enabled=true'], (name) =>
        name.includes('piso'),
      ),
    ).toEqual([]);
  });

  it('FND-12 controle negativo: a perna nvmrc com argumento de cobertura a mais, a menos ou trocado reprova', () => {
    const extras = [
      '--coverage.thresholds.lines=0',
      '--coverage.enabled=false',
      '--coverage.reporter=lcov',
    ];
    const escaped: string[] = [];
    const variants: Record<string, (t: string) => string> = {};
    for (const extra of extras)
      variants[`a mais ${extra}`] = (t) =>
        t.replaceAll(COVERAGE, `${COVERAGE} ${extra}`);
    for (const arg of COVERAGE_ARGS)
      variants[`a menos ${arg}`] = (t) =>
        t.replaceAll(
          COVERAGE,
          COVERAGE_ARGS.filter((other) => other !== arg).join(' '),
        );
    variants['sem aspas no diretório'] = (t) =>
      t.replaceAll(
        '--coverage.reportsDirectory="$RUNNER_TEMP/coverage"',
        '--coverage.reportsDirectory=$RUNNER_TEMP/coverage',
      );
    variants['diretório dentro do repositório'] = (t) =>
      t.replaceAll(
        '--coverage.reportsDirectory="$RUNNER_TEMP/coverage"',
        '--coverage.reportsDirectory=coverage',
      );
    for (const [name, edit] of Object.entries(variants)) {
      for (const [form, base] of [
        ['um passo', ONE_STEP],
        ['dois passos', TWO_STEPS],
      ] as const) {
        if (
          ciViolations(variant(base, edit), BASE_PKG, BASE_COMPOSE).length === 0
        )
          escaped.push(`${form}, ${name}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  it('FND-12 controle negativo: o comando que não é exatamente `npm test --` seguido dos argumentos de relatório reprova', () => {
    const asRun = variant(TWO_STEPS, (t) =>
      t.replace(
        'run: npm test -- --reporter=default',
        'run: npm run test -- --reporter=default',
      ),
    );
    expect(ciViolations(asRun, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
    const noSeparator = variant(TWO_STEPS, (t) =>
      t.replace(
        'run: npm test -- --reporter=default',
        'run: npm test --reporter=default',
      ),
    );
    expect(ciViolations(noSeparator, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
  });

  it('FND-12 controle negativo: o caminho do relatório sem aspas reprova nas duas formas e em cada perna', () => {
    for (const base of [ONE_STEP, TWO_STEPS]) {
      expect(
        ciViolations(
          variant(base, (t) => t),
          BASE_PKG,
          BASE_COMPOSE,
        ),
      ).toEqual([]);
      const unquoted = variant(base, (t) =>
        t.replaceAll(
          '"$RUNNER_TEMP/vitest-report.json"',
          '$RUNNER_TEMP/vitest-report.json',
        ),
      );
      expect(ciViolations(unquoted, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
    }
  });

  it('FND-12 controle negativo: o passo de teste sem os argumentos de relatório, ou rodando duas vezes numa perna, reprova', () => {
    const noReporter = variant(TWO_STEPS, (t) =>
      t.replaceAll(` ${REPORTER}`, ''),
    );
    expect(ciViolations(noReporter, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
    const twice = variant(TWO_STEPS, (t) =>
      t.replace("if: matrix.node == 'nvmrc'", ''),
    );
    expect(ciViolations(twice, BASE_PKG, BASE_COMPOSE)).not.toEqual([]);
  });
});
