import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'test', 'fixtures');
const committed = readFileSync(join(root, 'openapi.yaml'), 'utf8');

let workDir: string;

beforeEach(() => {
  mkdirSync(fixturesDir, { recursive: true });
  workDir = mkdtempSync(join(fixturesDir, 'openapi-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function generate(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/generate-openapi.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function lint(file: string) {
  return spawnSync(
    join(root, 'node_modules', '.bin', 'redocly'),
    ['lint', file],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, REDOCLY_TELEMETRY: 'off' },
    },
  );
}

function writeCopy(name: string, content: string): string {
  const file = join(workDir, name);
  writeFileSync(file, content);
  return file;
}

describe('FND-07 openapi.yaml commitado igual ao gerado e válido', () => {
  it('FND-07 o --check sai com 0 para o openapi.yaml da raiz', () => {
    const result = generate('--check');

    expect(result.status, result.stderr).toBe(0);
  });

  it('FND-07 o --check com --file sai com 0 para uma cópia idêntica ao commitado', () => {
    const copy = writeCopy('igual.yaml', committed);

    expect(generate('--check', '--file', copy).status).toBe(0);
  });

  it('FND-07 o --check sai com 1 para uma cópia alterada do openapi.yaml', () => {
    const content = committed.replace(
      'title: CaseCellShop API',
      'title: CaseCellShop API alterada',
    );
    expect(content).not.toBe(committed);
    const altered = writeCopy('alterado.yaml', content);

    const result = generate('--check', '--file', altered);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toBe('');
  });

  it('FND-07 o --check sai com 1 quando o arquivo comparado não existe', () => {
    const result = generate(
      '--check',
      '--file',
      join(workDir, 'inexistente.yaml'),
    );

    expect(result.status).toBe(1);
  });

  it('FND-07 o --check não reescreve o arquivo comparado', () => {
    const content = committed.replace('version: 0.1.0', 'version: 9.9.9');
    expect(content).not.toBe(committed);
    const altered = writeCopy('intacto.yaml', content);
    const before = readFileSync(altered, 'utf8');

    generate('--check', '--file', altered);

    expect(readFileSync(altered, 'utf8')).toBe(before);
  });

  it('FND-07 o redocly lint do openapi.yaml sai com 0', () => {
    const result = lint('openapi.yaml');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('FND-07 o redocly lint sai com código diferente de 0 para um OpenAPI sem licença', () => {
    // Prova que o lint do CI reprova: a regra info-license é de erro no recommended-strict.
    const withoutLicense = committed.replace(/ {2}license:\n(?: {4}.*\n)+/, '');
    expect(withoutLicense).not.toBe(committed);
    const file = writeCopy('sem-licenca.yaml', withoutLicense);

    const result = lint(file);

    expect(result.status).not.toBe(0);
  });
});
