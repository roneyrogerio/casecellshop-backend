import { tmpdir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);

function read(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

function lineCount(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function listFiles(relativeDir: string, extension: string): string[] {
  const dir = path.join(root, relativeDir);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(extension))
        found.push(path.relative(root, full));
    }
  }
  return found.sort();
}

// Itens de lista da seção `## Read` que mandam ler o AGENTS.md.
function agentsMdReadItems(content: string): string[] {
  const items: string[] = [];
  let inRead = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('## ')) inRead = /^## Read\s*$/.test(line);
    else if (
      inRead &&
      /^\s*(?:[-*]|\d+\.)\s/.test(line) &&
      line.includes('`AGENTS.md`')
    )
      items.push(line);
  }
  return items;
}

const SKILL = '.claude/skills/marco/SKILL.md';

// Links Markdown relativos do texto cujo alvo não existe na pasta dada.
// Links com esquema (https:, mailto:) e só de âncora (#secao) ficam fora; a
// âncora e a query de um link para arquivo são descartadas antes de conferir.
function brokenRelativeLinks(text: string, dir: string): string[] {
  const broken: string[] = [];
  for (const match of text.matchAll(
    /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
  )) {
    const target = match[1] as string;
    if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const file = target.split(/[#?]/)[0] as string;
    if (file === '') continue;
    if (!existsSync(path.join(dir, decodeURIComponent(file))))
      broken.push(target);
  }
  return broken;
}

describe('AI-07 a skill marco', () => {
  it('AI-07 o .claude/skills/marco/SKILL.md existe', () => {
    expect(existsSync(path.join(root, SKILL))).toBe(true);
  });

  it('AI-07 o frontmatter da skill tem disable-model-invocation: true', () => {
    const content = read(SKILL);

    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content);

    expect(
      frontmatter,
      'a skill não começa com um bloco de frontmatter',
    ).not.toBeNull();
    expect(frontmatter?.[1]).toMatch(/^disable-model-invocation:\s*true\s*$/m);
  });

  it('AI-07 a skill tem até 500 linhas', () => {
    expect(lineCount(read(SKILL))).toBeLessThanOrEqual(500);
  });
});

describe('AI-07 os links relativos da skill marco', () => {
  const skillDir = path.join(root, path.dirname(SKILL));

  // Pasta temporária do sistema com a.md e sub/b.md, removida ao fim de cada uso.
  function brokenIn(text: string): string[] {
    const tmp = mkdtempSync(path.join(tmpdir(), 'ai07-links-'));
    try {
      mkdirSync(path.join(tmp, 'sub'));
      writeFileSync(path.join(tmp, 'a.md'), '');
      writeFileSync(path.join(tmp, 'sub', 'b.md'), '');
      return brokenRelativeLinks(text, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('AI-07 todo link relativo do SKILL.md aponta para um arquivo que existe', () => {
    expect(brokenRelativeLinks(read(SKILL), skillDir)).toEqual([]);
  });

  it('AI-07 o SKILL.md linka o arquivo de apoio delegation.md e ele existe', () => {
    expect(read(SKILL)).toMatch(/\]\(delegation\.md(?:#[^)\s]*)?\)/);
    expect(existsSync(path.join(skillDir, 'delegation.md'))).toBe(true);
  });

  it('AI-07 o conferidor reprova e cita um link para arquivo de apoio inexistente (controle negativo)', () => {
    const text = `${read(SKILL)}\nVeja [x](nao-existe.md).\n`;

    expect(brokenRelativeLinks(text, skillDir)).toEqual(['nao-existe.md']);
  });

  it('AI-07 o conferidor reprova link com âncora para arquivo inexistente', () => {
    expect(brokenIn('[x](nao-existe.md#secao)')).toEqual([
      'nao-existe.md#secao',
    ]);
  });

  it('AI-07 o conferidor aceita link com âncora e link em subpasta existentes', () => {
    const text = '[a](a.md#secao) e [b](sub/b.md) e [c](sub/b.md#x)';

    expect(brokenIn(text)).toEqual([]);
  });

  it('AI-07 o conferidor reprova link em subpasta inexistente', () => {
    expect(brokenIn('[b](sub/c.md)')).toEqual(['sub/c.md']);
  });

  it('AI-07 o conferidor ignora link absoluto e link só de âncora', () => {
    const text =
      '[w](https://example.com/x.md) [m](mailto:a@b.c) [s](#secao-que-nao-existe)';

    expect(brokenIn(text)).toEqual([]);
  });
});

describe('AI-07 o AGENTS.md não descreve o roteiro do marco', () => {
  it.each([
    '## Workflow',
    '## GitHub',
    '## Decision records',
    '## Models and effort',
  ])('AI-07 o AGENTS.md não tem o título %s', (heading) => {
    const titles = read('AGENTS.md')
      .split('\n')
      .map((line) => line.trimEnd());

    expect(titles).not.toContain(heading);
  });

  it('AI-07 o AGENTS.md não tem a expressão "Escalation ladder"', () => {
    expect(read('AGENTS.md')).not.toMatch(/escalation ladder/i);
  });
});

describe('AI-07 nenhum agente manda ler o AGENTS.md', () => {
  const agents = listFiles('.claude/agents', '.md');

  it('AI-07 há agentes em .claude/agents/ para conferir', () => {
    expect(agents.length).toBeGreaterThan(0);
  });

  it.each(agents)(
    'AI-07 %s não lista o AGENTS.md na seção ## Read',
    (agent) => {
      expect(agentsMdReadItems(read(agent))).toEqual([]);
    },
  );

  it('AI-07 o leitor acusa um item de lista com o AGENTS.md na seção ## Read (controle negativo)', () => {
    const content = [
      '# x',
      '',
      '## Read',
      '',
      '- `AGENTS.md`.',
      '- `spec.md`.',
      '',
      '## Write',
      '',
    ].join('\n');

    expect(agentsMdReadItems(content)).toEqual(['- `AGENTS.md`.']);
  });

  it('AI-07 o leitor ignora o AGENTS.md citado fora da seção ## Read', () => {
    const content = [
      '## Read',
      '',
      '- `spec.md`.',
      '',
      '## Never',
      '',
      '- Editar o `AGENTS.md`.',
      '',
    ].join('\n');

    expect(agentsMdReadItems(content)).toEqual([]);
  });
});

describe('AI-07 não existe agente planner nem menção a ele nas instruções', () => {
  it('AI-07 o .claude/agents/planner.md não existe', () => {
    expect(existsSync(path.join(root, '.claude/agents/planner.md'))).toBe(
      false,
    );
  });

  const files = [
    'AGENTS.md',
    'CLAUDE.md',
    ...listFiles('.claude/agents', '.md'),
    ...listFiles('.claude/skills', '.md'),
    '.github/pull_request_template.md',
  ];

  it.each(files)('AI-07 %s não menciona o planner', (file) => {
    expect(read(file)).not.toMatch(/\bplanner\b/i);
  });
});
