import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../helpers/ci-workflow.ts';

// AI-45: o commitlint do projeto ignora os commits assinados pelo `dependabot[bot]`, cujo corpo traz as notas de
// versão em linhas longas; o commit de qualquer outro autor com corpo longo continua reprovando. Roda o binário do
// projeto, com a configuração da raiz, sobre uma mensagem pela entrada padrão.
const commitlintBin = join(repoRoot, 'node_modules', '.bin', 'commitlint');
const DEPENDABOT_SIGNATURE =
  'Signed-off-by: dependabot[bot] <support@github.com>';

// Uma linha de corpo bem acima dos 100 caracteres, sem URL (o commitlint ignora linhas com link).
const LONG_LINE = `Notas da versão: ${'uma frase longa de notas de versão '.repeat(5)}`;

function commitMessage(
  signature: string | null,
  header = 'build(deps): bump x from 1.0.0 to 1.0.1',
): string {
  const lines = [header, '', 'Bumps x from 1.0.0 to 1.0.1.', LONG_LINE];
  if (signature !== null) lines.push('', signature);
  return `${lines.join('\n')}\n`;
}

function lintMessage(message: string): { status: number | null; out: string } {
  const result = spawnSync(commitlintBin, [], {
    cwd: repoRoot,
    input: message,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('AI-45 o commitlint ignora só os commits assinados pelo dependabot[bot]', () => {
  it('AI-45 o corpo com linha de mais de 100 caracteres reprova sem assinatura (controle negativo)', () => {
    expect(LONG_LINE.length).toBeGreaterThan(100);
    const result = lintMessage(commitMessage(null));

    expect(result.status).toBeGreaterThan(0);
    expect(result.out).toContain('body-max-line-length');
  }, 90_000);

  it('AI-45 o mesmo commit assinado pelo dependabot[bot] passa', () => {
    const result = lintMessage(commitMessage(DEPENDABOT_SIGNATURE));

    expect(result.out).not.toContain('body-max-line-length');
    expect(result.status).toBe(0);
  }, 90_000);

  it('AI-45 o commit das actions, com cabeçalho ci(deps) e a assinatura do dependabot[bot], passa', () => {
    const result = lintMessage(
      commitMessage(
        DEPENDABOT_SIGNATURE,
        'ci(deps): bump y from 1.0.0 to 1.1.0',
      ),
    );

    expect(result.out).not.toContain('body-max-line-length');
    expect(result.status).toBe(0);
  }, 90_000);

  // A assinatura sozinha não basta: o commit de um agente com o cabeçalho de outro tipo, ou de um escopo que não é
  // `deps`, não escapa do commitlint por copiar a linha de assinatura.
  it.each(['feat: algo', 'chore(deps): x'])(
    'AI-45 o commit com a assinatura do dependabot[bot] e o cabeçalho "%s" continua reprovando',
    (header) => {
      const result = lintMessage(commitMessage(DEPENDABOT_SIGNATURE, header));

      expect(result.status).toBeGreaterThan(0);
      expect(result.out).toContain('body-max-line-length');
    },
    90_000,
  );

  it('AI-45 o commit assinado por outro autor continua reprovando', () => {
    const result = lintMessage(commitMessage('Signed-off-by: alguem <a@b.c>'));

    expect(result.status).toBeGreaterThan(0);
    expect(result.out).toContain('body-max-line-length');
  }, 90_000);
});
