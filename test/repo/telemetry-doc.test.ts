import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderTelemetryDoc } from '../../scripts/generate-telemetry-doc.ts';
import { LOG_EVENTS, METRICS } from '../../scripts/telemetry-catalog.ts';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import { repoRoot } from '../helpers/repo-root.ts';
import { runTelemetryDoc } from '../helpers/telemetry-doc-cli.ts';

// OBS-07 (AD-029), item "Documentação" e controle negativo: o telemetry.md commitado é o que o gerador escreve hoje
// a partir do agregado de scripts/telemetry-catalog.ts. O design.md não é lido aqui: está na DOCS_ONLY_PATHS (AI-53).

const FEATURE = join(repoRoot, '.specs', 'features', 'casecellshop');

afterAll(cleanupTempDirs);

function tempFile(content: string): string {
  const dir = makeTempDir('telemetry-doc-');
  writeFileIn(dir, 'telemetry.md', content);
  return join(dir, 'telemetry.md');
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('OBS-07 a documentação gerada do catálogo de telemetria', () => {
  // Dentro do teste, e não na coleta: uma falha do gerador reprova o teste certo, e não o arquivo todo.
  const generated = () => renderTelemetryDoc(METRICS, LOG_EVENTS);

  it('OBS-07 o telemetry.md commitado é igual ao gerado do agregado (rode `npm run telemetry-doc` se divergir)', () => {
    const committed = readText(join(FEATURE, 'telemetry.md'));

    expect(
      committed,
      'telemetry.md ausente ou defasado: rode `npm run telemetry-doc` e commite',
    ).toBe(generated());
  });

  it('OBS-07 o --check do gerador sai com 0 para o telemetry.md commitado', () => {
    // O --check sem --file lê o arquivo padrão; sem o arquivo, ele já tem de reprovar.
    expect(readText(join(FEATURE, 'telemetry.md'))).not.toBe('');

    const result = runTelemetryDoc('--check');

    expect(result.status, result.stderr).toBe(0);
  });

  it('OBS-07 o script telemetry-doc do package.json roda o gerador', () => {
    const pkg = JSON.parse(readText(join(repoRoot, 'package.json'))) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts['telemetry-doc']).toBe(
      'node scripts/generate-telemetry-doc.ts',
    );
  });

  it('OBS-07 controle negativo: um telemetry.md com uma linha a mais é acusado pelo --check', () => {
    const file = tempFile(`${generated()}linha a mais\n`);

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run telemetry-doc');
  });

  it('OBS-07 controle negativo: um telemetry.md com uma linha a menos é acusado pelo --check', () => {
    const lines = generated().split('\n');
    const file = tempFile([...lines.slice(0, 8), ...lines.slice(9)].join('\n'));

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status).toBe(1);
  });
});
