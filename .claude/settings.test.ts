import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command?: string }[];
}

interface Settings {
  permissions: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    disableBypassPermissionsMode?: string;
  };
  hooks?: Record<string, HookEntry[]>;
}

const settings = JSON.parse(readFileSync(join(import.meta.dirname, 'settings.json'), 'utf8')) as Settings;

const GITHUB_TOOLS = [
  'get_me',
  'pull_request_read',
  'list_pull_requests',
  'create_pull_request',
  'update_pull_request',
  'add_issue_comment',
  'actions_list',
  'actions_get',
  'get_job_logs',
].map((name) => `mcp__github__${name}`);

function commandsOf(entries: HookEntry[]): string[] {
  return entries.flatMap((entry) => entry.hooks.map((hook) => hook.command ?? ''));
}

// O matcher do Claude Code é uma regex ancorada sobre o nome da ferramenta.
function matches(matcher: string | undefined, toolName: string): boolean {
  return new RegExp(`^(?:${matcher ?? ''})$`).test(toolName);
}

describe('AI-06 permissões do .claude/settings.json', () => {
  it.each(['Bash(git commit *)', 'Bash(git push *)', ...GITHUB_TOOLS])('AI-06 libera %s', (rule) => {
    expect(settings.permissions.allow ?? []).toContain(rule);
  });

  it('AI-06 libera exatamente as nove ferramentas do GitHub, sem nenhuma outra mcp__github__', () => {
    const allowed = (settings.permissions.allow ?? []).filter((rule) => rule.startsWith('mcp__github__'));

    expect([...allowed].sort()).toEqual([...GITHUB_TOOLS].sort());
  });

  it.each([
    'Bash(gh)',
    'Bash(gh *)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Bash(security *)',
    'Bash(git push --force*)',
    'Bash(git push -f*)',
    'Bash(git push --delete*)',
    'Bash(git commit *--no-verify*)',
    'Bash(git commit * -n*)',
    'Bash(git push *--force*)',
    'Bash(git push * +*)',
    'Bash(git push * :*)',
    'Bash(git push *--mirror*)',
    'mcp__github__merge_pull_request',
    'mcp__github__pull_request_review_write',
    'mcp__github__update_pull_request_branch',
    'mcp__github__create_or_update_file',
    'mcp__github__push_files',
    'mcp__github__delete_file',
    'Read(**/.env)',
    'Read(**/.env.*)',
  ])('AI-06 nega %s', (rule) => {
    expect(settings.permissions.deny ?? []).toContain(rule);
  });

  // Controle negativo: as negações novas não podem derrubar o commit e o push comuns.
  it('AI-06 o commit e o push comuns seguem liberados e não negados por inteiro', () => {
    const deny = settings.permissions.deny ?? [];

    expect(deny).not.toContain('Bash(git commit *)');
    expect(deny).not.toContain('Bash(git push *)');
    expect(settings.permissions.allow ?? []).toContain('Bash(git commit *)');
    expect(settings.permissions.allow ?? []).toContain('Bash(git push *)');
  });

  it('AI-06 nenhuma ferramenta negada por nome também está liberada', () => {
    const allow = settings.permissions.allow ?? [];
    const deny = settings.permissions.deny ?? [];

    expect(deny.filter((rule) => allow.includes(rule))).toEqual([]);
  });

  it('AI-06 não tem regra ask para git push, gh pr nem git commit', () => {
    const ask = settings.permissions.ask ?? [];

    expect(ask.filter((rule) => /git push|gh pr|git commit/.test(rule))).toEqual([]);
  });

  it('AI-06 desliga o modo bypassPermissions', () => {
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
  });
});

describe('AI-06 hooks do .claude/settings.json', () => {
  it('AI-06 o hook SubagentStop do implementer, do test-writer e do reviewer chama o subagent-stop.mjs', () => {
    const entries = settings.hooks?.SubagentStop ?? [];

    const entry = entries.find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('.claude/hooks/subagent-stop.mjs')),
    );

    expect(entry).toBeDefined();
    for (const agent of ['implementer', 'test-writer', 'reviewer']) expect(matches(entry?.matcher, agent)).toBe(true);
    expect(matches(entry?.matcher, 'general-purpose')).toBe(false);
    expect(matches(entry?.matcher, 'Explore')).toBe(false);
  });

  it('AI-06 o hook SubagentStart do implementer, do test-writer e do reviewer chama o subagent-start.mjs', () => {
    const entries = settings.hooks?.SubagentStart ?? [];

    const entry = entries.find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('.claude/hooks/subagent-start.mjs')),
    );

    expect(entry).toBeDefined();
    expect(commandsOf(entry ? [entry] : [])).toContain(
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/subagent-start.mjs"',
    );
    for (const agent of ['implementer', 'test-writer', 'reviewer']) expect(matches(entry?.matcher, agent)).toBe(true);
    expect(matches(entry?.matcher, 'general-purpose')).toBe(false);
    expect(matches(entry?.matcher, 'Explore')).toBe(false);
  });

  // Controle: o retrato e a parada cobrem os mesmos três papéis, senão um papel teria parada sem retrato.
  it('AI-06 o SubagentStart e o SubagentStop cobrem exatamente os mesmos agentes', () => {
    const startEntry = (settings.hooks?.SubagentStart ?? []).find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('subagent-start.mjs')),
    );
    const stopEntry = (settings.hooks?.SubagentStop ?? []).find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('subagent-stop.mjs')),
    );

    expect(startEntry?.matcher).toBeDefined();
    expect(startEntry?.matcher).toBe(stopEntry?.matcher);
  });

  it('AI-06 um hook SessionStart chama o scripts/check-env.ts', () => {
    const commands = commandsOf(settings.hooks?.SessionStart ?? []);

    expect(commands.some((command) => command.includes('scripts/check-env.ts'))).toBe(true);
  });

  it('AI-06 o SessionStart só roda no início e na retomada da sessão (matcher startup|resume)', () => {
    const entry = (settings.hooks?.SessionStart ?? []).find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('scripts/check-env.ts')),
    );

    expect(entry?.matcher).toBe('startup|resume');
    expect(matches(entry?.matcher, 'startup')).toBe(true);
    expect(matches(entry?.matcher, 'resume')).toBe(true);
    expect(matches(entry?.matcher, 'clear')).toBe(false);
    expect(matches(entry?.matcher, 'compact')).toBe(false);
  });

  it('AI-06 um hook PreToolUse com matcher Bash chama o bash-guard.mjs', () => {
    const entry = (settings.hooks?.PreToolUse ?? []).find((candidate) => candidate.matcher === 'Bash');

    expect(entry).toBeDefined();
    expect(commandsOf(entry ? [entry] : []).some((command) => command.includes('.claude/hooks/bash-guard.mjs'))).toBe(
      true,
    );
    expect(matches(entry?.matcher, 'Bash')).toBe(true);
    expect(matches(entry?.matcher, 'Edit')).toBe(false);
  });

  it('AI-06 um hook PreToolUse cobre create_pull_request e add_issue_comment e chama o github-guard.mjs', () => {
    const entries = settings.hooks?.PreToolUse ?? [];

    const entry = entries.find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('.claude/hooks/github-guard.mjs')),
    );

    expect(entry).toBeDefined();
    expect(matches(entry?.matcher, 'mcp__github__create_pull_request')).toBe(true);
    expect(matches(entry?.matcher, 'mcp__github__add_issue_comment')).toBe(true);
  });

  it('AI-06 o matcher do github-guard não cobre uma ferramenta sem relação', () => {
    const entries = settings.hooks?.PreToolUse ?? [];
    const entry = entries.find((candidate) =>
      commandsOf([candidate]).some((command) => command.includes('.claude/hooks/github-guard.mjs')),
    );

    expect(entry).toBeDefined();
    expect(matches(entry?.matcher, 'Read')).toBe(false);
  });

  it('AI-06 o PreToolUse de Edit|Write|NotebookEdit continua chamando o path-guard.mjs', () => {
    const entries = settings.hooks?.PreToolUse ?? [];

    const entry = entries.find((candidate) => candidate.matcher === 'Edit|Write|NotebookEdit');

    expect(entry).toBeDefined();
    expect(commandsOf(entry ? [entry] : []).some((command) => command.includes('.claude/hooks/path-guard.mjs'))).toBe(
      true,
    );
  });
});
