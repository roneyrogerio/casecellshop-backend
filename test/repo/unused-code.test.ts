import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  readCi,
  repoRoot,
  runsBinary,
  runsToolThroughNpm,
  workflowOf,
} from '../helpers/ci-workflow.ts';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';

// AI-35: código sem uso reprova o `npm run verify` e o CI (knip). A configuração, o script do verify e o passo do CI
// são conferidos aqui; o controle negativo roda o binário num projeto mínimo na pasta temporária do sistema.
const knipBin = join(repoRoot, 'node_modules', '.bin', 'knip');

afterAll(cleanupTempDirs);

const pkg = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

describe('AI-35 a configuração e a fiação do knip', () => {
  it('AI-35 o knip.json existe na raiz e é um JSON válido', () => {
    const file = join(repoRoot, 'knip.json');

    expect(existsSync(file)).toBe(true);
    expect(() => {
      JSON.parse(readFileSync(file, 'utf8'));
    }).not.toThrow();
  });

  it('AI-35 um script do package.json chama o knip, e o verify e o verify:full rodam esse script', () => {
    const names = Object.entries(pkg.scripts)
      .filter(([, body]) => /^knip(\s|$)/.test(body.trim()))
      .map(([name]) => name);

    expect(names).toHaveLength(1);
    for (const script of ['verify', 'verify:full']) {
      const steps = (pkg.scripts[script] ?? '')
        .split('&&')
        .map((step) => step.trim());
      expect(steps, script).toContain(`npm run ${names[0]}`);
    }
  });

  it('AI-05 o leitor do ci.yml acha o binário do knip e recusa npm run e npx', () => {
    expect(
      runsBinary(workflowOf('node_modules/.bin/knip'), 'knip'),
    ).toHaveLength(1);
    expect(runsBinary(workflowOf('npm run check:unused'), 'knip')).toHaveLength(
      0,
    );
    expect(runsBinary(workflowOf('npx knip'), 'knip')).toHaveLength(0);
    expect(runsToolThroughNpm(workflowOf('npm run knip'), 'knip')).toHaveLength(
      1,
    );
  });

  it('AI-05 o CI roda node_modules/.bin/knip diretamente, e não por npm run', () => {
    const ci = readCi();

    expect(runsBinary(ci, 'knip').length).toBeGreaterThan(0);
    expect(runsToolThroughNpm(ci, 'knip')).toHaveLength(0);
  });
});

describe('AI-35 controle negativo: o knip acusa um export que ninguém importa', () => {
  function runKnip(importsBoth: boolean): {
    status: number | null;
    out: string;
  } {
    const dir = makeTempDir('ai35-knip-');
    writeFileIn(
      dir,
      'package.json',
      JSON.stringify({ name: 'amostra', version: '0.0.0', type: 'module' }),
    );
    writeFileIn(
      dir,
      'knip.json',
      JSON.stringify({ entry: ['index.ts'], project: ['*.ts'] }),
    );
    writeFileIn(
      dir,
      'lib.ts',
      'export function usedHelper(): number {\n  return 1;\n}\n\nexport function neverImportedHelper(): number {\n  return 2;\n}\n',
    );
    writeFileIn(
      dir,
      'index.ts',
      importsBoth
        ? "import { neverImportedHelper, usedHelper } from './lib.ts';\n\nconsole.log(usedHelper() + neverImportedHelper());\n"
        : "import { usedHelper } from './lib.ts';\n\nconsole.log(usedHelper());\n",
    );
    const result = spawnSync(knipBin, ['--no-progress'], {
      cwd: dir,
      encoding: 'utf8',
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  it('AI-35 um export novo sem uso sai com código diferente de 0 e cita o nome dele', () => {
    const result = runKnip(false);

    expect(result.status).toBeGreaterThan(0);
    expect(result.out).toContain('neverImportedHelper');
  }, 60_000);

  it('AI-35 o mesmo projeto com o export importado sai com 0', () => {
    const result = runKnip(true);

    expect(result.out).not.toContain('neverImportedHelper');
    expect(result.status).toBe(0);
  }, 60_000);
});
