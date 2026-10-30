import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const hook = join(root, '.claude', 'hooks', 'path-guard.mjs');

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Roda o hook como o Claude Code roda: JSON na entrada padrão e CLAUDE_PROJECT_DIR no ambiente.
function runHook(rawInput: string): HookResult {
  const result = spawnSync(process.execPath, [hook], {
    input: rawInput,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function edit(agentType: string | undefined, filePath: string): HookResult {
  return runHook(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: root,
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { file_path: filePath },
    }),
  );
}

function expectDenied(result: HookResult): void {
  expect(result.code).toBe(0);
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string };
  };
  expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(output.hookSpecificOutput.permissionDecisionReason).not.toBe('');
}

function expectAllowed(result: HookResult): void {
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
    ['com a pasta em outra caixa', [first.toUpperCase(), ...parts.slice(1)].join('/')],
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
    for (const [, variant] of variants(path)) expectAllowed(edit('test-writer', variant));
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
  ])('FND-08 o test-writer não pode editar código que não é teste (%s)', (path) => {
    for (const [, variant] of variants(path)) expectDenied(edit('test-writer', variant));
  });

  it.each([
    ['com .. saindo de test/', 'test/../src/app.ts'],
    ['com .. saindo de test/ por caminho absoluto', join(root, 'test/../src/app.ts')],
    ['em pasta com o prefixo test', 'testing/foo.ts'],
    ['em pasta com o prefixo test, absoluto', join(root, 'tests/foo.ts')],
    ['em src/ em outra caixa', 'SRC/app.ts'],
    ['arquivo cujo nome só contém test', 'src/test-utils.ts'],
    ['extensão parecida', 'src/x.test.tsx'],
  ])('FND-08 o test-writer não pode editar fora de test/ nem de *.test.ts (%s)', (_label, path) => {
    expectDenied(edit('test-writer', path));
  });

  it.each([
    ['absoluto fora do repositório', '/etc/hosts'],
    ['*.test.ts absoluto fora do repositório', '/etc/fora.test.ts'],
    ['relativo acima da raiz', '../fora/test/foo.test.ts'],
    ['em pasta irmã com o mesmo prefixo da raiz', `${root}-outro/test/foo.test.ts`],
    ['com .. acima da raiz', `${root}/test/../../fora/foo.test.ts`],
  ])('FND-08 o test-writer não pode editar caminho fora do repositório (%s)', (_label, path) => {
    expectDenied(edit('test-writer', path));
  });
});

describe('FND-08 guarda de caminho do implementer', () => {
  it.each(IMPLEMENTER_PROTECTED)('FND-08 o implementer não pode editar %s', (path) => {
    for (const [, variant] of variants(path)) expectDenied(edit('implementer', variant));
  });

  it.each([
    ['*.test.ts em src/ em outra caixa', 'Src/X.TEST.TS'],
    ['*.test.ts em src/ em outra caixa, absoluto', join(root, 'Src/X.TEST.TS')],
    ['*.test.ts em .claude/hooks/ em outra caixa', '.Claude/Hooks/X.Test.Ts'],
    ['*.test.ts com .. saindo de uma pasta permitida', 'migrations/../src/x.test.ts'],
  ])('FND-08 o implementer não pode editar *.test.ts (%s)', (_label, path) => {
    expectDenied(edit('implementer', path));
  });

  it.each([
    ['em src/', 'src/app.ts'],
    ['em src/ por caminho absoluto', join(root, 'src/db/migrate.ts')],
    ['em migrations/', 'migrations/store/20260101000000_init.sql'],
    ['no compose', 'compose.yaml'],
    ['em pasta com o prefixo src/contract', 'src/contractual/foo.ts'],
    ['em pasta com o prefixo test', 'testing/foo.ts'],
    ['arquivo cujo nome só contém test', 'src/test-utils.ts'],
    ['com .. que sai de uma pasta protegida', 'test/../src/app.ts'],
  ])('FND-08 o implementer pode editar fora dos testes e das pastas protegidas (%s)', (_label, path) => {
    expectAllowed(edit('implementer', path));
  });

  it.each([
    ['absoluto fora do repositório', '/etc/hosts'],
    ['relativo acima da raiz', '../fora/src/app.ts'],
    ['em pasta irmã com o mesmo prefixo da raiz', `${root}-outro/src/app.ts`],
    ['com .. acima da raiz', `${root}/src/../../fora/app.ts`],
  ])('FND-08 o implementer não pode editar caminho fora do repositório (%s)', (_label, path) => {
    expectDenied(edit('implementer', path));
  });
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
  '.npmrc',
  '.claude/settings.json',
];

describe('AI-04 guarda de caminho nega ao implementer o que configura a verificação', () => {
  it.each(IMPLEMENTER_VERIFICATION_CONFIG)('AI-04 o implementer não pode editar %s', (path) => {
    for (const [, variant] of variants(path)) expectDenied(edit('implementer', variant));
  });

  it.each(['src/checkout/reserve.ts', 'migrations/store/001_x.sql', 'package.json'])(
    'AI-04 o implementer continua podendo editar %s',
    (path) => {
      for (const [, variant] of variants(path)) expectAllowed(edit('implementer', variant));
    },
  );

  it.each(['.github/workflows/ci.yml', 'scripts/check-migrations.ts', '.oxlintrc.json'])(
    'AI-04 a sessão principal, sem agent_type, pode editar %s',
    (path) => {
      expectAllowed(edit(undefined, path));
    },
  );
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
  '.npmrc',
  '.nvmrc',
  '.gitignore',
  '.mcp.json',
  'src/CLAUDE.md',
  'src/CLAUDE.local.md',
  'CLAUDE.local.md',
  'src/x/AGENTS.md',
];

describe('AI-04 guarda de caminho nega ao implementer a configuração pelo nome, em qualquer pasta', () => {
  it.each(IMPLEMENTER_PROTECTED_BY_NAME)('AI-04 o implementer não pode editar %s', (path) => {
    for (const [, variant] of variants(path)) expectDenied(edit('implementer', variant));
  });

  it.each(IMPLEMENTER_PROTECTED_BY_NAME)('AI-04 o implementer também não pode escrever %s com Write', (path) => {
    expectDenied(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          cwd: root,
          agent_type: 'implementer',
          tool_input: { file_path: join(root, path), content: 'x' },
        }),
      ),
    );
  });

  // Controle negativo: nomes que só lembram os protegidos, e o código de produção, continuam liberados.
  it.each([
    'src/checkout/reserve.ts',
    'migrations/store/001_x.sql',
    'package.json',
    'src/oxlintrc.ts',
    'src/tsconfigs/loader.ts',
    'src/vitest-helpers.ts',
    'src/claude.ts',
    'src/agents.ts',
    'src/agents/list.ts',
    'src/gitignore-parser.ts',
    'src/mcp/server.ts',
  ])('AI-04 o implementer continua podendo editar %s', (path) => {
    for (const [, variant] of variants(path)) expectAllowed(edit('implementer', variant));
  });

  it.each(IMPLEMENTER_PROTECTED_BY_NAME)('AI-04 a sessão principal, sem agent_type, pode editar %s', (path) => {
    expectAllowed(edit(undefined, path));
  });
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
  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)('AI-04 o implementer não pode editar %s', (path) => {
    for (const [, variant] of variants(path)) expectDenied(edit('implementer', variant));
  });

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)('AI-04 o implementer também não pode escrever %s com Write', (path) => {
    expectDenied(
      runHook(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          cwd: root,
          agent_type: 'implementer',
          tool_input: { file_path: join(root, path), content: 'exit 0' },
        }),
      ),
    );
  });

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)('AI-04 o test-writer também não pode editar %s', (path) => {
    expectDenied(edit('test-writer', path));
  });

  // Controle negativo: nomes que só lembram as pastas protegidas seguem liberados.
  it.each(['src/githooks.ts', 'migrations/store/.gitkeep', 'src/git/x.ts'])(
    'AI-04 o implementer continua podendo editar %s',
    (path) => {
      for (const [, variant] of variants(path)) expectAllowed(edit('implementer', variant));
    },
  );

  it.each(IMPLEMENTER_PROTECTED_GIT_HOOKS)('AI-04 a sessão principal, sem agent_type, pode editar %s', (path) => {
    expectAllowed(edit(undefined, path));
  });
});

// O github-guard confia no que está em .claude/reviews/ e em .claude/state/ (AI-15, AI-16): nenhuma sessão os edita,
// a principal inclusive. O NotebookEdit traz o caminho em notebook_path; Edit e Write, em file_path.
function writeTool(toolName: string, agentType: string | undefined, filePath: string): HookResult {
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  return runHook(
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      cwd: root,
      ...(agentType ? { agent_type: agentType } : {}),
      tool_input: { [key]: filePath, content: 'x', new_source: 'x' },
    }),
  );
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
    ['com .. passando por outra pasta', relative.replace('.claude/', '.claude/hooks/../')],
    ['com .. saindo de src', `src/../${relative}`],
    ['com ./ no meio', relative.replace('.claude/', './.claude/./')],
  ];
}

describe('AI-15 guarda de caminho nega a qualquer sessão .claude/reviews/ e .claude/state/', () => {
  it.each(TRUSTED_FOLDERS)('AI-15 ninguém edita %s, por Edit, Write ou NotebookEdit, escrito de qualquer jeito', (path) => {
    for (const [, agentType] of WRITERS) {
      for (const tool of EDIT_TOOLS) {
        for (const [, variant] of trustedVariants(path)) expectDenied(writeTool(tool, agentType, variant));
      }
    }
  });

  it('AI-15 a sessão principal não escreve .Claude/Reviews/x.md com Write', () => {
    expectDenied(writeTool('Write', undefined, '.Claude/Reviews/x.md'));
    expectDenied(writeTool('Write', undefined, join(root, '.Claude/Reviews/x.md')));
  });

  it('AI-15 a sessão principal não edita .claude/state/ de um caminho absoluto com maiúsculas', () => {
    expectDenied(writeTool('Edit', undefined, join(root, '.CLAUDE/STATE/security-review/ABC')));
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
    expectAllowed(writeTool('Edit', 'test-writer', '.claude/hooks/post-tool.test.ts'));
  });
});

describe('FND-08 entrada ilegível e sessão principal', () => {
  it.each([
    ['texto que não é JSON', 'isto não é json'],
    ['entrada vazia', ''],
    ['JSON truncado', '{"agent_type": "implementer", "tool_input": {'],
  ])('FND-08 a entrada ilegível bloqueia com código 2 (%s)', (_label, raw) => {
    const result = runHook(raw);

    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe('');
  });

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
