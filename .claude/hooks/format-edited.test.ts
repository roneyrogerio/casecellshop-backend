import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupTempDirs,
  makeTempDir,
} from '../../test/helpers/git-sandbox.ts';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);
const hook = join(root, '.claude', 'hooks', 'format-edited.mjs');

// O hook decide pelo nome da ferramenta e pelo `file_path` (AI-34); a tabela inteira roda dentro do processo.
let targetToFormat: (input: unknown) => string | null;

beforeAll(async () => {
  ({ targetToFormat } = (await import(pathToFileURL(hook).href)) as {
    targetToFormat: typeof targetToFormat;
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
      const file = join(makeTempDir('ai34-hook-'), 'amostra.ts');
      writeFileSync(file, MESSY);

      const result = runHook(edited(toolName, file));

      expect(result.code).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(FORMATTED);
    },
  );

  it('AI-34 outra ferramenta não formata nada', () => {
    const file = join(makeTempDir('ai34-hook-'), 'amostra.ts');
    writeFileSync(file, MESSY);

    const result = runHook(edited('Bash', file));

    expect(result.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(MESSY);
  });

  it('AI-34 uma extensão que o Prettier não conhece fica como está (--ignore-unknown)', () => {
    const dir = makeTempDir('ai34-hook-');
    const unknown = join(dir, 'amostra.desconhecida');
    const known = join(dir, 'amostra.ts');
    writeFileSync(unknown, MESSY);
    writeFileSync(known, MESSY);

    expect(runHook(edited('Write', unknown)).code).toBe(0);
    expect(readFileSync(unknown, 'utf8')).toBe(MESSY);
    // Prova de que o Prettier de fato rodou no mesmo cenário: a extensão conhecida muda.
    expect(runHook(edited('Write', known)).code).toBe(0);
    expect(readFileSync(known, 'utf8')).toBe(FORMATTED);
  });

  // Formatar é conveniência: a garantia é o --check do pre-push e do CI. O hook nunca falha a ferramenta.
  it('AI-34 se o Prettier falha (sintaxe inválida, arquivo ausente, entrada sem JSON) o hook ainda sai com 0 e o próximo arquivo é formatado', () => {
    const dir = makeTempDir('ai34-hook-');
    const broken = join(dir, 'quebrado.ts');
    const good = join(dir, 'bom.ts');
    writeFileSync(broken, 'const = ;;{\n');
    writeFileSync(good, MESSY);

    expect(runHook(edited('Edit', broken)).code).toBe(0);
    expect(runHook(edited('Edit', join(dir, 'nao-existe.ts'))).code).toBe(0);
    expect(runHook('isto não é JSON').code).toBe(0);
    expect(runHook(edited('Edit', good)).code).toBe(0);

    expect(readFileSync(broken, 'utf8')).toBe('const = ;;{\n');
    expect(readFileSync(good, 'utf8')).toBe(FORMATTED);
  });
});
