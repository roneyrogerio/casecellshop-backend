import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Settings {
  permissions: {
    allow?: string[];
    ask?: string[];
    deny?: string[];
    disableBypassPermissionsMode?: string;
  };
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command?: string }[] }[]>;
}

const settings = JSON.parse(readFileSync(join(import.meta.dirname, 'settings.json'), 'utf8')) as Settings;

describe('AI-06 permissões do .claude/settings.json', () => {
  it.each(['Bash(git commit *)', 'Bash(npm run bot *)'])('AI-06 libera %s', (rule) => {
    expect(settings.permissions.allow ?? []).toContain(rule);
  });

  it.each([
    'Bash(git push *)',
    'Bash(gh)',
    'Bash(gh *)',
    'Bash(curl *)',
    'Bash(wget *)',
    'Bash(security *)',
    'Read(**/.env)',
    'Read(**/.env.*)',
  ])('AI-06 nega %s', (rule) => {
    expect(settings.permissions.deny ?? []).toContain(rule);
  });

  it('AI-06 não tem regra ask para git push, gh pr nem git commit', () => {
    const ask = settings.permissions.ask ?? [];

    expect(ask.filter((rule) => /git push|gh pr|git commit/.test(rule))).toEqual([]);
  });

  it('AI-06 desliga o modo bypassPermissions', () => {
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
  });

  it('AI-06 o hook SubagentStop do implementer e do test-writer chama o subagent-stop.mjs', () => {
    const entries = settings.hooks?.SubagentStop ?? [];

    const entry = entries.find((candidate) => candidate.matcher === 'implementer|test-writer');

    expect(entry).toBeDefined();
    const commands = (entry?.hooks ?? []).map((hook) => hook.command ?? '');
    expect(commands.some((command) => command.includes('.claude/hooks/subagent-stop.mjs'))).toBe(true);
  });
});
