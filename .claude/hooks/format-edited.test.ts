import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  git,
  initRepo,
  makeTempDir,
  writeFileIn,
} from '../../test/helpers/git-sandbox.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);
const hook = join(root, '.claude', 'hooks', 'format-edited.mjs');

// O hook decide pelo nome da ferramenta e pelo `file_path` (AI-34); a tabela inteira roda dentro do processo.
let targetToFormat: (input: unknown) => string | null;
// Os argumentos do Prettier para um arquivo: o caminho vai depois de `--`, para um nome que começa com `-` não virar opção.
let prettierArgs: (file: string) => string[];

beforeAll(async () => {
  ({ targetToFormat, prettierArgs } = (await import(
    pathToFileURL(hook).href
  )) as {
    targetToFormat: typeof targetToFormat;
    prettierArgs: typeof prettierArgs;
  });
});

afterAll(cleanupTempDirs);

describe('AI-34 o hook depois do Edit e do Write escolhe o arquivo a formatar', () => {
  it.each(['Edit', 'Write'])(
    'AI-34 %s com file_path devolve esse caminho',
    (toolName) => {
      expect(
        targetToFormat({
          hook_event_name: 'PostToolUse',
          tool_name: toolName,
          tool_input: { file_path: '/repo/src/app.ts' },
        }),
      ).toBe('/repo/src/app.ts');
    },
  );

  it.each([
    'Bash',
    'Read',
    'Skill',
    'SubagentHandback',
    'NotebookEdit',
    'edit',
  ])(
    'AI-34 %s, que não é o Edit nem o Write, devolve null mesmo com file_path',
    (toolName) => {
      expect(
        targetToFormat({
          tool_name: toolName,
          tool_input: { file_path: '/repo/src/app.ts' },
        }),
      ).toBeNull();
    },
  );

  it.each([
    ['sem tool_input', { tool_name: 'Edit' }],
    ['com tool_input vazio', { tool_name: 'Write', tool_input: {} }],
    [
      'com file_path que não é texto',
      { tool_name: 'Edit', tool_input: { file_path: 42 } },
    ],
    ['sem tool_name', { tool_input: { file_path: '/repo/src/app.ts' } }],
  ])('AI-34 entrada %s devolve null', (_label, input) => {
    expect(targetToFormat(input)).toBeNull();
  });
});

interface Run {
  code: number | null;
  stdout: string;
}

// O processo roda na raiz do repositório, de onde vem o Prettier instalado (`node_modules/.bin/prettier`).
function runHook(raw: string, projectDir: string = root): Run {
  const result = spawnSync(process.execPath, [hook], {
    input: raw,
    encoding: 'utf8',
    cwd: projectDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return { code: result.status, stdout: result.stdout };
}

function edited(toolName: string, filePath: string): string {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
  });
}

// Fora do formato com qualquer configuração: ponto e vírgula dobrado e espaços a mais.
const MESSY = 'const   a   =   1;;\n';
const FORMATTED = 'const a = 1;\n';

describe('AI-34 o hook como processo (stdin, arquivo, código de saída)', () => {
  it.each(['Edit', 'Write'])(
    'AI-34 depois do %s o arquivo editado sai formatado e o hook termina com 0',
    (toolName) => {
      const project = makeProject();
      const file = join(project, 'amostra.ts');
      writeFileSync(file, MESSY);

      const result = runHook(edited(toolName, file), project);

      expect(result.code).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(FORMATTED);
    },
  );

  it('AI-34 outra ferramenta não formata nada', () => {
    const project = makeProject();
    const file = join(project, 'amostra.ts');
    writeFileSync(file, MESSY);

    const result = runHook(edited('Bash', file), project);

    expect(result.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 uma extensão que o Prettier não conhece fica como está (--ignore-unknown)', () => {
    const project = makeProject();
    const unknown = join(project, 'amostra.desconhecida');
    const known = join(project, 'amostra.ts');
    writeFileSync(unknown, MESSY);
    writeFileSync(known, MESSY);

    expect(runHook(edited('Write', unknown), project).code).toBe(0);
    expect(readFileSync(unknown, 'utf8')).toBe(MESSY);
    // Prova de que o Prettier de fato rodou no mesmo cenário: a extensão conhecida muda.
    expect(runHook(edited('Write', known), project).code).toBe(0);
    expect(readFileSync(known, 'utf8')).toBe(FORMATTED);
  });

  // Formatar é conveniência: a garantia é o --check do pre-push e do CI. O hook nunca falha a ferramenta.
  it('AI-34 se o Prettier falha (sintaxe inválida, arquivo ausente, entrada sem JSON) o hook ainda sai com 0 e o próximo arquivo é formatado', () => {
    const project = makeProject();
    const broken = join(project, 'quebrado.ts');
    const good = join(project, 'bom.ts');
    writeFileSync(broken, 'const = ;;{\n');
    writeFileSync(good, MESSY);

    expect(runHook(edited('Edit', broken), project).code).toBe(0);
    expect(
      runHook(edited('Edit', join(project, 'nao-existe.ts')), project).code,
    ).toBe(0);
    expect(runHook('isto não é JSON', project).code).toBe(0);
    expect(runHook(edited('Edit', good), project).code).toBe(0);

    expect(readFileSync(broken, 'utf8')).toBe('const = ;;{\n');
    expect(readFileSync(good, 'utf8')).toBe(FORMATTED);
  });
});

describe('AI-34 o hook passa -- antes do caminho', () => {
  it.each(['/repo/src/app.ts', '/repo/--version.ts', '/repo/-w.ts'])(
    'AI-34 os argumentos para %s terminam em -- e no caminho, depois das opções',
    (file) => {
      const args = prettierArgs(file);

      expect(args.slice(-2)).toEqual(['--', file]);
      expect(args).toContain('--write');
      expect(args).toContain('--ignore-unknown');
      expect(args.indexOf('--write')).toBeLessThan(args.indexOf('--'));
      expect(args.indexOf('--ignore-unknown')).toBeLessThan(args.indexOf('--'));
    },
  );
});

// Um projeto temporário com o Prettier ligado, como o repositório real.
function makeProject(project: string = makeTempDir('ai34-project-')): string {
  mkdirSync(project, { recursive: true });
  initRepo(project);
  writeFileIn(project, '.prettierrc.json', '{}\n');
  symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'));
  return project;
}

describe('AI-34 o hook só formata um caminho absoluto dentro de CLAUDE_PROJECT_DIR', () => {
  it('AI-34 controle: um arquivo cujo nome começa com -- dentro do projeto é formatado, e não lido como opção', () => {
    const project = makeProject();
    const file = join(project, '--version.ts');
    writeFileSync(file, MESSY);

    expect(runHook(edited('Write', file), project).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(FORMATTED);
  });

  it('AI-34 um caminho absoluto fora do projeto não é formatado, mesmo num repositório com .prettierrc e node_modules', () => {
    const project = makeProject();
    const outside = makeProject();
    const file = join(outside, 'src', 'fora.ts');
    writeFileIn(outside, 'src/fora.ts', MESSY);

    expect(runHook(edited('Edit', file), project).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 um caminho absoluto fora do projeto, noutro lugar da pasta temporária, não é formatado', () => {
    const project = makeProject();
    const file = join(makeTempDir('ai34-solto-'), 'solto.ts');
    writeFileSync(file, MESSY);

    expect(runHook(edited('Write', file), project).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 uma pasta irmã com o mesmo prefixo do projeto não conta como dentro dele', () => {
    const parent = makeTempDir('ai34-pai-');
    const project = makeProject(join(parent, 'app'));
    const sibling = makeProject(join(parent, 'app-outro'));
    const file = join(sibling, 'src', 'irmao.ts');
    writeFileIn(sibling, 'src/irmao.ts', MESSY);

    expect(runHook(edited('Edit', file), project).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 um caminho absoluto com .. que sai do projeto não é formatado', () => {
    const project = makeProject();
    const outside = makeProject();
    const file = join(outside, 'src', 'fora.ts');
    writeFileIn(outside, 'src/fora.ts', MESSY);

    expect(
      runHook(
        edited('Edit', `${project}/src/../../${basename(outside)}/src/fora.ts`),
        project,
      ).code,
    ).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 um caminho relativo não é formatado, mesmo apontando para um arquivo do projeto', () => {
    const project = makeProject();
    const file = join(project, 'src', 'rel.ts');
    writeFileIn(project, 'src/rel.ts', MESSY);

    expect(runHook(edited('Edit', 'src/rel.ts'), project).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });
});

// A pasta principal ignora `.claude/worktrees/` (as worktrees dos agentes moram lá dentro). O Prettier
// lê o .prettierignore a partir do cwd, então o hook precisa olhar a raiz da worktree, não a principal.
function sandboxWithAgentWorktree(): { main: string; worktree: string } {
  const main = makeTempDir('ai34-main-');
  initRepo(main);
  writeFileIn(main, '.prettierignore', '.claude/worktrees/\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'prettierignore');
  const worktree = join(main, '.claude', 'worktrees', 'agente');
  git(main, 'worktree', 'add', '-q', '-b', 'agente', worktree);
  // Como o worktree.symlinkDirectories: o Prettier fica acessível nas duas raízes.
  symlinkSync(join(root, 'node_modules'), join(main, 'node_modules'));
  symlinkSync(join(root, 'node_modules'), join(worktree, 'node_modules'));
  // Só a worktree ignora essa pasta: prova que o .prettierignore usado é o dela.
  writeFileIn(worktree, '.prettierignore', '.claude/worktrees/\nisolado/\n');
  return { main, worktree };
}

describe('AI-34 o hook formata também na worktree do agente, com o .prettierignore da raiz dela', () => {
  it('AI-34 arquivo editado na worktree do agente sai formatado, com CLAUDE_PROJECT_DIR na pasta principal', () => {
    const { main, worktree } = sandboxWithAgentWorktree();
    const file = join(worktree, 'src', 'amostra.ts');
    writeFileIn(worktree, 'src/amostra.ts', MESSY);

    expect(runHook(edited('Edit', file), main).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(FORMATTED);
  });

  it('AI-34 controle negativo: arquivo que o .prettierignore da worktree ignora continua fora do formato', () => {
    const { main, worktree } = sandboxWithAgentWorktree();
    const ignored = join(worktree, 'isolado', 'amostra.ts');
    writeFileIn(worktree, 'isolado/amostra.ts', MESSY);

    // O mesmo cenário do primeiro teste prova que o Prettier roda na worktree; aqui só a pasta ignorada.
    expect(runHook(edited('Write', ignored), main).code).toBe(0);

    expect(readFileSync(ignored, 'utf8')).toBe(MESSY);
  });

  it('AI-34 controle: arquivo editado na própria pasta principal continua formatado', () => {
    const { main } = sandboxWithAgentWorktree();
    const file = join(main, 'src', 'amostra.ts');
    writeFileIn(main, 'src/amostra.ts', MESSY);

    expect(runHook(edited('Edit', file), main).code).toBe(0);

    expect(readFileSync(file, 'utf8')).toBe(FORMATTED);
  });
});
