import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(
  /\/$/,
  '',
);

// Referência do Claude Code (conferida em 30/10/2026). O Claude Code ignora campo
// desconhecido e pula o agente cujo YAML não abre, sem avisar; por isso a conferência é aqui.
const AGENT_FIELDS = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'permissionMode',
  'maxTurns',
  'autoCompactWindow',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'omitClaudeMd',
  'effort',
  'isolation',
  'color',
  'initialPrompt',
  'experimental',
];

const SKILL_FIELDS = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'disable-model-invocation',
  'user-invocable',
  'allowed-tools',
  'disallowed-tools',
  'model',
  'effort',
  'context',
  'agent',
  'background',
  'hooks',
  'paths',
  'shell',
  'metadata',
  'license',
  'compatibility',
];

const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable', 'inherit'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_AGENT_NAME = 256;
const MAX_SKILL_LISTING = 1536;

type Frontmatter = { data: Record<string, unknown> } | { problem: string };

function frontmatter(raw: string): Frontmatter {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---')
    return { problem: 'o arquivo não começa com --- na primeira linha' };
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) return { problem: 'o bloco não fecha com ---' };
  let data: unknown;
  try {
    data = parse(lines.slice(1, end).join('\n'));
  } catch (error) {
    return {
      problem: `o YAML não abre: ${(error as Error).message.split('\n')[0]}`,
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { problem: 'o YAML não é um mapa' };
  }
  return { data: data as Record<string, unknown> };
}

function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function unknownFields(
  data: Record<string, unknown>,
  allowed: string[],
): string[] {
  return Object.keys(data)
    .filter((key) => !allowed.includes(key))
    .map((key) => `campo desconhecido: ${key}`);
}

function effortProblems(data: Record<string, unknown>): string[] {
  if (!('effort' in data)) return [];
  return typeof data.effort === 'string' && EFFORTS.includes(data.effort)
    ? []
    : [`effort inválido: ${String(data.effort)}`];
}

function agentProblems(fileName: string, raw: string): string[] {
  const parsed = frontmatter(raw);
  if ('problem' in parsed) return [parsed.problem];
  const { data } = parsed;
  const problems = unknownFields(data, AGENT_FIELDS);

  if (!isFilled(data.name)) problems.push('name ausente ou vazio');
  else {
    const name = data.name;
    if (name !== fileName.replace(/\.md$/, ''))
      problems.push(`name diferente do arquivo: ${name}`);
    if (name.includes(':')) problems.push('name com ":"');
    if (name.startsWith('-')) problems.push('name começa com "-"');
    if (name.length > MAX_AGENT_NAME)
      problems.push(`name com mais de ${MAX_AGENT_NAME} caracteres`);
  }
  if (!isFilled(data.description))
    problems.push('description ausente ou vazia');

  if ('model' in data) {
    const model = data.model;
    const valid =
      typeof model === 'string' &&
      (MODEL_ALIASES.includes(model) || /^claude-./.test(model));
    if (!valid) problems.push(`model inválido: ${String(model)}`);
  }
  problems.push(...effortProblems(data));
  return problems;
}

function skillProblems(raw: string): string[] {
  const parsed = frontmatter(raw);
  if ('problem' in parsed) return [parsed.problem];
  const { data } = parsed;
  const problems = unknownFields(data, SKILL_FIELDS);

  if (!isFilled(data.description))
    problems.push('description ausente ou vazia');
  else {
    const whenToUse =
      typeof data.when_to_use === 'string' ? data.when_to_use : '';
    if (data.description.length + whenToUse.length > MAX_SKILL_LISTING) {
      problems.push(
        `description + when_to_use passa de ${MAX_SKILL_LISTING} caracteres`,
      );
    }
  }
  problems.push(...effortProblems(data));
  return problems;
}

function agentNames(agents: { fileName: string; raw: string }[]): string[] {
  return agents.flatMap(({ raw }) => {
    const parsed = frontmatter(raw);
    return 'data' in parsed && typeof parsed.data.name === 'string'
      ? [parsed.data.name]
      : [];
  });
}

function duplicateNameProblems(
  agents: { fileName: string; raw: string }[],
): string[] {
  const names = agentNames(agents);
  return names
    .filter((name, index) => names.indexOf(name) !== index)
    .map((name) => `name repetido: ${name}`);
}

function matcherProblems(
  names: string[],
  matcher: unknown,
  event: string,
): string[] {
  if (typeof matcher !== 'string') return [`${event} sem matcher`];
  const matched = matcher.split('|');
  const problems: string[] = [];
  for (const name of names)
    if (!matched.includes(name)) problems.push(`${event} sem o agente ${name}`);
  for (const name of matched)
    if (!names.includes(name))
      problems.push(`${event} com nome sem agente: ${name}`);
  return problems;
}

function block(lines: string[]): string {
  return ['---', ...lines, '---', '', 'Corpo.', ''].join('\n');
}

const validAgent = block([
  'name: demo',
  'description: Faz uma coisa.',
  'model: sonnet',
  'effort: high',
]);
const validSkill = block([
  'name: marco',
  'description: Roda um marco.',
  'argument-hint: "<m>"',
]);

function realAgents(): { fileName: string; raw: string }[] {
  const dir = path.join(root, '.claude/agents');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((fileName) => ({
      fileName,
      raw: readFileSync(path.join(dir, fileName), 'utf8'),
    }));
}

function settingsMatcher(event: string): unknown {
  const settings = JSON.parse(
    readFileSync(path.join(root, '.claude/settings.json'), 'utf8'),
  ) as {
    hooks?: Record<string, { matcher?: unknown }[] | undefined>;
  };
  return settings.hooks?.[event]?.[0]?.matcher;
}

describe('AI-13 frontmatter dos agentes e da skill: arquivos reais', () => {
  it('AI-13 existem agentes em .claude/agents e a skill marco', () => {
    expect(realAgents().length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, '.claude/skills/marco/SKILL.md'))).toBe(
      true,
    );
  });

  for (const { fileName, raw } of realAgents()) {
    it(`AI-13 o frontmatter do agente ${fileName} é válido`, () => {
      expect(agentProblems(fileName, raw)).toEqual([]);
    });
  }

  it('AI-13 o frontmatter da skill marco é válido', () => {
    const raw = readFileSync(
      path.join(root, '.claude/skills/marco/SKILL.md'),
      'utf8',
    );
    expect(skillProblems(raw)).toEqual([]);
  });

  it('AI-13 os nomes dos agentes são únicos', () => {
    expect(duplicateNameProblems(realAgents())).toEqual([]);
  });

  it('AI-13 os nomes dos agentes são exatamente os do matcher do SubagentStart', () => {
    expect(
      matcherProblems(
        agentNames(realAgents()),
        settingsMatcher('SubagentStart'),
        'SubagentStart',
      ),
    ).toEqual([]);
  });

  it('AI-13 os nomes dos agentes são exatamente os do matcher do SubagentStop', () => {
    expect(
      matcherProblems(
        agentNames(realAgents()),
        settingsMatcher('SubagentStop'),
        'SubagentStop',
      ),
    ).toEqual([]);
  });
});

describe('AI-13 controle negativo: cada regra reprova o frontmatter quebrado', () => {
  it('AI-13 controle positivo: frontmatter válido inventado passa sem problemas', () => {
    expect(agentProblems('demo.md', validAgent)).toEqual([]);
    expect(skillProblems(validSkill)).toEqual([]);
  });

  it('AI-13 reprova YAML que não abre', () => {
    const problems = agentProblems(
      'demo.md',
      block(['name: [x', 'description: x']),
    );
    expect(problems.some((p) => p.startsWith('o YAML não abre'))).toBe(true);
    expect(
      skillProblems(block(['description: [x'])).some((p) =>
        p.startsWith('o YAML não abre'),
      ),
    ).toBe(true);
  });

  it('AI-13 reprova YAML que abre mas não é um mapa', () => {
    expect(agentProblems('demo.md', block(['- a', '- b']))).toContain(
      'o YAML não é um mapa',
    );
    expect(agentProblems('demo.md', block([]))).toContain(
      'o YAML não é um mapa',
    );
  });

  it('AI-13 reprova bloco que não começa com --- na primeira linha', () => {
    const lateStart = `\n${validAgent}`;
    expect(agentProblems('demo.md', lateStart)).toContain(
      'o arquivo não começa com --- na primeira linha',
    );
    expect(skillProblems(lateStart)).toContain(
      'o arquivo não começa com --- na primeira linha',
    );
  });

  it('AI-13 reprova bloco que não fecha com ---', () => {
    const open = '---\nname: demo\ndescription: x\n';
    expect(agentProblems('demo.md', open)).toContain(
      'o bloco não fecha com ---',
    );
    expect(skillProblems(open)).toContain('o bloco não fecha com ---');
  });

  it('AI-13 reprova campo desconhecido no agente', () => {
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'maxTurn: 3']),
      ),
    ).toEqual(['campo desconhecido: maxTurn']);
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'Model: opus']),
      ),
    ).toEqual(['campo desconhecido: Model']);
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'allowed-tools: Read']),
      ),
    ).toEqual(['campo desconhecido: allowed-tools']);
  });

  it('AI-13 reprova campo desconhecido na skill', () => {
    expect(skillProblems(block(['description: x', 'maxTurn: 3']))).toEqual([
      'campo desconhecido: maxTurn',
    ]);
  });

  it('AI-13 aceita campo da skill que o agente não tem e o contrário', () => {
    expect(
      skillProblems(block(['description: x', 'allowed-tools: Read'])),
    ).toEqual([]);
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'allowed-tools: Read']),
      ),
    ).not.toEqual([]);
    expect(skillProblems(block(['description: x', 'maxTurns: 3']))).not.toEqual(
      [],
    );
  });

  it('AI-13 reprova agente sem name', () => {
    expect(agentProblems('demo.md', block(['description: x']))).toContain(
      'name ausente ou vazio',
    );
    expect(
      agentProblems('demo.md', block(['name: ""', 'description: x'])),
    ).toContain('name ausente ou vazio');
  });

  it('AI-13 reprova description ausente ou vazia no agente', () => {
    expect(agentProblems('demo.md', block(['name: demo']))).toContain(
      'description ausente ou vazia',
    );
    expect(
      agentProblems('demo.md', block(['name: demo', 'description: ""'])),
    ).toContain('description ausente ou vazia');
  });

  it('AI-13 reprova description ausente ou vazia na skill', () => {
    expect(skillProblems(block(['name: marco']))).toContain(
      'description ausente ou vazia',
    );
    expect(skillProblems(block(['description: ""']))).toContain(
      'description ausente ou vazia',
    );
  });

  it('AI-13 reprova name diferente do nome do arquivo', () => {
    expect(agentProblems('outro.md', validAgent)).toContain(
      'name diferente do arquivo: demo',
    );
  });

  it('AI-13 reprova name com ":"', () => {
    expect(
      agentProblems('a:b.md', block(['name: "a:b"', 'description: x'])),
    ).toContain('name com ":"');
  });

  it('AI-13 reprova name que começa com "-"', () => {
    expect(
      agentProblems('-demo.md', block(['name: -demo', 'description: x'])),
    ).toContain('name começa com "-"');
  });

  it('AI-13 reprova name com 257 caracteres e aceita 256', () => {
    const long = 'a'.repeat(257);
    expect(
      agentProblems(`${long}.md`, block([`name: ${long}`, 'description: x'])),
    ).toContain('name com mais de 256 caracteres');
    const limit = 'a'.repeat(256);
    expect(
      agentProblems(`${limit}.md`, block([`name: ${limit}`, 'description: x'])),
    ).toEqual([]);
  });

  it('AI-13 reprova model que não é documentado', () => {
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'model: gpt-4']),
      ),
    ).toContain('model inválido: gpt-4');
  });

  it('AI-13 aceita os apelidos de model e IDs claude-', () => {
    for (const model of [...MODEL_ALIASES, 'claude-sonnet-5-5']) {
      expect(
        agentProblems(
          'demo.md',
          block(['name: demo', 'description: x', `model: ${model}`]),
        ),
      ).toEqual([]);
    }
  });

  it('AI-13 reprova effort que não é documentado, no agente e na skill', () => {
    expect(
      agentProblems(
        'demo.md',
        block(['name: demo', 'description: x', 'effort: extreme']),
      ),
    ).toContain('effort inválido: extreme');
    expect(
      skillProblems(block(['description: x', 'effort: extreme'])),
    ).toContain('effort inválido: extreme');
  });

  it('AI-13 aceita todos os valores documentados de effort', () => {
    for (const effort of EFFORTS) {
      expect(
        agentProblems(
          'demo.md',
          block(['name: demo', 'description: x', `effort: ${effort}`]),
        ),
      ).toEqual([]);
      expect(
        skillProblems(block(['description: x', `effort: ${effort}`])),
      ).toEqual([]);
    }
  });

  it('AI-13 reprova dois agentes com o mesmo name', () => {
    const agents = [
      { fileName: 'demo.md', raw: validAgent },
      { fileName: 'copia.md', raw: validAgent },
    ];
    expect(duplicateNameProblems(agents)).toEqual(['name repetido: demo']);
    expect(
      duplicateNameProblems([agents[0] as (typeof agents)[number]]),
    ).toEqual([]);
  });

  it('AI-13 reprova matcher com um nome a mais', () => {
    expect(matcherProblems(['a', 'b'], 'a|b|c', 'SubagentStart')).toEqual([
      'SubagentStart com nome sem agente: c',
    ]);
  });

  it('AI-13 reprova matcher com um nome a menos', () => {
    expect(matcherProblems(['a', 'b', 'c'], 'a|b', 'SubagentStop')).toEqual([
      'SubagentStop sem o agente c',
    ]);
  });

  it('AI-13 reprova matcher ausente e aceita matcher igual ao conjunto, em qualquer ordem', () => {
    expect(matcherProblems(['a'], undefined, 'SubagentStart')).toEqual([
      'SubagentStart sem matcher',
    ]);
    expect(matcherProblems(['a', 'b'], 'b|a', 'SubagentStart')).toEqual([]);
  });

  it('AI-13 reprova skill com description de 1537 caracteres e aceita 1536', () => {
    expect(
      skillProblems(block([`description: ${'a'.repeat(1537)}`])),
    ).toContain('description + when_to_use passa de 1536 caracteres');
    expect(skillProblems(block([`description: ${'a'.repeat(1536)}`]))).toEqual(
      [],
    );
  });

  it('AI-13 reprova skill cuja description somada ao when_to_use passa de 1536 caracteres', () => {
    const lines = [
      `description: ${'a'.repeat(1000)}`,
      `when_to_use: ${'b'.repeat(537)}`,
    ];
    expect(skillProblems(block(lines))).toContain(
      'description + when_to_use passa de 1536 caracteres',
    );
    const fits = [
      `description: ${'a'.repeat(1000)}`,
      `when_to_use: ${'b'.repeat(536)}`,
    ];
    expect(skillProblems(block(fits))).toEqual([]);
  });
});
