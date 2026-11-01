import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

const APP_CHECK = '.claude/skills/app-check/SKILL.md';
const MARCO = '.claude/skills/marco/SKILL.md';
const SETTINGS = '.claude/settings.json';
const PROJECT_FLAG = '-p casecellshop-app-check';

// A receita escreve `dc` no lugar de `docker compose -p casecellshop-app-check`, ou o comando inteiro.
const COMPOSE = String.raw`(?:docker compose ${PROJECT_FLAG}|\bdc)`;

// Cada passo da receita do AI-22, como um padrão sobre o texto da skill.
const RECIPE_STEPS: [string, RegExp][] = [
  ['sobe o compose (docker compose up)', new RegExp(`${COMPOSE} up\\b`)],
  ['faz um checkout (/checkout)', /\/checkout/],
  ['acompanha o status até invoiced', /invoiced/],
  ['lê o /metrics do worker', /\/metrics/],
  [
    'lê os logs do worker (docker compose logs)',
    new RegExp(`${COMPOSE} logs\\b`),
  ],
  ['derruba o compose (docker compose down)', new RegExp(`${COMPOSE} down\\b`)],
];

// Trechos de código da skill: cada linha de um bloco cercado e cada trecho entre crases.
function codeSegments(content: string): string[] {
  const segments: string[] = [];
  const withoutFences = content.replace(
    /```[^\n]*\n([\s\S]*?)```/g,
    (_whole, block: string) => {
      for (const line of block.split('\n'))
        if (line.trim() !== '') segments.push(line.trim());
      return '';
    },
  );
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g))
    if (match[1]) segments.push(match[1].trim());
  return segments;
}

// Os comandos que cada trecho começa: separados por pipe, `&&`, `||` e `;`, e sem as variáveis de ambiente do início.
function commandsOf(segment: string): string[] {
  return segment
    .split(/\|\||&&|\||;/)
    .map((part) =>
      part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''),
    )
    .filter((part) => part !== '');
}

// A regra `Bash(prefixo *)` do Claude Code: `*` casa qualquer texto, e o resto é literal.
function denyMatcher(rule: string): RegExp | undefined {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) return undefined;
  const source = inner
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function bashDenyRules(settingsText: string): string[] {
  const settings = JSON.parse(settingsText) as {
    permissions?: { deny?: string[] };
  };
  return (settings.permissions?.deny ?? []).filter((rule) =>
    rule.startsWith('Bash('),
  );
}

function sectionOf(content: string, title: string): string {
  const match = new RegExp(
    `^## ${title}\\s*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))`,
    'm',
  ).exec(content);
  return match?.[1] ?? '';
}

// A conferência como função, para provar também que reprova uma cópia sem um passo (controle negativo).
function appCheckViolations(content: string, denyRules: string[]): string[] {
  const violations: string[] = [];
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!frontmatter)
    violations.push('a skill não começa com um bloco de frontmatter');
  else if (!/^name:\s*app-check\s*$/m.test(frontmatter[1] ?? ''))
    violations.push('o frontmatter não tem name: app-check');
  for (const [label, pattern] of RECIPE_STEPS) {
    if (!pattern.test(content)) violations.push(`a receita não ${label}`);
  }

  const segments = codeSegments(content);
  // Todo `docker compose <subcomando>` leva o nome de projeto próprio; a menção solta do nome do comando não é um comando.
  for (const segment of segments) {
    for (const match of segment.matchAll(/docker compose(.*)/g)) {
      const rest = match[1] ?? '';
      if (rest.trim() !== '' && !rest.startsWith(` ${PROJECT_FLAG}`))
        violations.push(`docker compose sem ${PROJECT_FLAG}: ${segment}`);
    }
  }

  const matchers = denyRules.map((rule) => ({
    rule,
    matcher: denyMatcher(rule),
  }));
  for (const segment of segments) {
    for (const command of commandsOf(segment)) {
      for (const { rule, matcher } of matchers) {
        if (matcher?.test(command))
          violations.push(`o comando "${command}" casa com a negação ${rule}`);
      }
    }
  }

  const report = sectionOf(content, 'Report');
  if (!report.includes('update_pull_request'))
    violations.push(
      'a seção Report não manda a evidência para a descrição do PR (update_pull_request)',
    );
  if (report.includes('add_issue_comment'))
    violations.push(
      'a seção Report manda a evidência para um comentário (add_issue_comment)',
    );
  return violations;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'app-check-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function readSkill(): string {
  return readFileSync(path.join(root, APP_CHECK), 'utf8');
}

function denyRules(): string[] {
  return bashDenyRules(readFileSync(path.join(root, SETTINGS), 'utf8'));
}

// Escreve a cópia numa pasta temporária fora do repositório e a lê de volta, como a conferência a leria.
function copyOf(name: string, content: string): string {
  const folder = path.join(scratch, name);
  mkdirSync(folder, { recursive: true });
  const copy = path.join(folder, 'SKILL.md');
  writeFileSync(copy, content);
  return readFileSync(copy, 'utf8');
}

describe('AI-22 a skill app-check roda o sistema pelo docker compose e colhe a evidência', () => {
  it('AI-22 a skill .claude/skills/app-check/SKILL.md existe', () => {
    expect(existsSync(path.join(root, APP_CHECK))).toBe(true);
  });

  it('AI-22 o settings.json tem regras Bash de negação, e a conferência as lê (curl e wget entre elas)', () => {
    const rules = denyRules();

    expect(rules).toContain('Bash(curl *)');
    expect(rules).toContain('Bash(wget *)');
  });

  it('AI-22 o frontmatter tem name: app-check; a receita sobe o compose com o projeto próprio, faz o checkout, acompanha o status até invoiced, lê o /metrics e os logs do worker e derruba o compose; nenhum comando casa com as negações; a evidência vai para a descrição do PR', () => {
    expect(appCheckViolations(readSkill(), denyRules())).toEqual([]);
  });

  it('AI-22 todo comando docker compose da receita usa -p casecellshop-app-check', () => {
    const skill = readSkill();

    // O `dc` da receita é definido com o nome de projeto, e nenhum outro `docker compose` com subcomando o dispensa.
    expect(skill).toContain(`docker compose ${PROJECT_FLAG}`);
    const withoutProject = codeSegments(skill).filter((segment) =>
      [...segment.matchAll(/docker compose(.*)/g)].some(
        (match) =>
          (match[1] ?? '').trim() !== '' &&
          !(match[1] ?? '').startsWith(` ${PROJECT_FLAG}`),
      ),
    );
    expect(withoutProject).toEqual([]);
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia da skill sem o docker compose down', () => {
    const copy = copyOf(
      'sem-down',
      readSkill().replaceAll('dc down', 'dc stop'),
    );

    expect(appCheckViolations(copy, denyRules())).toEqual([
      'a receita não derruba o compose (docker compose down)',
    ]);
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia com outro name no frontmatter', () => {
    const copy = readSkill().replace(/^name:\s*app-check\s*$/m, 'name: verify');

    expect(appCheckViolations(copy, denyRules())).toContain(
      'o frontmatter não tem name: app-check',
    );
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia com um curl, que o settings.json nega', () => {
    const copy = copyOf(
      'com-curl',
      `${readSkill()}\n\`\`\`sh\ncurl -s http://127.0.0.1:3000/health\n\`\`\`\n`,
    );

    const violations = appCheckViolations(copy, denyRules());

    expect(violations).toContain(
      'o comando "curl -s http://127.0.0.1:3000/health" casa com a negação Bash(curl *)',
    );
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia com um docker compose sem o -p', () => {
    const copy = copyOf(
      'sem-projeto',
      readSkill().replace('`dc down -v`', '`docker compose down -v`'),
    );

    const violations = appCheckViolations(copy, denyRules());

    expect(violations).toContain(
      `docker compose sem ${PROJECT_FLAG}: docker compose down -v`,
    );
  });

  it('AI-22 a seção Report manda a evidência para a descrição do PR (update_pull_request), e add_issue_comment não aparece como destino', () => {
    const report = sectionOf(readSkill(), 'Report');

    expect(report).toContain('update_pull_request');
    expect(report).not.toContain('add_issue_comment');
  });

  it('AI-22 controle negativo: a conferência reprova uma cópia que manda a evidência para um comentário', () => {
    const copy = copyOf(
      'com-comentario',
      readSkill().replace(
        'mcp__github__update_pull_request',
        'mcp__github__add_issue_comment',
      ),
    );

    const violations = appCheckViolations(copy, denyRules());

    expect(violations).toContain(
      'a seção Report manda a evidência para um comentário (add_issue_comment)',
    );
    expect(violations).toContain(
      'a seção Report não manda a evidência para a descrição do PR (update_pull_request)',
    );
  });

  it('AI-22 o passo "Ready and merge" da skill marco cita app-check', () => {
    const step = sectionOf(
      readFileSync(path.join(root, MARCO), 'utf8').replace(
        /^## \d+\. /gm,
        '## ',
      ),
      'Ready and merge',
    );

    expect(step, 'a skill marco não tem o passo "Ready and merge"').not.toBe(
      '',
    );
    expect(step).toContain('app-check');
  });
});
