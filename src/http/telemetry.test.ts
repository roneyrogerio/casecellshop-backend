import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../../test/helpers/git-sandbox.ts';
import { typecheckSample } from '../../test/helpers/lint-tree.ts';
import { repoRoot } from '../../test/helpers/repo-root.ts';

// OBS-07 (AD-029): a gravação da duração HTTP é tipada pela declaração. O atributo `required` é obrigatório, e o
// `conditionally_required` (o `error.type`, só no 5xx) é opcional. A prova é o tsc do projeto sobre uma amostra
// que importa o acessor real: um erro de tipo não se prova por execução.

afterAll(cleanupTempDirs);

const DURATION = 'http.server.request.duration';

// O acessor da pasta, como as outras pastas o têm (`httpMetrics(telemetry)`), sobre o `Telemetry` real.
function sample(attributes: string[]): string {
  return `import { httpMetrics } from '${repoRoot}/src/http/telemetry.ts';
import { createTelemetry } from '${repoRoot}/src/shared/telemetry.ts';

const metrics = httpMetrics(createTelemetry());
metrics.record('${DURATION}', 0.01, {
${attributes.map((attribute) => `  ${attribute},`).join('\n')}
});
`;
}

const REQUIRED = [
  "'http.request.method': 'GET'",
  "'http.route': '/products'",
  "'http.response.status_code': 200",
  "'url.scheme': 'http'",
];

describe('OBS-07 tipo da gravação da duração HTTP', () => {
  it('OBS-07 uma gravação sem http.request.method reprova no tsc, e o erro cita o atributo', () => {
    const result = typecheckSample(
      'obs07-http-tsc-',
      sample(REQUIRED.filter((line) => !line.includes('http.request.method'))),
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(result.output).toContain('amostra.ts');
    // O erro tem de ser o do atributo, e não o de um acessor que falta.
    expect(result.output).not.toContain('has no exported member');
    expect(result.output).toContain('http.request.method');
  }, 60_000);

  it('OBS-07 uma gravação sem error.type compila, porque ele é conditionally_required', () => {
    const result = typecheckSample('obs07-http-tsc-', sample(REQUIRED));

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);

  it('OBS-07 uma gravação com error.type compila também', () => {
    const result = typecheckSample(
      'obs07-http-tsc-',
      sample([...REQUIRED, "'error.type': '503'"]),
    );

    expect(result.output).toBe('');
    expect(result.status).toBe(0);
  }, 60_000);
});
