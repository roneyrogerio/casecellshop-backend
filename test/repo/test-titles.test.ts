import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';

// AI-38: todo teste (`it` e `test`) começa pelo ID do critério (`vitest/valid-title` com `mustMatch` no
// .oxlintrc.json); um nome sem ID reprova o `npm run lint`. Como no AI-02, a amostra fica na pasta temporária
// do sistema e a configuração do projeto entra por caminho absoluto.
const oxlintBin = join(root, 'node_modules', '.bin', 'oxlint');

afterAll(cleanupTempDirs);

interface OxlintConfig {
  rules?: Record<string, unknown>;
}

describe('AI-38 o .oxlintrc.json liga vitest/valid-title com mustMatch para it e test', () => {
  const config = JSON.parse(
    readFileSync(join(root, '.oxlintrc.json'), 'utf8'),
  ) as OxlintConfig;
  const rule = config.rules?.['vitest/valid-title'];
  const options = Array.isArray(rule) ? (rule as unknown[])[1] : undefined;

  it('AI-38 a regra vitest/valid-title está em error', () => {
    const severity = Array.isArray(rule) ? (rule as unknown[])[0] : rule;

    expect(severity).toBe('error');
  });

  it.each(['it', 'test'])(
    'AI-38 o mustMatch cobre %s com um padrão que exige o ID no começo',
    (kind) => {
      const mustMatch = (options as { mustMatch?: Record<string, unknown> })
        ?.mustMatch;
      const pattern = mustMatch?.[kind];
      const source = Array.isArray(pattern)
        ? (pattern as unknown[])[0]
        : pattern;

      expect(typeof source).toBe('string');
      const regex = new RegExp(String(source));
      expect(regex.test('AI-38 soma dois números')).toBe(true);
      expect(regex.test('DOC-MSG-01 soma dois números')).toBe(true);
      expect(regex.test('soma dois números')).toBe(false);
      expect(regex.test('depois do AI-38 soma')).toBe(false);
    },
  );
});

describe('AI-38 controle negativo: oxlint com a configuração do projeto reprova um teste sem ID', () => {
  function lint(body: string): { status: number | null; out: string } {
    const dir = makeTempDir('ai38-lint-');
    // As regras com tipos resolvem o `vitest` importado pela amostra a partir da pasta dela.
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    // Importa só o que o corpo usa, para o no-unused-vars não reprovar o arquivo por outro motivo.
    const names = ['describe', 'expect', 'it', 'test'].filter((name) =>
      new RegExp(`(^|\\s)${name}\\(`).test(body),
    );
    writeFileIn(
      dir,
      'amostra.test.ts',
      `import { ${names.join(', ')} } from 'vitest';\n\n${body}\n`,
    );
    const result = spawnSync(
      oxlintBin,
      ['-c', join(root, '.oxlintrc.json'), join(dir, 'amostra.test.ts')],
      { cwd: root, encoding: 'utf8' },
    );
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  const check = 'expect(1).toBe(1);';

  // Um `it`/`test` por amostra: o motivo da reprovação tem de ser o título, e a amostra de controle prova que o
  // resto do arquivo passa no lint.
  it('AI-38 um it com ID no começo passa no lint', () => {
    const result = lint(
      `it('AI-38 soma dois números', () => {\n  ${check}\n});`,
    );

    expect(result.status).toBe(0);
  }, 60_000);

  it('AI-38 um it sem ID reprova o lint e a saída cita o título', () => {
    const result = lint(`it('soma dois números', () => {\n  ${check}\n});`);

    expect(result.status).toBeGreaterThan(0);
    expect(result.out).toContain('valid-title');
  }, 60_000);

  it('AI-38 um test sem ID reprova o lint', () => {
    const result = lint(`test('soma dois números', () => {\n  ${check}\n});`);

    expect(result.status).toBeGreaterThan(0);
    expect(result.out).toContain('valid-title');
  }, 60_000);

  it('AI-38 um test com ID no começo passa no lint', () => {
    const result = lint(
      `test('AI-38 soma dois números', () => {\n  ${check}\n});`,
    );

    expect(result.status).toBe(0);
  }, 60_000);

  it('AI-38 um ID composto, como DOC-MSG-01, passa no lint', () => {
    const result = lint(
      `it('DOC-MSG-01 soma dois números', () => {\n  ${check}\n});`,
    );

    expect(result.status).toBe(0);
  }, 60_000);

  it.each([
    ['o ID depois do texto', 'soma dois números AI-38'],
    ['ID em minúsculas', 'ai-38 soma dois números'],
    ['ID sem o hífen do número', 'AI38 soma dois números'],
  ])(
    'AI-38 %s reprova o lint',
    (_label, title) => {
      const result = lint(`it('${title}', () => {\n  ${check}\n});`);

      expect(result.status).toBeGreaterThan(0);
      expect(result.out).toContain('valid-title');
    },
    60_000,
  );

  it('AI-38 o describe fica livre: só it e test levam o ID', () => {
    const result = lint(
      `describe('grupo sem ID', () => {\n  it('AI-38 soma dois números', () => {\n    ${check}\n  });\n});`,
    );

    expect(result.status).toBe(0);
  }, 60_000);
});
