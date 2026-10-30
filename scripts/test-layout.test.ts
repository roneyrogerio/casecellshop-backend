import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import config from '../vitest.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const fixturesDir = path.join(root, 'test', 'fixtures');

describe('AI-02 oxlint reprova teste focado ou desligado', () => {
  let tree: string;

  // Dentro do repositório, para o oxlint aplicar a configuração e o tsconfig do projeto.
  beforeEach(() => {
    mkdirSync(fixturesDir, { recursive: true });
    tree = mkdtempSync(path.join(fixturesDir, 'lint-'));
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function lintExitCode(body: string): number | null {
    const file = path.join(tree, 'amostra.test.ts');
    // Importa só o que o corpo usa, para o no-unused-vars não reprovar o arquivo por outro motivo.
    const imports = body.includes('describe') ? 'describe, expect, it' : 'expect, it';
    writeFileSync(file, `import { ${imports} } from 'vitest';\n\n${body}\n`);
    const result = spawnSync('npx', ['oxlint', '-c', '.oxlintrc.json', file], {
      cwd: root,
      encoding: 'utf8',
    });
    return result.status;
  }

  it('AI-02 um arquivo com só it(...) passa no lint', () => {
    const code = lintExitCode(`it('faz algo', () => {\n  expect(1).toBe(1);\n});`);

    expect(code).toBe(0);
  });

  it.each([
    ['it.only', `it.only('faz algo', () => {\n  expect(1).toBe(1);\n});`],
    ['it.skip', `it.skip('faz algo', () => {\n  expect(1).toBe(1);\n});`],
    ['describe.only', `describe.only('grupo', () => {\n  it('faz algo', () => {\n    expect(1).toBe(1);\n  });\n});`],
    ['describe.skip', `describe.skip('grupo', () => {\n  it('faz algo', () => {\n    expect(1).toBe(1);\n  });\n});`],
  ])('AI-02 %s reprova o lint com código diferente de zero', (_label, body) => {
    const code = lintExitCode(body);

    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
  }, 60_000);
});

interface ProjectTest {
  name?: string;
  include?: string[];
  exclude?: string[];
}

function findProject(name: string): ProjectTest {
  const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
  for (const project of projects) {
    const test = (project as { test?: ProjectTest }).test;
    if (test?.name === name) return test;
  }
  throw new Error(`projeto ${name} não encontrado no vitest.config.ts`);
}

// Casa um arquivo como o Vitest decide: algum `include` e nenhum `exclude`.
function matches(project: ProjectTest, file: string): boolean {
  const included = (project.include ?? []).some((pattern) => path.matchesGlob(file, pattern));
  const excluded = (project.exclude ?? []).some((pattern) => path.matchesGlob(file, pattern));
  return included && !excluded;
}

describe('AI-02 todo *.test.ts fora de test/integration/ roda no projeto unit', () => {
  it.each([
    'src/a/b.test.ts',
    'scripts/x.test.ts',
    '.claude/hooks/y.test.ts',
    '.claude/z.test.ts',
    'qualquer/pasta/w.test.ts',
  ])('AI-02 o projeto unit casa %s', (file) => {
    expect(matches(findProject('unit'), file)).toBe(true);
  });

  it('AI-02 o projeto unit não casa um teste de test/integration/', () => {
    expect(matches(findProject('unit'), 'test/integration/checkout/k.test.ts')).toBe(false);
  });

  it('AI-02 o projeto unit não casa um arquivo que não é *.test.ts', () => {
    expect(matches(findProject('unit'), 'src/a/b.ts')).toBe(false);
  });

  it('AI-02 o projeto integration casa test/integration/**', () => {
    expect(matches(findProject('integration'), 'test/integration/checkout/k.test.ts')).toBe(true);
  });

  it.each(['src/a/b.test.ts', 'scripts/x.test.ts', '.claude/hooks/y.test.ts', 'qualquer/pasta/w.test.ts'])(
    'AI-02 o projeto integration não casa %s',
    (file) => {
      expect(matches(findProject('integration'), file)).toBe(false);
    },
  );
});
