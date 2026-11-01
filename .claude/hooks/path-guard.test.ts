import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  initRepo,
  makeTempDir,
} from '../../test/helpers/git-sandbox.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);
const hook = join(root, '.claude', 'hooks', 'path-guard.mjs');

interface HookInput {
  hook_event_name: string;
  tool_name: string;
  cwd: string;
  agent_type?: string;
  tool_input: Record<string, string>;
}

// O motivo da recusa, ou null quando a edição passa.
// O terceiro parâmetro é a pasta principal (CLAUDE_PROJECT_DIR): as pastas dos hooks são conferidas contra ela
// mesmo quando a raiz das regras de papel é a worktree do agente (A1 da Revisão 1).
let decide: (
  input: HookInput,
  projectRoot: string,
  projectDir?: string,
) => string | null;
// A raiz contra a qual o caminho é decidido (AI-26): a da worktree do agente, ou a do projeto.
let rootFor: (input: { cwd?: string }, projectDir: string) => string;

// Import dinâmico: o hook é .mjs sem tipos, e assim o teste falha com "módulo inexistente" enquanto ele não existe.
beforeAll(async () => {
  const module = (await import(pathToFileURL(hook).href)) as {
    decide: typeof decide;
    rootFor: typeof rootFor;
  };
  decide = module.decide;
  rootFor = module.rootFor;
});

function editInput(agentType: string | undefined, filePath: string): HookInput {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    cwd: root,
    ...(agentType ? { agent_type: agentType } : {}),
    tool_input: { file_path: filePath },
  };
}

// A decisão dentro do processo, com a tabela inteira de casos: cada processo Node custa cerca de 75 ms.
function edit(agentType: string | undefined, filePath: string): string | null {
  return decide(editInput(agentType, filePath), root);
}

function expectDenied(reason: string | null): void {
  expect(reason).toEqual(expect.any(String));
  expect(reason).not.toBe('');
}

function expectAllowed(reason: string | null): void {
  expect(reason).toBeNull();
}

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Roda o hook como o Claude Code roda: JSON na entrada padrão e CLAUDE_PROJECT_DIR no ambiente.
// Só os testes de fiação usam isto; sem `projectDir`, o ambiente não leva CLAUDE_PROJECT_DIR.
function runHook(
  rawInput: string,
  projectDir: string | undefined = root,
  cwd?: string,
): HookResult {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (projectDir === undefined) delete env.CLAUDE_PROJECT_DIR;
  else env.CLAUDE_PROJECT_DIR = projectDir;
  const result = spawnSync(process.execPath, [hook], {
    input: rawInput,
    encoding: 'utf8',
    env,
    ...(cwd ? { cwd } : {}),
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface Denial {
  hookSpecificOutput: {
    hookEventName: string;
    permissionDecision: string;
    permissionDecisionReason: string;
  };
}

function expectProcessDenied(result: HookResult): Denial {
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout) as Denial;
  expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(output.hookSpecificOutput.permissionDecisionReason).not.toBe('');
  return output;
}

function expectProcessAllowed(result: HookResult): void {
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('');
}

// Cada caminho protegido, escrito do jeito que o criterio lista: relativo, absoluto, com `..` e em outra caixa.
const IMPLEMENTER_PROTECTED = [
  'test/integration/checkout/foo.test.ts',
  'test/helpers/clock.ts',
  'test/fixtures/dados.json',
  'src/x.test.ts',
  'src/checkout/reserve.test.ts',
  'scripts/check-spec-limits.test.ts',
  '.claude/hooks/x.test.ts',
  '.specs/features/casecellshop/spec.md',
  '.claude/agents/reviewer.md',
  'src/contract/health.ts',
  'openapi.yaml',
  'ARCHITECTURE.md',
  'AGENTS.md',
  'CLAUDE.md',
];

function variants(relative: string): [string, string][] {
  const parts = relative.split('/');
  const first = parts[0] ?? relative;
  return [
    ['relativo', relative],
    ['absoluto', join(root, relative)],
    ['com ..', `src/app/../../${relative}`],
    ['com .. no meio da raiz', `${root}/src/../${relative}`],
    ['em maiúsculas', relative.toUpperCase()],
    [
      'com a pasta em outra caixa',
      [first.toUpperCase(), ...parts.slice(1)].join('/'),
    ],
  ];
}

describe('FND-08 guarda de caminho do test-writer', () => {
  it.each([
    'test/integration/checkout/foo.test.ts',
    'test/helpers/clock.ts',
    'test/fixtures/dados.json',
    'src/x.test.ts',
    'src/checkout/reserve.test.ts',
    'scripts/check-spec-limits.test.ts',
    '.claude/hooks/x.test.ts',
  ])('FND-08 o test-writer pode editar %s', (path) => {
    for (const [, variant] of variants(path))
      expectAllowed(edit('test-writer', variant));
  });

  it.each([
    ['em outra caixa', 'Test/integration/foo.test.ts'],
    ['com .. entrando em test/', 'src/../test/helpers/clock.ts'],
    ['*.test.ts em src/ em outra caixa', 'Src/X.TEST.TS'],
    ['*.test.ts em src/ com ..', 'src/app/../x.test.ts'],
  ])('FND-08 o test-writer pode editar testes (%s)', (_label, path) => {
    expectAllowed(edit('test-writer', path));
  });

  it.each([
    'src/app.ts',
    'src/contract/health.ts',
    '.specs/features/casecellshop/spec.md',
    '.claude/hooks/path-guard.mjs',
    'openapi.yaml',
    'ARCHITECTURE.md',
    'AGENTS.md',
    'CLAUDE.md',
    'package.json',
    'compose.yaml',
    'scripts/generate-openapi.ts',
  ])(
    'FND-08 o test-writer não pode editar código que não é teste (%s)',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('test-writer', variant));
    },
  );

  it.each([
    ['com .. saindo de test/', 'test/../src/app.ts'],
    [
      'com .. saindo de test/ por caminho absoluto',
      join(root, 'test/../src/app.ts'),
    ],
    ['em pasta com o prefixo test', 'testing/foo.ts'],
    ['em pasta com o prefixo test, absoluto', join(root, 'tests/foo.ts')],
    ['em src/ em outra caixa', 'SRC/app.ts'],
    ['arquivo cujo nome só contém test', 'src/test-utils.ts'],
    ['extensão parecida', 'src/x.test.tsx'],
  ])(
    'FND-08 o test-writer não pode editar fora de test/ nem de *.test.ts (%s)',
    (_label, path) => {
      expectDenied(edit('test-writer', path));
    },
  );

  // Mesmo dentro de test/, a configuração que o AI-04 nega pelo nome também é negada ao test-writer.
  it.each([
    'test/prettier.config.mjs',
    'test/.oxlintrc.json',
    'test/vitest.config.ts',
    'test/knip.json',
    'test/.editorconfig',
    'test/.eslintignore',
    'test/package.json',
    'src/vitest.config.ts',
  ])(
    'FND-08 o test-writer não pode editar a configuração da verificação %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('test-writer', variant));
    },
  );

  it.each([
    'test/repo/x.test.ts',
    'test/helpers/x.ts',
    'src/x.test.ts',
    '.claude/hooks/x.test.ts',
    'test/fixtures/migrations/a/1_x.ts',
  ])(
    'FND-08 o test-writer continua podendo editar %s, que não é configuração',
    (path) => {
      for (const [, variant] of variants(path))
        expectAllowed(edit('test-writer', variant));
    },
  );

  it.each([
    ['absoluto fora do repositório', '/etc/hosts'],
    ['*.test.ts absoluto fora do repositório', '/etc/fora.test.ts'],
    ['relativo acima da raiz', '../fora/test/foo.test.ts'],
    [
      'em pasta irmã com o mesmo prefixo da raiz',
      `${root}-outro/test/foo.test.ts`,
    ],
    ['com .. acima da raiz', `${root}/test/../../fora/foo.test.ts`],
  ])(
    'FND-08 o test-writer não pode editar caminho fora do repositório (%s)',
    (_label, path) => {
      expectDenied(edit('test-writer', path));
    },
  );
});

describe('FND-08 guarda de caminho do implementer', () => {
  it.each(IMPLEMENTER_PROTECTED)(
    'FND-08 o implementer não pode editar %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('implementer', variant));
    },
  );

  it.each([
    ['*.test.ts em src/ em outra caixa', 'Src/X.TEST.TS'],
    ['*.test.ts em src/ em outra caixa, absoluto', join(root, 'Src/X.TEST.TS')],
    ['*.test.ts em .claude/hooks/ em outra caixa', '.Claude/Hooks/X.Test.Ts'],
    [
      '*.test.ts com .. saindo de uma pasta permitida',
      'migrations/../src/x.test.ts',
    ],
  ])('FND-08 o implementer não pode editar *.test.ts (%s)', (_label, path) => {
    expectDenied(edit('implementer', path));
  });

  it.each([
    ['em src/', 'src/app.ts'],
    ['em src/ por caminho absoluto', join(root, 'src/db/migrate.ts')],
    ['em migrations/', 'migrations/store/20260101000000_init.ts'],
    ['no compose', 'compose.yaml'],
    ['em pasta com o prefixo src/contract', 'src/contractual/foo.ts'],
    ['em pasta com o prefixo test', 'testing/foo.ts'],
    ['arquivo cujo nome só contém test', 'src/test-utils.ts'],
    ['com .. que sai de uma pasta protegida', 'test/../src/app.ts'],
  ])(
    'FND-08 o implementer pode editar fora dos testes e das pastas protegidas (%s)',
    (_label, path) => {
      expectAllowed(edit('implementer', path));
    },
  );

  it.each([
    ['absoluto fora do repositório', '/etc/hosts'],
    ['relativo acima da raiz', '../fora/src/app.ts'],
    ['em pasta irmã com o mesmo prefixo da raiz', `${root}-outro/src/app.ts`],
    ['com .. acima da raiz', `${root}/src/../../fora/app.ts`],
  ])(
    'FND-08 o implementer não pode editar caminho fora do repositório (%s)',
    (_label, path) => {
      expectDenied(edit('implementer', path));
    },
  );
});

// O que configura a verificação (AI-04): o implementer não pode afrouxar o próprio lint, CI ou testes.
const IMPLEMENTER_VERIFICATION_CONFIG = [
  '.github/workflows/ci.yml',
  'scripts/check-migrations.ts',
  'vitest.config.ts',
  'tsconfig.json',
  '.oxlintrc.json',
  'commitlint.config.mjs',
  'redocly.yaml',
  '.prettierrc.json',
  '.prettierignore',
  '.npmrc',
  '.claude/settings.json',
  'knip.json',
  '.jscpd.json',
  '.jscpd-baseline.json',
  '.editorconfig',
  'package.yaml',
];

describe('AI-04 guarda de caminho nega ao implementer o que configura a verificação', () => {
  it.each(IMPLEMENTER_VERIFICATION_CONFIG)(
    'AI-04 o implementer não pode editar %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('implementer', variant));
    },
  );

  it.each([
    'src/checkout/reserve.ts',
    'migrations/store/001_x.ts',
    'package.json',
  ])('AI-04 o implementer continua podendo editar %s', (path) => {
    for (const [, variant] of variants(path))
      expectAllowed(edit('implementer', variant));
  });

  it.each([
    '.github/workflows/ci.yml',
    'scripts/check-migrations.ts',
    '.oxlintrc.json',
  ])('AI-04 a sessão principal, sem agent_type, pode editar %s', (path) => {
    expectAllowed(edit(undefined, path));
  });
});

// Pelo nome do arquivo, em qualquer pasta (AI-04): o implementer não pode afrouxar a verificação
// escondendo a configuração dentro de src/ ou criando uma variante do arquivo.
const IMPLEMENTER_PROTECTED_BY_NAME = [
  'src/.oxlintrc.json',
  'src/a/.oxlintrc.jsonc',
  'oxlint.config.ts',
  'src/tsconfig.json',
  'tsconfig.build.json',
  'src/vitest.config.ts',
  'vite.config.ts',
  'vitest.workspace.ts',
  'commitlint.config.cjs',
  'redocly.yaml',
  '.kysely-codegenrc',
  '.kysely-codegenrc.json',
  '.kysely-codegenrc.yaml',
  '.kysely-codegenrc.js',
  'src/db/.kysely-codegenrc.json',
  'src/a/b/.kysely-codegenrc.outro',
  'src/.prettierrc.json',
  '.prettierrc',
  '.prettierrc.yaml',
  'src/a/.prettierrc.mjs',
  'prettier.config.mjs',
  'src/prettier.config.js',
  'src/.prettierignore',
  '.npmrc',
  '.nvmrc',
  '.gitignore',
  '.mcp.json',
  'src/CLAUDE.md',
  'src/CLAUDE.local.md',
  'CLAUDE.local.md',
  'src/x/AGENTS.md',
  'src/.editorconfig',
  'src/package.yaml',
  'src/knip.json',
  // O oxlint lê o .eslintignore por padrão (AI-48) e o Prettier lê a chave `prettier` de um package.json aninhado.
  '.eslintignore',
  'src/.eslintignore',
  'src/package.json',
  'src/x/package.json',
  'migrations/package.json',
];

describe('AI-04 guarda de caminho nega ao implementer a configuração pelo nome, em qualquer pasta', () => {
  it.each(IMPLEMENTER_PROTECTED_BY_NAME)(
    'AI-04 o implementer não pode editar %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('implementer', variant));
    },
  );

  it.each(IMPLEMENTER_PROTECTED_BY_NAME)(
    'AI-04 o implementer também não pode escrever %s com Write',
    (path) => {
      expectDenied(
        decide(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            cwd: root,
            agent_type: 'implementer',
            tool_input: { file_path: join(root, path), content: 'x' },
          },
          root,
        ),
      );
    },
  );

  // Controle negativo: nomes que só lembram os protegidos, e o código de produção, continuam liberados.
  it.each([
    'src/checkout/reserve.ts',
    'migrations/store/001_x.ts',
    'package.json',
    'src/oxlintrc.ts',
    'src/tsconfigs/loader.ts',
    'src/vitest-helpers.ts',
    'src/claude.ts',
    'src/agents.ts',
    'src/agents/list.ts',
    'src/gitignore-parser.ts',
    'src/mcp/server.ts',
    'src/db/types/store.ts',
    'src/db/kysely-codegenrc.ts',
    'src/db/codegen.ts',
    'src/kysely-codegen/index.ts',
    'src/shared/prettier-like.ts',
    'src/shared/knip-like.ts',
  ])('AI-04 o implementer continua podendo editar %s', (path) => {
    for (const [, variant] of variants(path))
      expectAllowed(edit('implementer', variant));
  });

  it.each(IMPLEMENTER_PROTECTED_BY_NAME)(
    'AI-04 a sessão principal, sem agent_type, pode editar %s',
    (path) => {
      expectAllowed(edit(undefined, path));
    },
  );
});

// Os hooks do git rodam nos commits e pushes da sessão principal, fora dos deny e do bash-guard (A13):
// quem os escreve executa código lá. A configuração do clone (.git/) tem o mesmo efeito.
const IMPLEMENTER_PROTECTED_GIT_HOOKS = [
  '.githooks/pre-push',
  '.githooks/commit-msg',
  '.githooks/post-commit',
  '.githooks/novo/arquivo',
  '.git/config',
  '.git/hooks/pre-commit',
];

describe('AI-04 guarda de caminho nega ao implementer os hooks do git e a configuração do clone', () => {
  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)(
    'AI-04 o implementer não pode editar %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectDenied(edit('implementer', variant));
    },
  );

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)(
    'AI-04 o implementer também não pode escrever %s com Write',
    (path) => {
      expectDenied(
        decide(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Write',
            cwd: root,
            agent_type: 'implementer',
            tool_input: { file_path: join(root, path), content: 'exit 0' },
          },
          root,
        ),
      );
    },
  );

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)(
    'AI-04 o test-writer também não pode editar %s',
    (path) => {
      expectDenied(edit('test-writer', path));
    },
  );

  // Controle negativo: nomes que só lembram as pastas protegidas seguem liberados.
  it.each(['src/githooks.ts', 'migrations/store/.gitkeep', 'src/git/x.ts'])(
    'AI-04 o implementer continua podendo editar %s',
    (path) => {
      for (const [, variant] of variants(path))
        expectAllowed(edit('implementer', variant));
    },
  );

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)(
    'AI-04 a sessão principal, sem agent_type, pode editar %s',
    (path) => {
      expectAllowed(edit(undefined, path));
    },
  );
});

// O github-guard confia no que está em .claude/reviews/ e em .claude/state/ (AI-15, AI-16): nenhuma sessão os edita,
// a principal inclusive. O NotebookEdit traz o caminho em notebook_path; Edit e Write, em file_path.
function writeToolInput(
  toolName: string,
  agentType: string | undefined,
  filePath: string,
): HookInput {
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  return {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    cwd: root,
    ...(agentType ? { agent_type: agentType } : {}),
    tool_input: { [key]: filePath, content: 'x', new_source: 'x' },
  };
}

function writeTool(
  toolName: string,
  agentType: string | undefined,
  filePath: string,
): string | null {
  return decide(writeToolInput(toolName, agentType, filePath), root);
}

const TRUSTED_FOLDERS = [
  '.claude/reviews/abc.md',
  '.claude/reviews/sub/dir/abc.md',
  '.claude/reviews/x.test.ts',
  '.claude/state/security-review/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
  '.claude/state/stop-exceptions.log',
  '.claude/state/x.test.ts',
];

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const WRITERS: [string, string | undefined][] = [
  ['a sessão principal', undefined],
  ['o implementer', 'implementer'],
  ['o test-writer', 'test-writer'],
  ['o reviewer', 'reviewer'],
];

function trustedVariants(relative: string): [string, string][] {
  return [
    ...variants(relative),
    [
      'com .. passando por outra pasta',
      relative.replace('.claude/', '.claude/hooks/../'),
    ],
    ['com .. saindo de src', `src/../${relative}`],
    ['com ./ no meio', relative.replace('.claude/', './.claude/./')],
  ];
}

describe('AI-15 guarda de caminho nega a qualquer sessão .claude/reviews/ e .claude/state/', () => {
  // Um caso por caminho, sessão e ferramenta; cada `it` confere todas as grafias do caminho.
  const denyCases: [string, string, string, string | undefined][] =
    TRUSTED_FOLDERS.flatMap((path) =>
      WRITERS.flatMap(([session, agentType]) =>
        EDIT_TOOLS.map((tool): [string, string, string, string | undefined] => [
          path,
          session,
          tool,
          agentType,
        ]),
      ),
    );

  it.each(denyCases)(
    'AI-15 ninguém edita %s: %s, por %s, escrito de qualquer jeito',
    (path, _session, tool, agentType) => {
      for (const [, variant] of trustedVariants(path))
        expectDenied(writeTool(tool, agentType, variant));
    },
  );

  it('AI-15 a sessão principal não escreve .Claude/Reviews/x.md com Write', () => {
    expectDenied(writeTool('Write', undefined, '.Claude/Reviews/x.md'));
    expectDenied(
      writeTool('Write', undefined, join(root, '.Claude/Reviews/x.md')),
    );
  });

  it('AI-15 a sessão principal não edita .claude/state/ de um caminho absoluto com maiúsculas', () => {
    expectDenied(
      writeTool(
        'Edit',
        undefined,
        join(root, '.CLAUDE/STATE/security-review/ABC'),
      ),
    );
  });

  // Controles negativos: a negação é só dessas duas pastas, e a sessão principal segue editando o resto de .claude/.
  it.each([
    '.claude/settings.json',
    '.claude/hooks/x.mjs',
    '.claude/hooks/post-tool.mjs',
    '.claude/agents/reviewer.md',
    '.claude/reviews-old/x.md',
    '.claude/reviewsx.md',
    '.claude/state-old/x',
    '.claude/statement/x.md',
    'src/reviews/x.md',
    'reviews/x.md',
    'state/x',
  ])('AI-15 controle: a sessão principal continua editando %s', (path) => {
    for (const tool of EDIT_TOOLS) {
      expectAllowed(writeTool(tool, undefined, path));
      expectAllowed(writeTool(tool, undefined, join(root, path)));
    }
  });

  it.each(['src/reviews/x.md', 'src/state/x.ts'])(
    'AI-15 controle: o implementer continua editando %s, que só lembra as pastas protegidas',
    (path) => {
      expectAllowed(writeTool('Write', 'implementer', path));
    },
  );

  it('AI-15 controle: o test-writer continua editando um teste comum dentro de .claude/hooks/', () => {
    expectAllowed(
      writeTool('Edit', 'test-writer', '.claude/hooks/post-tool.test.ts'),
    );
  });
});

describe('FND-08 sessão principal', () => {
  it.each([
    'src/contract/health.ts',
    'src/x.test.ts',
    'test/integration/checkout/foo.test.ts',
    '.specs/features/casecellshop/spec.md',
    'AGENTS.md',
    'openapi.yaml',
  ])('FND-08 a sessão principal, sem agent_type, pode editar %s', (path) => {
    expectAllowed(edit(undefined, path));
    expectAllowed(edit(undefined, join(root, path)));
  });
});

// A fiação do hook como processo (stdin, stdout, código de saída, ambiente): poucos testes, porque cada
// processo Node custa cerca de 75 ms; a tabela de casos fica na decisão, dentro do processo.
describe('FND-08 o hook como processo', () => {
  const foreignDirs: string[] = [];

  afterAll(() => {
    for (const dir of foreignDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function foreignDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pg-'));
    foreignDirs.push(dir);
    return dir;
  }

  it('FND-08 a edição negada sai com código 0 e o JSON hookSpecificOutput com deny no stdout', () => {
    const result = runHook(
      JSON.stringify(editInput('implementer', 'src/x.test.ts')),
    );

    const denial = expectProcessDenied(result);
    expect(denial.hookSpecificOutput.permissionDecisionReason).toBe(
      edit('implementer', 'src/x.test.ts'),
    );
  });

  it('FND-08 a edição permitida sai com código 0 e o stdout vazio', () => {
    expectProcessAllowed(
      runHook(JSON.stringify(editInput('implementer', 'src/app.ts'))),
    );
  });

  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"agent_type": "implementer", "tool_input": {'],
  ])('FND-08 a entrada ilegível bloqueia com código 2 (%s)', (_label, raw) => {
    const result = runHook(raw);

    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
  });

  it('FND-08 o CLAUDE_PROJECT_DIR vale mais que o cwd da entrada para achar a raiz do repositório', () => {
    const elsewhere = foreignDir();
    const inside = join(root, 'test', 'helpers', 'clock.ts');

    // Com a raiz certa o caminho é de test/ e o test-writer pode; com o cwd como raiz, ele estaria fora do repositório.
    expectProcessAllowed(
      runHook(
        JSON.stringify({ ...editInput('test-writer', inside), cwd: elsewhere }),
      ),
    );
    // E o contrário: com outra raiz no ambiente, o mesmo caminho cai fora do repositório mesmo com o cwd certo.
    expectProcessDenied(
      runHook(
        JSON.stringify({ ...editInput('test-writer', inside), cwd: root }),
        elsewhere,
      ),
    );
  });

  it('FND-08 sem CLAUDE_PROJECT_DIR no ambiente a raiz é o cwd da entrada', () => {
    const inside = join(root, 'test', 'helpers', 'clock.ts');

    expectProcessAllowed(
      runHook(JSON.stringify(editInput('test-writer', inside)), undefined),
    );
    expectProcessDenied(
      runHook(
        JSON.stringify(editInput('test-writer', join(root, 'src', 'app.ts'))),
        undefined,
      ),
    );
  });

  it('FND-08 o NotebookEdit traz o caminho em notebook_path e a guarda o confere como processo', () => {
    expectProcessDenied(
      runHook(
        JSON.stringify(
          writeToolInput('NotebookEdit', 'implementer', 'src/x.test.ts'),
        ),
      ),
    );
    expectProcessAllowed(
      runHook(
        JSON.stringify(
          writeToolInput('NotebookEdit', 'implementer', 'src/app.ts'),
        ),
      ),
    );
  });

  // Diferencial: o processo e a função exportada dão o mesmo resultado, um caso negado e um permitido por papel.
  it.each([
    ['a sessão principal', undefined, '.claude/reviews/x.md', 'src/app.ts'],
    ['o implementer', 'implementer', '.oxlintrc.json', 'src/app.ts'],
    ['o test-writer', 'test-writer', 'src/app.ts', 'src/x.test.ts'],
    [
      'o reviewer',
      'reviewer',
      '.claude/state/stop-exceptions.log',
      'src/app.ts',
    ],
  ])(
    'FND-08 o processo e decide() dão o mesmo resultado para %s',
    (_session, agentType, denied, allowed) => {
      const viaProcess = runHook(JSON.stringify(editInput(agentType, denied)));
      const reason = edit(agentType, denied);
      expectDenied(reason);
      expect(
        expectProcessDenied(viaProcess).hookSpecificOutput
          .permissionDecisionReason,
      ).toBe(reason);

      expectAllowed(edit(agentType, allowed));
      expectProcessAllowed(
        runHook(JSON.stringify(editInput(agentType, allowed))),
      );
    },
  );
});

// AI-26: o agente em worktree edita arquivos da worktree, que fica em outra pasta (ou em .claude/worktrees/ do
// projeto). A guarda decide pelo caminho relativo à raiz da worktree, tirada do cwd da entrada; contra a pasta
// principal, o arquivo de código da worktree cairia em .claude/worktrees/..., que é protegido.
describe('AI-26 a guarda de caminho decide pela raiz da worktree do agente', () => {
  let project: string;
  let inside: string;
  let outside: string;
  let unrelated: string;

  // Um repositório com duas worktrees, criado uma vez: os testes só leem. `inside` fica onde o Claude Code a cria
  // (dentro do projeto); `outside` prova que a regra não depende do lugar.
  beforeAll(() => {
    project = makeTempDir('ai26-proj-');
    initRepo(project);
    inside = join(project, '.claude', 'worktrees', 'agent-1');
    git(project, 'worktree', 'add', '-q', inside, '-b', 'wt-inside');
    outside = join(makeTempDir('ai26-out-'), 'agent-2');
    git(project, 'worktree', 'add', '-q', outside, '-b', 'wt-outside');
    unrelated = makeTempDir('ai26-other-');
    initRepo(unrelated);
  });

  afterAll(cleanupTempDirs);

  function worktreeEdit(
    agentType: string,
    worktree: string,
    filePath: string,
  ): HookInput {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: worktree,
      agent_type: agentType,
      tool_input: { file_path: filePath },
    };
  }

  it.each([
    ['dentro do projeto', () => inside],
    ['fora do projeto', () => outside],
  ])(
    'AI-26 o rootFor devolve a raiz da worktree do cwd (%s)',
    (_label, worktree) => {
      expect(rootFor({ cwd: worktree() }, project)).toBe(worktree());
      expect(rootFor({ cwd: join(worktree(), 'src') }, project)).toBe(
        worktree(),
      );
    },
  );

  it('AI-26 o rootFor devolve o projectDir sem cwd e com o cwd dentro da pasta principal', () => {
    expect(rootFor({}, project)).toBe(project);
    expect(rootFor({ cwd: project }, project)).toBe(project);
    expect(rootFor({ cwd: join(project, 'src') }, project)).toBe(project);
  });

  // Controle negativo: um cwd de outro repositório, ou de fora de qualquer repositório, não muda a raiz.
  it('AI-26 o rootFor ignora um cwd que não é worktree do repositório do projeto', () => {
    expect(rootFor({ cwd: unrelated }, project)).toBe(project);
    expect(rootFor({ cwd: tmpdir() }, project)).toBe(project);
  });

  it.each([
    ['dentro do projeto', () => inside],
    ['fora do projeto', () => outside],
  ])(
    'AI-26 o implementer edita o código da worktree (%s)',
    (_label, worktree) => {
      const dir = worktree();
      for (const filePath of [
        join(dir, 'src/x.ts'),
        'src/x.ts',
        'migrations/store/001_x.ts',
      ]) {
        const input = worktreeEdit('implementer', dir, filePath);
        expectAllowed(decide(input, rootFor(input, project)));
      }
    },
  );

  it.each([
    ['dentro do projeto', () => inside],
    ['fora do projeto', () => outside],
  ])(
    'AI-26 o implementer não edita teste nem o que é protegido dentro da worktree (%s)',
    (_label, worktree) => {
      const dir = worktree();
      for (const relative of [
        'test/x.test.ts',
        'src/x.test.ts',
        'test/helpers/clock.ts',
        '.claude/hooks/x.mjs',
        'AGENTS.md',
      ]) {
        for (const filePath of [join(dir, relative), relative]) {
          const input = worktreeEdit('implementer', dir, filePath);
          expectDenied(decide(input, rootFor(input, project)));
        }
      }
    },
  );

  it('AI-26 o test-writer edita teste e não edita código dentro da worktree', () => {
    const allowed = worktreeEdit(
      'test-writer',
      inside,
      join(inside, 'test/x.test.ts'),
    );
    const denied = worktreeEdit(
      'test-writer',
      inside,
      join(inside, 'src/x.ts'),
    );

    expectAllowed(decide(allowed, rootFor(allowed, project)));
    expectDenied(decide(denied, rootFor(denied, project)));
  });

  // Controle negativo: a decisão pelo caminho relativo à pasta principal nega o código da worktree.
  it.each([
    ['dentro do projeto, o caminho cai em .claude/worktrees/', () => inside],
    ['fora do projeto, o caminho cai fora do repositório', () => outside],
  ])(
    'AI-26 controle: com a raiz da pasta principal o implementer perde o código da worktree (%s)',
    (_label, worktree) => {
      const input = worktreeEdit(
        'implementer',
        worktree(),
        join(worktree(), 'src/x.ts'),
      );

      expectDenied(decide(input, project));
      expectAllowed(decide(input, rootFor(input, project)));
    },
  );

  it('AI-26 o hook como processo usa a raiz da worktree: código permitido, teste negado', () => {
    const code = worktreeEdit('implementer', inside, join(inside, 'src/x.ts'));
    const test = worktreeEdit(
      'implementer',
      inside,
      join(inside, 'test/x.test.ts'),
    );

    expectProcessAllowed(runHook(JSON.stringify(code), project, inside));
    expectProcessDenied(runHook(JSON.stringify(test), project, inside));
  });
});

// A4 da Revisão do #19 (AI-26): os caminhos são comparados depois do `realpath`. Com o projectDir passado por um link
// simbólico (como o `/tmp` do macOS, que aponta para `/private/tmp`) e o cwd da entrada pelo caminho real, a comparação
// sem `realpath` não reconhece a worktree e devolve a pasta principal.
describe('AI-26 o rootFor compara os caminhos depois do realpath', () => {
  let project: string;
  let link: string;
  let worktree: string;
  let unrelated: string;

  beforeAll(() => {
    project = makeTempDir('ai26-real-');
    initRepo(project);
    worktree = join(project, '.claude', 'worktrees', 'agent-1');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'wt-realpath');
    link = join(makeTempDir('ai26-link-'), 'projeto');
    symlinkSync(project, link);
    unrelated = makeTempDir('ai26-unrelated-');
    initRepo(unrelated);
  });

  afterAll(cleanupTempDirs);

  it('AI-26 o projectDir por link simbólico e o cwd pelo caminho real dão a raiz da worktree', () => {
    expect(realpathSync(link)).toBe(project);
    expect(rootFor({ cwd: worktree }, link)).toBe(worktree);
    expect(rootFor({ cwd: join(worktree, 'src') }, link)).toBe(worktree);
  });

  it('AI-26 o projectDir real e o cwd pelo link simbólico dão a mesma worktree', () => {
    const viaLink = join(link, '.claude', 'worktrees', 'agent-1');

    expect(realpathSync(rootFor({ cwd: viaLink }, project))).toBe(worktree);
    expect(realpathSync(rootFor({ cwd: viaLink }, link))).toBe(worktree);
  });

  it('AI-26 a decisão com o projectDir por link simbólico libera o código da worktree e nega o teste', () => {
    const code: HookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: worktree,
      agent_type: 'implementer',
      tool_input: { file_path: join(worktree, 'src/x.ts') },
    };
    const test: HookInput = {
      ...code,
      tool_input: { file_path: join(worktree, 'test/x.test.ts') },
    };

    expectAllowed(decide(code, rootFor(code, link), link));
    expectDenied(decide(test, rootFor(test, link), link));
  });

  // Controle negativo: um cwd de outro repositório continua devolvendo o projectDir, do jeito que foi passado.
  it('AI-26 controle: o cwd de outro repositório devolve o projectDir, mesmo por link simbólico', () => {
    expect(rootFor({ cwd: unrelated }, link)).toBe(link);
    expect(rootFor({ cwd: unrelated }, project)).toBe(project);
    expect(rootFor({}, link)).toBe(link);
  });

  // A18 da Revisão 4 (AI-28): sem worktree, o retorno é o projectDir exatamente como foi passado, e não a forma real.
  // O agente sem worktree na pasta principal não pode passar a contar como isolado por uma diferença de grafia.
  it('AI-26 controle: o cwd na pasta principal, pelo caminho real, devolve o projectDir passado por link simbólico, sem resolvê-lo', () => {
    expect(rootFor({ cwd: join(project, 'src') }, link)).toBe(link);
    expect(rootFor({ cwd: project }, link)).toBe(link);
  });

  it('AI-26 controle: o cwd igual ao projectDir, pelo link simbólico, devolve o projectDir e não a forma real', () => {
    const viaLink = rootFor({ cwd: link }, link);

    expect(viaLink).toBe(link);
    expect(viaLink).not.toBe(project);
    expect(rootFor({ cwd: join(link, 'src') }, link)).toBe(link);
  });
});

// A15 da Revisão 4 (AI-26, AI-15): a decisão compara o `file_path` e as raízes depois do `realpath`. Um caminho pelo link
// simbólico (ou pelo `/private` do macOS) e o mesmo caminho pela forma real não podem dar decisões diferentes, em
// nenhuma das quatro combinações de raiz e alvo.
describe('AI-26 a decisão compara o file_path e as raízes depois do realpath', () => {
  let project: string;
  let link: string;
  let foreign: string;
  let foreignLink: string;
  let worktree: string;

  beforeAll(() => {
    project = makeTempDir('ai26-dec-');
    initRepo(project);
    worktree = join(project, '.claude', 'worktrees', 'agent-1');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'wt-decide');
    link = join(makeTempDir('ai26-dec-link-'), 'projeto');
    symlinkSync(project, link);
    foreign = makeTempDir('ai26-dec-fora-');
    foreignLink = join(makeTempDir('ai26-dec-fora-link-'), 'fora');
    symlinkSync(foreign, foreignLink);
  });

  afterAll(cleanupTempDirs);

  type Form = 'real' | 'link';
  const FORMS: Form[] = ['real', 'link'];
  // As quatro combinações: a forma da raiz e a forma do alvo.
  const COMBINATIONS = FORMS.flatMap((rootForm) =>
    FORMS.map((targetForm): [Form, Form] => [rootForm, targetForm]),
  );

  function projectIn(form: Form): string {
    return form === 'real' ? project : link;
  }

  function worktreeIn(form: Form): string {
    return join(projectIn(form), '.claude', 'worktrees', 'agent-1');
  }

  function projectInput(
    agentType: string | undefined,
    filePath: string,
    toolName = 'Edit',
  ): HookInput {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      cwd: project,
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { file_path: filePath, content: 'x' },
    };
  }

  function worktreeInput(agentType: string, filePath: string): HookInput {
    return { ...projectInput(agentType, filePath), cwd: worktree };
  }

  // Pastas dos hooks (AI-15), sessão principal, raiz e projectDir pela mesma forma.
  it.each(
    [
      '.claude/reviews/x.md',
      '.claude/state/stop-exceptions.log',
      '.claude/reviews/novo/sub/x.md',
    ].flatMap((relative) =>
      COMBINATIONS.map((combination): [string, Form, Form] => [
        relative,
        ...combination,
      ]),
    ),
  )(
    'AI-15 a sessão principal não escreve %s: raiz pela forma %s e alvo pela forma %s',
    (relative, rootForm, targetForm) => {
      for (const tool of ['Edit', 'Write']) {
        const input = projectInput(
          undefined,
          join(projectIn(targetForm), relative),
          tool,
        );

        expectDenied(decide(input, projectIn(rootForm), projectIn(rootForm)));
      }
    },
  );

  it.each(COMBINATIONS)(
    'AI-15 controle: a sessão principal segue escrevendo o resto do projeto: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      for (const relative of ['src/x.ts', '.claude/hooks/x.mjs', 'AGENTS.md']) {
        const input = projectInput(
          undefined,
          join(projectIn(targetForm), relative),
        );

        expectAllowed(decide(input, projectIn(rootForm), projectIn(rootForm)));
      }
    },
  );

  // O implementer isolado: a raiz é a da worktree, e o projectDir, o da pasta principal.
  it.each(COMBINATIONS)(
    'AI-26 o implementer isolado edita o código da worktree: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      for (const relative of ['src/x.ts', 'migrations/store/001_x.ts']) {
        const input = worktreeInput(
          'implementer',
          join(worktreeIn(targetForm), relative),
        );

        expectAllowed(decide(input, worktreeIn(rootForm), projectIn(rootForm)));
      }
    },
  );

  it.each(COMBINATIONS)(
    'AI-26 o implementer isolado não edita teste nem o que é protegido na worktree: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      for (const relative of [
        'src/x.test.ts',
        'test/helpers/clock.ts',
        '.claude/hooks/x.mjs',
        'AGENTS.md',
      ]) {
        const input = worktreeInput(
          'implementer',
          join(worktreeIn(targetForm), relative),
        );

        expectDenied(decide(input, worktreeIn(rootForm), projectIn(rootForm)));
      }
    },
  );

  it.each(COMBINATIONS)(
    'AI-26 o test-writer isolado edita teste e não edita código da worktree: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      const allowed = worktreeInput(
        'test-writer',
        join(worktreeIn(targetForm), 'test/x.test.ts'),
      );
      const denied = worktreeInput(
        'test-writer',
        join(worktreeIn(targetForm), 'src/x.ts'),
      );

      expectAllowed(decide(allowed, worktreeIn(rootForm), projectIn(rootForm)));
      expectDenied(decide(denied, worktreeIn(rootForm), projectIn(rootForm)));
    },
  );

  // Alvo que ainda não existe: arquivo novo em pasta nova. A decisão é a mesma nas duas formas, porque o caminho se
  // resolve pelo maior ancestral que existe.
  it.each(COMBINATIONS)(
    'AI-26 um arquivo novo numa pasta nova decide igual nas duas formas: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      const target = (relative: string): string =>
        join(worktreeIn(targetForm), relative);
      const decideFor = (agentType: string, relative: string) =>
        decide(
          worktreeInput(agentType, target(relative)),
          worktreeIn(rootForm),
          projectIn(rootForm),
        );

      expectAllowed(decideFor('implementer', 'src/pasta/nova/x.ts'));
      expectDenied(decideFor('implementer', 'src/pasta/nova/x.test.ts'));
      expectAllowed(decideFor('test-writer', 'test/pasta/nova/x.test.ts'));
      expectDenied(decideFor('test-writer', 'src/pasta/nova/x.ts'));
    },
  );

  it.each(COMBINATIONS)(
    'AI-15 uma pasta nova dentro de .claude/reviews/ segue negada à sessão principal: raiz pela forma %s e alvo pela forma %s',
    (rootForm, targetForm) => {
      const input = projectInput(
        undefined,
        join(projectIn(targetForm), '.claude/reviews/pasta/nova/x.md'),
        'Write',
      );

      expectDenied(decide(input, projectIn(rootForm), projectIn(rootForm)));
    },
  );

  // Controle negativo: um alvo de fato fora do projeto segue negado ao agente, pelo caminho real e pelo link.
  it.each([
    ['pela forma real', () => foreign],
    ['pelo link simbólico', () => foreignLink],
  ])(
    'AI-26 controle: o agente isolado não edita um alvo fora do projeto (%s)',
    (_label, base) => {
      for (const agentType of ['implementer', 'test-writer']) {
        for (const relative of ['src/x.ts', 'test/x.test.ts']) {
          for (const rootForm of FORMS) {
            const input = worktreeInput(agentType, join(base(), relative));

            expectDenied(
              decide(input, worktreeIn(rootForm), projectIn(rootForm)),
            );
          }
        }
      }
    },
  );

  // Controle negativo: o link simbólico da pasta do projeto não vira licença para a pasta irmã com o mesmo prefixo.
  it('AI-26 controle: uma pasta irmã da worktree com o mesmo prefixo segue fora do repositório, pelo link', () => {
    const input = worktreeInput(
      'implementer',
      join(`${worktreeIn('link')}-outra`, 'src/x.ts'),
    );

    expectDenied(decide(input, worktreeIn('real'), project));
    expectDenied(decide(input, worktreeIn('link'), link));
  });
});

// A1 da Revisão 1 (AI-15, AI-26): a raiz das regras de papel é a da worktree, mas as pastas gravadas pelos hooks
// ficam na pasta principal; uma sessão sem papel com o cwd numa worktree não pode escrevê-las.
describe('AI-15 as pastas dos hooks são conferidas contra a pasta principal mesmo com o cwd numa worktree', () => {
  let project: string;
  let worktree: string;

  beforeAll(() => {
    project = makeTempDir('ai15-proj-');
    initRepo(project);
    worktree = join(project, '.claude', 'worktrees', 'agent-1');
    git(project, 'worktree', 'add', '-q', worktree, '-b', 'wt-ai15');
  });

  afterAll(cleanupTempDirs);

  function fromWorktree(
    agentType: string | undefined,
    filePath: string,
    toolName = 'Write',
  ): HookInput {
    return {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      cwd: worktree,
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { file_path: filePath, content: 'x' },
    };
  }

  function decideInWorktree(input: HookInput): string | null {
    return decide(input, rootFor(input, project), project);
  }

  it.each(['.claude/reviews/forjado.md', '.claude/state/x.log'])(
    'AI-15 a sessão principal com o cwd na worktree não escreve %s da pasta principal',
    (relative) => {
      for (const tool of ['Write', 'Edit']) {
        const reason = decideInWorktree(
          fromWorktree(undefined, join(project, relative), tool),
        );

        expectDenied(reason);
        expect(reason).toContain('gravados só pelos hooks');
      }
    },
  );

  it('AI-15 o hook como processo, com o cwd da entrada na worktree, nega Write em .claude/reviews/ da pasta principal', () => {
    const input = fromWorktree(
      undefined,
      join(project, '.claude', 'reviews', 'x.md'),
    );

    const denial = expectProcessDenied(
      runHook(JSON.stringify(input), project, worktree),
    );

    expect(denial.hookSpecificOutput.permissionDecisionReason).toContain(
      'gravados só pelos hooks',
    );
  });

  // Controles negativos: o resto da worktree segue liberado, e o implementer segue com as regras do papel.
  it('AI-15 controle: a mesma sessão, na worktree, ainda escreve o código da worktree', () => {
    expectAllowed(
      decideInWorktree(fromWorktree(undefined, join(worktree, 'src', 'x.ts'))),
    );
    expectProcessAllowed(
      runHook(
        JSON.stringify(fromWorktree(undefined, join(worktree, 'src', 'x.ts'))),
        project,
        worktree,
      ),
    );
  });

  it('AI-26 controle: o implementer na worktree escreve em src/ e não escreve teste', () => {
    expectAllowed(
      decideInWorktree(
        fromWorktree('implementer', join(worktree, 'src', 'x.ts')),
      ),
    );
    expectDenied(
      decideInWorktree(
        fromWorktree('implementer', join(worktree, 'src', 'x.test.ts')),
      ),
    );
  });
});

// O que o `realpath` sozinho não resolve (AI-26): o `..` depois de um link, o link quebrado no último componente, a
// caixa do caminho num sistema de arquivos que não distingue caixa e o link cujo próprio nome é protegido.
// O sistema de arquivos é uma condição de ambiente (o padrão do macOS não distingue caixa; o do Linux distingue).
const caseInsensitive = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'ai26-probe-'));
  try {
    return existsSync(probe.toUpperCase());
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('AI-26 a guarda decide pelo caminho real: .. depois de link, link quebrado, caixa e nome protegido', () => {
  let project: string;
  let elsewhere: string;

  function link(target: string, name: string): void {
    mkdirSync(dirname(join(project, name)), { recursive: true });
    symlinkSync(target, join(project, name));
  }

  beforeAll(() => {
    project = makeTempDir('ai26-real-');
    elsewhere = join(makeTempDir('ai26-fora-'), 'pasta');
    mkdirSync(elsewhere);
    mkdirSync(join(project, 'src', 'sub'), { recursive: true });
    mkdirSync(join(project, 'test', 'helpers'), { recursive: true });
    // O `..` depois de um link: para fora do repositório, para dentro de test/ e para uma pasta de src/.
    link(elsewhere, 'src/l');
    link('../test/helpers', 'src/lt');
    link('sub', 'src/lc');
    // O link quebrado no último componente: o destino ainda não existe.
    link('../test/a.test.ts', 'src/novo.ts');
    link('../src/b.ts', 'src/novo2.ts');
    // O nome pedido protegido, e o destino protegido com nome comum.
    writeFileSync(join(project, 'src', 'x.json'), 'x\n');
    link('x.json', 'src/.oxlintrc.json');
    link('x.json', 'src/alias.json');
    mkdirSync(join(project, '.claude', 'reviews'), { recursive: true });
    writeFileSync(join(project, '.claude', 'reviews', 'r.md'), 'x\n');
    link('../.claude/reviews/r.md', 'src/rev.ts');
  });

  afterAll(cleanupTempDirs);

  function decideFor(
    agentType: string | undefined,
    filePath: string,
  ): string | null {
    const input: HookInput = {
      ...editInput(agentType, filePath),
      cwd: project,
    };
    return decide(input, project, project);
  }

  // O texto, e não o `join`: o `join` já resolveria o `..` antes da guarda.
  it.each([
    ['absoluto', () => `${project}/src/l/../x.ts`],
    ['relativo', () => 'src/l/../x.ts'],
  ])(
    'AI-26 o .. depois de um link para fora do repositório é decidido pelo caminho real e negado (%s)',
    (_label, filePath) => {
      expectDenied(decideFor('implementer', filePath()));
    },
  );

  it('AI-26 o .. depois de um link para test/ é decidido pelo caminho real e negado ao implementer', () => {
    expectDenied(decideFor('implementer', `${project}/src/lt/../x.ts`));
  });

  // Controles negativos: sem o link, ou com um link que fica dentro de src/, o mesmo texto continua liberado.
  it('AI-26 controle: o .. depois de um link para uma pasta de src/ e o src/y.ts comum seguem liberados', () => {
    expectAllowed(decideFor('implementer', `${project}/src/lc/../y.ts`));
    expectAllowed(decideFor('implementer', `${project}/src/sub/../y.ts`));
    expectAllowed(decideFor('implementer', 'src/y.ts'));
  });

  it('AI-26 controle: o arquivo dentro do link para fora do repositório é negado, como o .. depois dele', () => {
    expectDenied(decideFor('implementer', `${project}/src/l/x.ts`));
  });

  it('AI-26 o link quebrado no último componente é decidido pelo destino: o implementer não edita um teste por ele', () => {
    expect(existsSync(join(project, 'test', 'a.test.ts'))).toBe(false);

    expectDenied(decideFor('implementer', `${project}/src/novo.ts`));
    expectDenied(decideFor('implementer', 'src/novo.ts'));
  });

  it('AI-26 controle: o link quebrado cujo destino é código de src/ segue liberado ao implementer', () => {
    expect(existsSync(join(project, 'src', 'b.ts'))).toBe(false);

    expectAllowed(decideFor('implementer', `${project}/src/novo2.ts`));
  });

  it.skipIf(!caseInsensitive)(
    'AI-26 num sistema de arquivos sem distinção de caixa, o caminho absoluto em outra caixa decide igual ao da caixa certa',
    () => {
      const upper = (relative: string): string =>
        `${project.toUpperCase()}/${relative.toUpperCase()}`;

      // A sessão principal não escreve em .claude/reviews/ (AI-15), em nenhuma caixa.
      expectDenied(decideFor(undefined, `${project}/.claude/reviews/x.md`));
      expectDenied(decideFor(undefined, upper('.claude/reviews/x.md')));
      // O implementer edita src/y.ts e não edita teste, em nenhuma caixa.
      expectAllowed(decideFor('implementer', `${project}/src/y.ts`));
      expectAllowed(decideFor('implementer', upper('src/y.ts')));
      expectDenied(decideFor('implementer', `${project}/test/y.test.ts`));
      expectDenied(decideFor('implementer', upper('test/y.test.ts')));
    },
  );

  it('AI-26 o nome pedido protegido nega o link, mesmo que ele aponte para um arquivo que o implementer edita', () => {
    expectAllowed(decideFor('implementer', `${project}/src/x.json`));

    expectDenied(decideFor('implementer', `${project}/src/.oxlintrc.json`));
    expectDenied(decideFor('implementer', 'src/.oxlintrc.json'));
  });

  it('AI-26 controle: um link de nome comum para o mesmo arquivo segue liberado', () => {
    expectAllowed(decideFor('implementer', `${project}/src/alias.json`));
  });

  it('AI-26 controle: o link de nome comum para um destino protegido segue negado (pelo caminho real)', () => {
    expectDenied(decideFor('implementer', `${project}/src/rev.ts`));
    expectDenied(decideFor('implementer', 'src/rev.ts'));
  });
});

// A13 do #27 (AI-26): o caminho pedido segue as pastas reais até o último componente, que não é seguido. Um caminho
// absoluto que chega à raiz por um link de pasta (o /tmp do macOS) não pode pular a conferência do nome do link.
describe('AI-26 o caminho pedido por um prefixo diferente do caminho da raiz é conferido pelo nome', () => {
  let real: string;
  let folderLink: string;

  beforeAll(() => {
    real = makeTempDir('ai26-nome-');
    mkdirSync(join(real, 'src'), { recursive: true });
    writeFileSync(join(real, 'src', 'x.json'), 'x\n');
    symlinkSync('x.json', join(real, 'src', '.oxlintrc.json'));
    symlinkSync('x.json', join(real, 'src', 'alias.json'));
    folderLink = join(makeTempDir('ai26-nome-link-'), 'projeto');
    symlinkSync(real, folderLink);
  });

  afterAll(cleanupTempDirs);

  function implementerEdits(filePath: string): string | null {
    const input: HookInput = {
      ...editInput('implementer', filePath),
      cwd: real,
    };
    return decide(input, real, real);
  }

  // Controle: pelo prefixo da raiz, o nome pedido já é negado.
  it('AI-26 controle: o pedido pelo caminho da raiz ao link .oxlintrc.json é negado', () => {
    expectDenied(implementerEdits(join(real, 'src', '.oxlintrc.json')));
  });

  it('AI-26 o pedido pelo link de pasta ao link .oxlintrc.json, que aponta para um arquivo editável, é negado', () => {
    expectAllowed(implementerEdits(join(real, 'src', 'x.json')));

    expectDenied(implementerEdits(join(folderLink, 'src', '.oxlintrc.json')));
  });

  it('AI-26 o pedido pelo link de pasta com .. antes do nome protegido também é negado', () => {
    expectDenied(implementerEdits(`${folderLink}/src/../src/.oxlintrc.json`));
  });

  // Controle negativo: um link de nome comum pelo mesmo prefixo segue liberado, e o teste pelo mesmo prefixo segue negado.
  it('AI-26 controle: o link de nome comum e o arquivo de código, pelo link de pasta, seguem liberados', () => {
    expectAllowed(implementerEdits(join(folderLink, 'src', 'alias.json')));
    expectAllowed(implementerEdits(join(folderLink, 'src', 'y.ts')));
    expectDenied(implementerEdits(join(folderLink, 'src', 'y.test.ts')));
  });

  // Num sistema de arquivos sem distinção de caixa, o caminho absoluto em outra caixa também tem de passar pelo nome.
  // Condição de ambiente: o Linux distingue caixa, então esta variante só roda no macOS.
  it.skipIf(!caseInsensitive)(
    'AI-26 num sistema de arquivos sem distinção de caixa, o pedido absoluto em outra caixa ao link .oxlintrc.json é negado',
    () => {
      expectDenied(
        implementerEdits(`${real.toUpperCase()}/src/.oxlintrc.json`),
      );
      expectDenied(
        implementerEdits(`${folderLink.toUpperCase()}/src/.oxlintrc.json`),
      );
    },
  );
});

// A14 do #27 (AI-15): a guarda nega pelo caminho pedido e pelo caminho real. Um link dentro de .claude/reviews/ ou de
// .claude/state/ não grava o arquivo que ele aponta fora delas.
describe('AI-15 a sessão principal não grava um link dentro de .claude/reviews/ nem de .claude/state/ que aponta para fora', () => {
  let project: string;

  beforeAll(() => {
    project = makeTempDir('ai15-link-');
    mkdirSync(join(project, '.claude', 'reviews'), { recursive: true });
    mkdirSync(join(project, '.claude', 'state'), { recursive: true });
    mkdirSync(join(project, 'notes'), { recursive: true });
    writeFileSync(join(project, 'notes', 'r.md'), 'x\n');
    writeFileSync(join(project, 'notes', 'log.txt'), 'x\n');
    writeFileSync(join(project, '.claude', 'reviews', 'real.md'), 'x\n');
    // Os links de dentro das pastas dos hooks para um arquivo editável fora delas.
    symlinkSync(
      '../../notes/r.md',
      join(project, '.claude', 'reviews', 'r.md'),
    );
    symlinkSync(
      '../../notes/log.txt',
      join(project, '.claude', 'state', 'stop-exceptions.log'),
    );
    // O link de fora das pastas para dentro delas.
    symlinkSync(
      '../.claude/reviews/real.md',
      join(project, 'notes', 'para-dentro.md'),
    );
  });

  afterAll(cleanupTempDirs);

  function mainSessionWrites(filePath: string, tool: string): string | null {
    const input: HookInput = {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      cwd: project,
      tool_input: { file_path: filePath, content: 'x' },
    };
    return decide(input, project, project);
  }

  it.each(
    ['.claude/reviews/r.md', '.claude/state/stop-exceptions.log'].flatMap(
      (relative) =>
        ['Edit', 'Write'].flatMap((tool) =>
          [
            ['absoluto', (): string => join(project, relative)],
            ['relativo', (): string => relative],
          ].map(([form, pick]): [string, string, string, () => string] => [
            relative,
            tool,
            form as string,
            pick as () => string,
          ]),
        ),
    ),
  )(
    'AI-15 o %s, um link para fora, é negado à sessão principal pelo %s (%s)',
    (_relative, tool, _form, pick) => {
      expectDenied(mainSessionWrites(pick(), tool));
    },
  );

  // Controles negativos: o destino fora das pastas continua livre pelo caminho direto, e o link de fora para dentro
  // continua negado.
  it('AI-15 controle: o caminho direto notes/r.md segue liberado à sessão principal', () => {
    expectAllowed(mainSessionWrites(join(project, 'notes', 'r.md'), 'Write'));
    expectAllowed(mainSessionWrites('notes/r.md', 'Edit'));
  });

  it('AI-15 controle: o link fora das pastas que aponta para dentro delas segue negado', () => {
    expectDenied(
      mainSessionWrites(join(project, 'notes', 'para-dentro.md'), 'Write'),
    );
    expectDenied(mainSessionWrites('notes/para-dentro.md', 'Edit'));
  });
});

// A19 do #27 (AI-26): um ciclo de links ou uma cadeia além de 40 links decide (nega ou deixa passar) sem lançar nem
// travar. A spec não diz qual das duas respostas: o teste aceita as duas e prova que a guarda termina.
describe('AI-26 a guarda decide com um ciclo de links e com uma cadeia além de 40 links', () => {
  let project: string;

  beforeAll(() => {
    project = makeTempDir('ai26-ciclo-');
    mkdirSync(join(project, 'src'), { recursive: true });
    symlinkSync('b', join(project, 'src', 'a'));
    symlinkSync('a', join(project, 'src', 'b'));
    writeFileSync(join(project, 'src', 'alvo.ts'), 'export {};\n');
    for (let index = 0; index < 45; index += 1) {
      const next = index === 44 ? 'alvo.ts' : `l${index + 1}`;
      symlinkSync(next, join(project, 'src', `l${index}`));
    }
    // Um ciclo cujo nome pedido é protegido.
    symlinkSync('ciclo', join(project, 'src', '.oxlintrc.json'));
    symlinkSync('.oxlintrc.json', join(project, 'src', 'ciclo'));
  });

  afterAll(cleanupTempDirs);

  const decideFor = (agentType: string | undefined, filePath: string) =>
    decide({ ...editInput(agentType, filePath), cwd: project }, project);

  function expectDecides(reason: string | null): void {
    expect(reason === null || typeof reason === 'string').toBe(true);
  }

  it.each([
    ['o ciclo a -> b', 'src/a'],
    ['o ciclo b -> a', 'src/b'],
    ['um arquivo dentro do ciclo', 'src/a/x.ts'],
    ['a cadeia de 45 links', 'src/l0'],
  ])(
    'AI-26 %s decide sem lançar, para o implementer e para a sessão principal',
    (_label, relative) => {
      for (const agentType of ['implementer', 'test-writer', undefined]) {
        expect(() =>
          decideFor(agentType, join(project, relative)),
        ).not.toThrow();
        expectDecides(decideFor(agentType, join(project, relative)));
        expectDecides(decideFor(agentType, relative));
      }
    },
  );

  // Controle negativo: o ciclo não deixa passar o nome protegido do link pedido.
  it('AI-26 controle: o ciclo cujo nome pedido é .oxlintrc.json segue negado ao implementer', () => {
    expectDenied(decideFor('implementer', join(project, 'src/.oxlintrc.json')));
    expectDenied(decideFor('implementer', 'src/.oxlintrc.json'));
  });
});
