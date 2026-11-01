import { afterAll, describe, expect, it } from 'vitest';
import {
  expectBinaryReader,
  expectCiRunsBinary,
  expectToolScriptInVerify,
  expectValidJsonFiles,
} from '../helpers/ci-workflow.ts';
import {
  cleanupTempDirs,
  makeTempDir,
  writeFileIn,
} from '../helpers/git-sandbox.ts';
import { repoBin } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-35: código sem uso reprova o `npm run verify` e o CI (knip). A configuração, o script do verify e o passo do CI
// são conferidos aqui; o controle negativo roda o binário num projeto mínimo na pasta temporária do sistema.
const knipBin = repoBin('knip');

afterAll(cleanupTempDirs);

describe('AI-35 a configuração e a fiação do knip', () => {
  it('AI-35 o knip.json existe na raiz e é um JSON válido', () => {
    expectValidJsonFiles('knip.json');
  });

  it('AI-35 um script do package.json chama o knip, e o verify e o verify:full rodam esse script', () => {
    expectToolScriptInVerify('knip');
  });

  it('AI-05 o leitor do ci.yml acha o binário do knip e recusa npm run e npx', () => {
    expectBinaryReader(
      'knip',
      'node_modules/.bin/knip',
      'npm run check:unused',
    );
  });

  it('AI-05 o CI roda node_modules/.bin/knip diretamente, e não por npm run', () => {
    expectCiRunsBinary('knip');
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
    const result = runCommand(knipBin, ['--no-progress'], { cwd: dir });
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
