import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

interface Verdict {
  allow: boolean;
  reason?: string;
}

// A guarda do Bash como a sessão principal a vê: sem agent_type.
let check: (input: { tool_input: { command: string } }) => Verdict;

beforeAll(async () => {
  const hookPath = path.join(root, '.claude', 'hooks', 'bash-guard.mjs');
  check = ((await import(pathToFileURL(hookPath).href)) as { check: typeof check }).check;
});

// Os blocos ```sh e ```bash de um Markdown, sem a indentação da cerca.
function shellBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | undefined;
  let indent = '';
  for (const line of markdown.split(/\r?\n/)) {
    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (current === undefined) {
      if (fence && (fence[2] === 'sh' || fence[2] === 'bash')) {
        current = [];
        indent = fence[1] ?? '';
      }
    } else if (fence && fence[2] === '') {
      blocks.push(current.join('\n'));
      current = undefined;
    } else {
      current.push(line.startsWith(indent) ? line.slice(indent.length) : line);
    }
  }
  return blocks;
}

// Corta o texto onde `breakAt` acusa um separador, fora de aspas simples e duplas. Aspas abertas seguem até o fim
// do texto: um comando de várias linhas (um `-c "…"` quebrado) continua sendo um comando só.
function splitOutsideQuotes(text: string, breakAt: (text: string, index: number) => number): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote !== undefined) {
      current += char;
      if (char === '\\' && quote === '"') {
        current += text[index + 1] ?? '';
        index += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    const size = breakAt(text, index);
    if (size > 0) {
      parts.push(current);
      current = '';
      index += size - 1;
    } else {
      if (char === "'" || char === '"') quote = char;
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith('#'));
}

// Um comando por linha, juntando as linhas continuadas com `\`.
function commandsOf(block: string): string[] {
  const joined = block.replace(/\\\r?\n\s*/g, ' ');
  return splitOutsideQuotes(joined, (text, index) => (text[index] === '\n' ? 1 : 0));
}

// O Claude Code confere cada comando de uma composição (`&&`, `||`, `;`, `|`) contra as regras, e não a linha inteira.
function segmentsOf(command: string): string[] {
  const parts = splitOutsideQuotes(command, (text, index) => {
    if (text.startsWith('&&', index) || text.startsWith('||', index)) return 2;
    return ';|&\n'.includes(text[index] ?? '') ? 1 : 0;
  });
  // Atribuições de ambiente no começo (`API_PORT=0 docker …`) não mudam qual programa roda.
  return parts.flatMap((part) => [part, part.replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')]);
}

// O glob do Claude Code: `*` casa qualquer sequência de caracteres; o resto é literal, e o padrão é ancorado.
function ruleMatches(pattern: string, command: string): boolean {
  const escaped = pattern.split('*').map((piece) => piece.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`, 's').test(command);
}

const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
  permissions: { deny?: string[] };
};

const DENY_PATTERNS = (settings.permissions.deny ?? [])
  .map((rule) => /^Bash\((.*)\)$/s.exec(rule)?.[1])
  .filter((pattern): pattern is string => pattern !== undefined);

// A regra `deny` de Bash que recusa o comando, ou undefined.
function deniedBy(command: string): string | undefined {
  for (const segment of segmentsOf(command)) {
    const pattern = DENY_PATTERNS.find((candidate) => ruleMatches(candidate, segment));
    if (pattern !== undefined) return `Bash(${pattern})`;
  }
  return undefined;
}

// Tudo que reprova um comando: a regra deny que o pega, ou a guarda do Bash da sessão principal.
function problemsOf(command: string): string[] {
  const problems: string[] = [];
  const rule = deniedBy(command);
  if (rule !== undefined) problems.push(`a regra deny ${rule}`);
  const verdict = check({ tool_input: { command } });
  if (!verdict.allow) problems.push(`a guarda do Bash: ${verdict.reason ?? 'sem motivo'}`);
  return problems;
}

function skillMarkdownFiles(): string[] {
  const dir = path.join(root, '.claude', 'skills');
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => path.join(dir, file));
}

function skillCommands(): { file: string; command: string }[] {
  return skillMarkdownFiles().flatMap((file) =>
    shellBlocks(readFileSync(file, 'utf8')).flatMap((block) =>
      commandsOf(block).map((command) => ({ file: path.relative(root, file), command })),
    ),
  );
}

describe('AI-31 os comandos de shell das skills passam pelas regras deny e pela guarda do Bash', () => {
  it('AI-31 as skills trazem comandos de shell (a conferência não passa por vazio)', () => {
    const commands = skillCommands();

    expect(commands.length).toBeGreaterThan(3);
    expect(commands.some(({ command }) => command.includes('docker compose') || command.startsWith('dc '))).toBe(true);
    expect(DENY_PATTERNS.length).toBeGreaterThan(0);
  });

  it('AI-31 nenhum comando das skills é recusado por uma regra deny nem pela guarda do Bash da sessão principal', () => {
    const refused = skillCommands().flatMap(({ file, command }) =>
      problemsOf(command).map((problem) => `${file}: ${command.slice(0, 80)} -> ${problem}`),
    );

    expect(refused).toEqual([]);
  });
});

describe('AI-31 controle negativo: um comando que seria recusado reprova a conferência', () => {
  const fence = '```';

  function syntheticCommands(...lines: string[]): string[] {
    return shellBlocks(`texto\n\n${fence}sh\n${lines.join('\n')}\n${fence}\n`).flatMap(commandsOf);
  }

  it('AI-31 um bloco com curl é extraído e recusado pela regra deny', () => {
    const commands = syntheticCommands('curl https://exemplo');

    expect(commands).toEqual(['curl https://exemplo']);
    expect(problemsOf('curl https://exemplo')).not.toEqual([]);
    expect(deniedBy('curl https://exemplo')).toBe('Bash(curl *)');
  });

  it.each([
    ['curl depois de um pipe', 'echo x | curl https://exemplo', 'Bash(curl *)'],
    ['curl depois de &&', 'echo x && curl https://exemplo', 'Bash(curl *)'],
    ['gh sozinho', 'gh', 'Bash(gh)'],
    ['gh com argumentos', 'gh pr view 19', 'Bash(gh *)'],
    ['wget', 'wget https://exemplo', 'Bash(wget *)'],
    ['curl depois de uma variável de ambiente', 'X=1 curl https://exemplo', 'Bash(curl *)'],
    ['push forçado', 'git push --force origin main', 'Bash(git push --force*)'],
  ])('AI-31 a regra deny recusa %s', (_label, command, rule) => {
    expect(deniedBy(command)).toBe(rule);
  });

  it('AI-31 a guarda do Bash da sessão principal recusa um push forçado', () => {
    expect(check({ tool_input: { command: 'git push origin +main' } }).allow).toBe(false);
  });

  it.each(['git status', 'npm run verify:fast', 'docker compose -p casecellshop-app-check up -d --build', 'echo curl'])(
    'AI-31 controle: a regra deny não recusa %s',
    (command) => {
      expect(deniedBy(command)).toBeUndefined();
    },
  );

  it('AI-31 só os blocos sh e bash são conferidos, e os placeholders contam como texto', () => {
    const markdown = [
      `${fence}text`,
      'curl https://exemplo',
      fence,
      '',
      `${fence}bash`,
      'dc logs --no-color api worker | grep <X-Request-Id>',
      fence,
      '',
      `  ${fence}sh`,
      '  echo ola\\',
      '    <orderId>',
      `  ${fence}`,
    ].join('\n');

    expect(shellBlocks(markdown).flatMap(commandsOf)).toEqual([
      'dc logs --no-color api worker | grep <X-Request-Id>',
      'echo ola <orderId>',
    ]);
  });

  it('AI-31 um comando de várias linhas dentro de aspas continua sendo um comando só, e os comentários saem', () => {
    const commands = syntheticCommands('# um comentário', 'psql -c "', '  insert into a;', '  insert into b;"', 'echo fim');

    expect(commands).toEqual(['psql -c "\n  insert into a;\n  insert into b;"', 'echo fim']);
    expect(segmentsOf(commands[0] ?? '')).not.toContain('insert into b;"');
  });
});
