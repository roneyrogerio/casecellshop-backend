import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { repoRoot } from '../helpers/repo-root.ts';

// AI-36: código repetido novo reprova o `npm run verify` e o CI (jscpd), contra a linha de base das repetições que
// já existiam. O controle negativo roda o binário em dois arquivos na pasta temporária do sistema.
const jscpdBin = join(repoRoot, 'node_modules', '.bin', 'jscpd');

afterAll(cleanupTempDirs);

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}

describe('AI-36 a configuração e a fiação do jscpd', () => {
  it('AI-36 o .jscpd.json e o .jscpd-baseline.json existem na raiz e são JSON válidos', () => {
    expectValidJsonFiles('.jscpd.json', '.jscpd-baseline.json');
  });

  it('AI-36 o .jscpd.json cobre src, scripts, .claude/hooks e test', () => {
    const file = join(repoRoot, '.jscpd.json');
    const config = (
      existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    ) as { path?: unknown };
    const paths = (Array.isArray(config.path) ? config.path : []).map((entry) =>
      normalize(String(entry)),
    );

    for (const dir of ['src', 'scripts', '.claude/hooks', 'test'])
      expect(paths, dir).toContain(dir);
  });

  it('AI-36 um script do package.json chama o jscpd contra a linha de base e reprova repetição nova, e o verify e o verify:full rodam esse script', () => {
    const { body } = expectToolScriptInVerify('jscpd');

    expect(body).toMatch(/--baseline[ =]\.?\/?\.jscpd-baseline\.json/);
    expect(body).toContain('--fail-on-new-clones');
  });

  it('AI-05 o leitor do ci.yml acha o binário do jscpd e recusa npm run e npx', () => {
    expectBinaryReader(
      'jscpd',
      'node_modules/.bin/jscpd --silent',
      'npm run check:duplication',
    );
  });

  it('AI-05 o CI roda node_modules/.bin/jscpd diretamente, contra a linha de base, e não por npm run', () => {
    for (const step of expectCiRunsBinary('jscpd')) {
      expect(step.run).toMatch(/--baseline[ =]\.?\/?\.jscpd-baseline\.json/);
      expect(step.run).toContain('--fail-on-new-clones');
    }
  });
});

// Bloco de 45 linhas, igual nos dois arquivos: bem acima do mínimo de linhas e de tokens do jscpd.
function block(): string {
  const lines = ['export function repeated(input: number): number {'];
  lines.push('  let total = input;');
  for (let i = 1; i <= 20; i++) {
    lines.push(`  const step${i} = total * ${i} + input - ${i * 3};`);
    lines.push(
      `  total = step${i} > ${i * 100} ? step${i} - total : total + step${i};`,
    );
  }
  lines.push('  return total;');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

describe('AI-36 controle negativo: um bloco copiado reprova', () => {
  function setup(): {
    dir: string;
    run: (...extra: string[]) => number | null;
    // Grava a linha de base das repetições que existem agora em src/ e devolve o caminho dela.
    recordBaseline: () => string;
  } {
    const dir = makeTempDir('ai36-jscpd-');
    writeFileIn(dir, 'src/first.ts', block());
    writeFileIn(dir, 'src/second.ts', block());
    const jscpd = (...args: string[]): number | null =>
      spawnSync(
        jscpdBin,
        [join(dir, 'src'), '--silent', '--reporters', 'silent', ...args],
        { cwd: dir, encoding: 'utf8' },
      ).status;
    const recordBaseline = (): string => {
      const baseline = join(dir, 'baseline.json');
      jscpd('--baseline', baseline, '--update-baseline');
      return baseline;
    };
    return {
      dir,
      run: (...extra) => jscpd('--fail-on-new-clones', ...extra),
      recordBaseline,
    };
  }

  it('AI-36 dois arquivos com o mesmo bloco reprovam com uma linha de base vazia, com código diferente de 0', () => {
    const { dir, run } = setup();
    writeFileIn(dir, 'empty-baseline.json', '');

    expect(run('--baseline', join(dir, 'empty-baseline.json'))).toBeGreaterThan(
      0,
    );
  }, 60_000);

  it('AI-36 dois arquivos com o mesmo bloco reprovam com uma linha de base inexistente', () => {
    const { dir, run } = setup();

    expect(run('--baseline', join(dir, 'nao-existe.json'))).toBeGreaterThan(0);
  }, 60_000);

  it('AI-36 com a linha de base gerada por --update-baseline sobre os mesmos arquivos, passam com 0', () => {
    const { run, recordBaseline } = setup();
    const baseline = recordBaseline();

    expect(existsSync(baseline)).toBe(true);
    expect(run('--baseline', baseline)).toBe(0);
  }, 60_000);

  it('AI-36 uma repetição que a linha de base não tem reprova, mesmo com a base das outras', () => {
    const { dir, run, recordBaseline } = setup();
    const baseline = recordBaseline();
    // Um terceiro bloco, diferente do que a base conhece, e copiado em outro arquivo.
    const other = block()
      .replaceAll('repeated', 'other')
      .replaceAll('* ', '+ ');
    writeFileIn(dir, 'src/third.ts', other);
    writeFileIn(dir, 'src/fourth.ts', other);

    expect(run('--baseline', baseline)).toBeGreaterThan(0);
  }, 60_000);
});
