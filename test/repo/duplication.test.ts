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

// AI-36: código repetido novo reprova o `npm run verify` e o CI (jscpd), contra a linha de base das repetições que
// já existiam. O controle negativo roda o binário em dois arquivos na pasta temporária do sistema.
const jscpdBin = join(repoRoot, 'node_modules', '.bin', 'jscpd');

afterAll(cleanupTempDirs);

const pkg = JSON.parse(
  readFileSync(join(repoRoot, 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/+$/, '');
}

describe('AI-36 a configuração e a fiação do jscpd', () => {
  it('AI-36 o .jscpd.json e o .jscpd-baseline.json existem na raiz e são JSON válidos', () => {
    for (const name of ['.jscpd.json', '.jscpd-baseline.json']) {
      const file = join(repoRoot, name);

      expect(existsSync(file), name).toBe(true);
      expect(() => {
        JSON.parse(readFileSync(file, 'utf8'));
      }, name).not.toThrow();
    }
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
    const entries = Object.entries(pkg.scripts).filter(([, body]) =>
      /^jscpd(\s|$)/.test(body.trim()),
    );

    expect(entries).toHaveLength(1);
    const [name, body] = entries[0] ?? ['', ''];
    expect(body).toMatch(/--baseline[ =]\.?\/?\.jscpd-baseline\.json/);
    expect(body).toContain('--fail-on-new-clones');
    for (const script of ['verify', 'verify:full']) {
      const steps = (pkg.scripts[script] ?? '')
        .split('&&')
        .map((step) => step.trim());
      expect(steps, script).toContain(`npm run ${name}`);
    }
  });

  it('AI-05 o leitor do ci.yml acha o binário do jscpd e recusa npm run e npx', () => {
    expect(
      runsBinary(workflowOf('node_modules/.bin/jscpd --silent'), 'jscpd'),
    ).toHaveLength(1);
    expect(
      runsBinary(workflowOf('npm run check:duplication'), 'jscpd'),
    ).toHaveLength(0);
    expect(runsBinary(workflowOf('npx jscpd'), 'jscpd')).toHaveLength(0);
    expect(
      runsToolThroughNpm(workflowOf('npm run jscpd'), 'jscpd'),
    ).toHaveLength(1);
  });

  it('AI-05 o CI roda node_modules/.bin/jscpd diretamente, contra a linha de base, e não por npm run', () => {
    const ci = readCi();
    const steps = runsBinary(ci, 'jscpd');

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.run).toMatch(/--baseline[ =]\.?\/?\.jscpd-baseline\.json/);
      expect(step.run).toContain('--fail-on-new-clones');
    }
    expect(runsToolThroughNpm(ci, 'jscpd')).toHaveLength(0);
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
  } {
    const dir = makeTempDir('ai36-jscpd-');
    writeFileIn(dir, 'src/first.ts', block());
    writeFileIn(dir, 'src/second.ts', block());
    const run = (...extra: string[]): number | null =>
      spawnSync(
        jscpdBin,
        [
          join(dir, 'src'),
          '--silent',
          '--reporters',
          'silent',
          '--fail-on-new-clones',
          ...extra,
        ],
        { cwd: dir, encoding: 'utf8' },
      ).status;
    return { dir, run };
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
    const { dir, run } = setup();
    const baseline = join(dir, 'baseline.json');
    spawnSync(
      jscpdBin,
      [
        join(dir, 'src'),
        '--silent',
        '--reporters',
        'silent',
        '--baseline',
        baseline,
        '--update-baseline',
      ],
      { cwd: dir, encoding: 'utf8' },
    );

    expect(existsSync(baseline)).toBe(true);
    expect(run('--baseline', baseline)).toBe(0);
  }, 60_000);

  it('AI-36 uma repetição que a linha de base não tem reprova, mesmo com a base das outras', () => {
    const { dir, run } = setup();
    const baseline = join(dir, 'baseline.json');
    spawnSync(
      jscpdBin,
      [
        join(dir, 'src'),
        '--silent',
        '--reporters',
        'silent',
        '--baseline',
        baseline,
        '--update-baseline',
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    // Um terceiro bloco, diferente do que a base conhece, e copiado em outro arquivo.
    const other = block()
      .replaceAll('repeated', 'other')
      .replaceAll('* ', '+ ');
    writeFileIn(dir, 'src/third.ts', other);
    writeFileIn(dir, 'src/fourth.ts', other);

    expect(run('--baseline', baseline)).toBeGreaterThan(0);
  }, 60_000);
});
