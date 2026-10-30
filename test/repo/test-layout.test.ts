import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

describe('AI-02 oxlint reprova teste focado ou desligado', () => {
  let tree: string;

  // Na pasta temporária do sistema, e não dentro do repositório: um lint paralelo ou uma execução interrompida
  // esbarraria no arquivo de amostra. A configuração do projeto entra por caminho absoluto.
  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'ai02-lint-'));
    // As regras com tipos resolvem o `vitest` importado pela amostra a partir da pasta dela.
    symlinkSync(path.join(root, 'node_modules'), path.join(tree, 'node_modules'), 'dir');
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function lintExitCode(body: string): number | null {
    const file = path.join(tree, 'amostra.test.ts');
    // Importa só o que o corpo usa, para o no-unused-vars não reprovar o arquivo por outro motivo.
    const imports = body.includes('describe') ? 'describe, expect, it' : 'expect, it';
    writeFileSync(file, `import { ${imports} } from 'vitest';\n\n${body}\n`);
    const result = spawnSync('npx', ['oxlint', '-c', path.join(root, '.oxlintrc.json'), file], {
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

// A lista vem do próprio Vitest, e não de uma reimplementação do casamento de padrões:
// um include ou exclude errado só aparece comparando com o que ele de fato descobre.
function vitestFiles(project: string): string[] {
  const result = spawnSync('npx', ['vitest', 'list', '--project', project, '--filesOnly'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line !== '')
    .sort();
}

// Arquivos novos ainda sem commit também contam (--others), e o que foi apagado do disco não.
function testFilesInRepo(): string[] {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.test.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout
    .split('\n')
    .filter((line) => line !== '' && existsSync(path.join(root, line)))
    .sort();
}

describe('AI-02 todo *.test.ts fora de test/integration/ roda no projeto unit', () => {
  const all = testFilesInRepo();
  const outsideIntegration = all.filter((file) => !file.startsWith('test/integration/'));

  it('AI-02 o projeto unit lista exatamente os *.test.ts do repositório fora de test/integration/', () => {
    expect(vitestFiles('unit')).toEqual(outsideIntegration);
  }, 60_000);

  it('AI-02 o projeto integration lista exatamente os *.test.ts de test/integration/', () => {
    expect(vitestFiles('integration')).toEqual(all.filter((file) => file.startsWith('test/integration/')));
  }, 60_000);

  // O arquivo de scripts/ do controle é um teste que fica ao lado do script que testa; este próprio
  // arquivo agora mora em test/repo/.
  it('AI-02 controle: a conferência enxerga os testes de .claude/, de scripts/ e de test/integration/', () => {
    expect(outsideIntegration).toContain('.claude/hooks/path-guard.test.ts');
    expect(outsideIntegration).toContain('scripts/check-env.test.ts');
    expect(outsideIntegration).toContain('test/repo/test-layout.test.ts');
    expect(all.some((file) => file.startsWith('test/integration/'))).toBe(true);
    expect(vitestFiles('unit')).not.toContain('test/integration/foundation/compose.test.ts');
  }, 60_000);
});
