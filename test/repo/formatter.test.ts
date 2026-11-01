import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFileInfo } from 'prettier';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { cleanupTempDirs, makeTempDir } from '../helpers/git-sandbox.ts';
import { repoRoot as root } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-34: o formato do código é o do Prettier. A configuração, o `.prettierignore`, o `verify`, o CI e o hook
// do settings.json são conferidos aqui; a decisão do hook fica em .claude/hooks/format-edited.test.ts.
const prettierBin = join(root, 'node_modules', '.bin', 'prettier');

afterAll(cleanupTempDirs);

function readText(...parts: string[]): string {
  try {
    return readFileSync(join(root, ...parts), 'utf8');
  } catch {
    return '';
  }
}

describe('AI-34 o .prettierrc.json e o .prettierignore', () => {
  it('AI-34 o .prettierrc.json usa aspas simples e deixa a largura no padrão (80)', () => {
    const config = JSON.parse(readText('.prettierrc.json') || '{}') as Record<
      string,
      unknown
    >;

    expect(config.singleQuote).toBe(true);
    expect(config).not.toHaveProperty('printWidth');
  });

  const IGNORED = ['openapi.yaml', 'src/db/types/', 'package-lock.json'];

  it.each(IGNORED)('AI-34 o .prettierignore lista %s', (entry) => {
    const lines = readText('.prettierignore')
      .split('\n')
      .map((line) => line.trim().replace(/^\//, '').replace(/\/$/, ''));

    expect(lines).toContain(entry.replace(/\/$/, ''));
  });

  // Só a pasta da raiz: sem a barra no início, o padrão casaria também test/fixtures/migrations/, que é formatada.
  it('AI-34 o .prettierignore lista /migrations/, com a barra no início, e não migrations/ sem ela', () => {
    const lines = readText('.prettierignore')
      .split('\n')
      .map((line) => line.trim());

    expect(lines).toContain('/migrations/');
    expect(lines).not.toContain('migrations/');
  });

  it('AI-34 o Prettier não ignora as fixtures de migração de test/fixtures/migrations/', async () => {
    const info = await getFileInfo(
      join(root, 'test/fixtures/migrations/basic/20260101000000_create_a.ts'),
      { ignorePath: join(root, '.prettierignore') },
    );

    expect(info.ignored).toBe(false);
  });

  // Sem o .prettierignore (--ignore-path vazio): um arquivo ignorado passaria em silêncio, e aqui o que se prova é o formato.
  it('AI-34 os arquivos de test/fixtures/migrations/ passam no prettier --check', () => {
    const result = runCommand(
      prettierBin,
      [
        '--check',
        '--ignore-unknown',
        '--ignore-path',
        '/dev/null',
        'test/fixtures/migrations',
      ],
      { cwd: root },
    );

    expect(`${result.stdout}${result.stderr}`).not.toContain(
      'Code style issues',
    );
    expect(result.stdout + result.stderr).toContain(
      'All matched files use Prettier code style',
    );
    expect(result.status).toBe(0);
  });

  it('AI-34 o .prettierignore lista o Markdown (*.md)', () => {
    const lines = readText('.prettierignore')
      .split('\n')
      .map((line) => line.trim());

    expect(lines.some((line) => line === '*.md' || line === '**/*.md')).toBe(
      true,
    );
  });

  // O Prettier decide, e não a leitura das linhas: o padrão escrito tem de casar com o caminho de verdade.
  it.each([
    'openapi.yaml',
    'src/db/types/db.d.ts',
    'package-lock.json',
    'migrations/core/20260101000000_amostra.ts',
    'README.md',
    '.specs/features/casecellshop/spec.md',
  ])('AI-34 o Prettier ignora %s', async (path) => {
    const info = await getFileInfo(join(root, path), {
      ignorePath: join(root, '.prettierignore'),
    });

    expect(info.ignored).toBe(true);
  });

  // Controle negativo: o .prettierignore não pode ter virado um "ignora tudo".
  it.each([
    'src/app.ts',
    'package.json',
    'scripts/check-scripts.ts',
    '.claude/settings.json',
  ])('AI-34 o Prettier não ignora %s', async (path) => {
    const info = await getFileInfo(join(root, path), {
      ignorePath: join(root, '.prettierignore'),
    });

    expect(info.ignored).toBe(false);
  });
});

describe('AI-34 controle negativo: um arquivo fora do formato reprova o prettier --check', () => {
  // O arquivo fica numa pasta temporária fora do repositório; a configuração do projeto entra por --config.
  function check(content: string): { status: number | null; output: string } {
    const file = join(makeTempDir('ai34-check-'), 'amostra.ts');
    writeFileSync(file, content);
    const result = runCommand(
      prettierBin,
      ['--config', join(root, '.prettierrc.json'), '--check', file],
      { cwd: root },
    );
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
    };
  }

  // O motivo da reprovação tem de ser o formato, e não uma configuração ausente (que também sai com código != 0).
  it('AI-34 um .ts com aspas duplas e espaços a mais reprova com código diferente de 0 por problema de estilo', () => {
    const result = check('const   texto   =   "a" ;\n');

    expect(result.status).toBeGreaterThan(0);
    expect(result.output).toContain('Code style issues');
  });

  it('AI-34 o mesmo arquivo formatado (aspas simples) passa com 0', () => {
    const result = check("const texto = 'a';\n");

    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Code style issues');
  });
});

interface Pkg {
  scripts: Record<string, string>;
}

const pkg = JSON.parse(readText('package.json')) as Pkg;

describe('AI-34 o package.json', () => {
  it('AI-34 o script format:check roda prettier --check .', () => {
    expect(pkg.scripts['format:check']).toBe('prettier --check .');
  });

  it.each(['verify', 'verify:full'])(
    'AI-34 o %s roda npm run format:check (o pre-push reprova arquivo fora do formato)',
    (name) => {
      const steps = (pkg.scripts[name] ?? '')
        .split('&&')
        .map((step) => step.trim());

      expect(steps).toContain('npm run format:check');
    },
  );
});

interface Step {
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: Step[] }>;
}

// O PR pode redefinir um script do package.json; por isso o CI roda o binário, como as outras conferências (AI-05).
function runsPrettierCheck(workflow: Workflow): boolean {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .some((step) =>
      /(^|\s)(?:\.\/)?node_modules\/\.bin\/prettier\s+--check(\s|$)/.test(
        step.run ?? '',
      ),
    );
}

describe('AI-34 o ci.yml', () => {
  it('AI-34 o leitor do ci.yml acha o binário do Prettier com --check e recusa npm run e prettier sem --check', () => {
    const job = (run: string) =>
      parse(`jobs:\n  a:\n    steps:\n      - run: ${run}\n`) as Workflow;

    expect(runsPrettierCheck(job('node_modules/.bin/prettier --check .'))).toBe(
      true,
    );
    expect(runsPrettierCheck(job('npm run format:check'))).toBe(false);
    expect(runsPrettierCheck(job('node_modules/.bin/prettier --write .'))).toBe(
      false,
    );
    expect(
      runsPrettierCheck(job('echo node_modules/.bin/prettier-fake --check .')),
    ).toBe(false);
  });

  it('AI-34 tem um passo que roda node_modules/.bin/prettier --check', () => {
    const ci = parse(readText('.github', 'workflows', 'ci.yml')) as Workflow;

    expect(runsPrettierCheck(ci)).toBe(true);
  });
});

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command?: string }[];
}

// O matcher do Claude Code é uma regex ancorada sobre o nome da ferramenta.
function matches(matcher: string | undefined, toolName: string): boolean {
  return new RegExp(`^(?:${matcher ?? ''})$`).test(toolName);
}

describe('AI-34 o hook do settings.json', () => {
  const settings = JSON.parse(readText('.claude', 'settings.json')) as {
    hooks?: Record<string, HookEntry[]>;
  };
  const entry = (settings.hooks?.PostToolUse ?? []).find((candidate) =>
    candidate.hooks.some((hook) =>
      (hook.command ?? '').includes('.claude/hooks/format-edited.mjs'),
    ),
  );

  it('AI-34 o PostToolUse roda o format-edited.mjs com node', () => {
    expect(entry).toBeDefined();
    expect(entry?.hooks.every((hook) => hook.type === 'command')).toBe(true);
    expect(
      entry?.hooks.some((hook) => /^node\s/.test(hook.command ?? '')),
    ).toBe(true);
  });

  it('AI-34 o matcher cobre o Edit e o Write e não cobre o Bash nem o Read', () => {
    expect(matches(entry?.matcher, 'Edit')).toBe(true);
    expect(matches(entry?.matcher, 'Write')).toBe(true);
    expect(matches(entry?.matcher, 'Bash')).toBe(false);
    expect(matches(entry?.matcher, 'Read')).toBe(false);
  });
});
