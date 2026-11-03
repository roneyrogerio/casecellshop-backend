import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  initRepo,
  makeTempDir,
} from '../helpers/git-sandbox.ts';
import config from '../../vitest.config.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-17: o pre-push roda o `npm run verify` e o git exporta GIT_DIR e companhia para o hook. Um teste que monta um
// repositório temporário e chama `git` herdaria as variáveis e mudaria o repositório de verdade (config, branches,
// HEAD). Aqui um Vitest filho roda uma amostra que faz isso (test/fixtures/git-env/), com as variáveis apontando para
// um repositório "vítima", e o teste confere se a vítima mudou.
const sample = 'test/fixtures/git-env/mutate-temp-repo.test.ts';
const vitestBin = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const setupFile = join(root, 'test', 'helpers', 'git-env-setup.ts');

afterEach(cleanupTempDirs);

interface Project {
  test?: { name?: string; setupFiles?: string | string[] };
}

function withoutGitVariables(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    // O Vitest filho não pode achar que é um worker do pai.
    if (!name.startsWith('GIT_') && !name.startsWith('VITEST')) {
      env[name] = value;
    }
  }
  return env;
}

interface Snapshot {
  config: string;
  refs: string;
  head: string;
}

// Lê a vítima pelo --git-dir e sem GIT_*, para a própria leitura não depender do ambiente do teste.
function snapshot(victim: string): Snapshot {
  const gitDir = join(victim, '.git');
  const read = (...args: string[]) =>
    runCommand('git', ['--git-dir', gitDir, ...args], {
      env: withoutGitVariables(),
    }).stdout;
  return {
    config: readFileSync(join(gitDir, 'config'), 'utf8'),
    refs: read('for-each-ref', '--format=%(refname) %(objectname)'),
    head: `${readFileSync(join(gitDir, 'HEAD'), 'utf8')}${read('rev-parse', 'HEAD')}`,
  };
}

function makeVictim(): { victim: string; before: Snapshot } {
  const victim = makeTempDir('git-env-victim-');
  initRepo(victim);
  return { victim, before: snapshot(victim) };
}

// As variáveis que o git exporta para um hook, apontando para a vítima.
function hookEnv(victim: string): NodeJS.ProcessEnv {
  return {
    ...withoutGitVariables(),
    GIT_DIR: join(victim, '.git'),
    GIT_WORK_TREE: victim,
    GIT_INDEX_FILE: join(victim, '.git', 'index'),
    GIT_COMMON_DIR: join(victim, '.git'),
  };
}

// Config do Vitest sem dependências (o arquivo mora fora do repositório e não resolve `vitest/config`), com a
// mesma amostra e, ou não, o arquivo de setup.
function writeConfig(withSetup: boolean): string {
  const dir = makeTempDir('git-env-config-');
  const file = join(dir, 'vitest.config.mjs');
  const config = {
    root,
    test: {
      include: [sample],
      ...(withSetup ? { setupFiles: [setupFile] } : {}),
    },
  };
  writeFileSync(file, `export default ${JSON.stringify(config)};\n`);
  return file;
}

function runVitest(args: string[], env: NodeJS.ProcessEnv) {
  return runCommand(process.execPath, [vitestBin, 'run', ...args], {
    cwd: root,
    env,
    timeout: 90_000,
  });
}

describe('AI-17 os testes não herdam as variáveis GIT_* de um hook do git', () => {
  // Controle negativo: sem o setup, a amostra muda o repositório vítima. Prova que a amostra e o ambiente exportado
  // de fato alcançam o repositório de verdade; sem isto, "a vítima não mudou" não provaria nada.
  it('AI-17 controle: sem o setup, a amostra com GIT_DIR herdado muda a config, as branches e o HEAD da vítima', () => {
    const { victim, before } = makeVictim();

    runVitest(['--config', writeConfig(false)], hookEnv(victim));

    const after = snapshot(victim);
    expect(after.config).not.toBe(before.config);
    expect(after.refs).not.toBe(before.refs);
    expect(after.head).not.toBe(before.head);
  }, 120_000);

  it.each([
    [
      'o git-env-setup.ts sozinho protege a vítima',
      () => ['--config', writeConfig(true)],
    ],
    [
      'com o vitest.config.ts do projeto, a amostra roda no projeto unit e a vítima do GIT_DIR herdado não muda',
      () => [
        '--project',
        'unit',
        '--config',
        join(root, 'vitest.config.ts'),
        sample,
      ],
    ],
  ])(
    'AI-17 %s',
    (_name, args) => {
      const { victim, before } = makeVictim();

      const result = runVitest(args(), hookEnv(victim));

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toMatch(/1 passed/);
      expect(snapshot(victim)).toEqual(before);
    },
    120_000,
  );

  // A configuração é lida como objeto (o que o Vitest recebe), e não como texto.
  it('AI-17 o vitest.config.ts registra o git-env-setup.ts primeiro, antes do property-setup.ts, no unit e no integration', () => {
    const { test } = config as unknown as { test?: { projects?: Project[] } };
    const setupOf = (name: string): string[] => {
      const files = test?.projects?.find((item) => item.test?.name === name)
        ?.test?.setupFiles;
      return typeof files === 'string' ? [files] : (files ?? []);
    };

    expect(setupOf('unit')[0]).toMatch(/git-env-setup\.ts$/);
    expect(setupOf('integration')[0]).toMatch(/git-env-setup\.ts$/);
    expect(setupOf('unit')[1]).toMatch(/property-setup\.ts$/);
  });
});
