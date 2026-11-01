import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

// O frontmatter de um agente como mapa; um arquivo sem frontmatter válido dá um mapa vazio, e o teste falha na asserção.
function frontmatterOf(raw: string): Record<string, unknown> {
  const lines = raw.split(/\r?\n/);
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (lines[0] !== '---' || end === -1) return {};
  const data: unknown = parse(lines.slice(1, end).join('\n'));
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function agentFrontmatter(name: string): Record<string, unknown> {
  return frontmatterOf(readFileSync(path.join(root, '.claude', 'agents', `${name}.md`), 'utf8'));
}

// `git check-ignore -q` sai com 0 quando o caminho é ignorado e com 1 quando não é; o caminho não precisa existir.
function isIgnored(file: string): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: root });
  return result.status === 0;
}

describe('AI-24 o implementer e o test-writer rodam cada um numa worktree própria', () => {
  it.each(['implementer', 'test-writer'])('AI-24 o agente %s declara isolation: worktree', (name) => {
    expect(agentFrontmatter(name).isolation).toBe('worktree');
  });

  // Controle negativo: o reviewer só lê e roda na pasta principal.
  it('AI-24 o reviewer não declara isolation', () => {
    const frontmatter = agentFrontmatter('reviewer');

    expect(frontmatter.name).toBe('reviewer');
    expect('isolation' in frontmatter).toBe(false);
  });

  it('AI-24 a conferência do frontmatter distingue o agente com isolation do sem isolation', () => {
    expect(frontmatterOf('---\nname: a\nisolation: worktree\n---\ncorpo\n').isolation).toBe('worktree');
    expect(frontmatterOf('---\nname: a\n---\ncorpo\n').isolation).toBeUndefined();
    expect(frontmatterOf('sem frontmatter').isolation).toBeUndefined();
  });
});

describe('AI-24 a worktree sai do HEAD da branch da sessão principal', () => {
  it('AI-24 o settings.json declara worktree.baseRef como "head"', () => {
    const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
      worktree?: { baseRef?: unknown };
    };

    expect(settings.worktree?.baseRef).toBe('head');
  });
});

describe('AI-24 a worktree usa o node_modules da pasta principal', () => {
  it('AI-24 o settings.json liga o node_modules por link simbólico em worktree.symlinkDirectories', () => {
    const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')) as {
      worktree?: { symlinkDirectories?: unknown };
    };

    expect(settings.worktree?.symlinkDirectories).toContain('node_modules');
  });
});

describe('AI-24 a pasta .claude/worktrees/ fica fora do git', () => {
  // Sem node_modules, .env nem *.log na amostra: o .gitignore já os ignora em qualquer pasta, e isso esconderia a
  // falta da regra da pasta.
  it.each(['.claude/worktrees/agent-abc123', '.claude/worktrees/agent-abc123/src/x.ts', '.claude/worktrees/agent-abc123/AGENTS.md'])(
    'AI-24 o git ignora %s',
    (file) => {
      expect(isIgnored(file)).toBe(true);
    },
  );

  // Controles negativos: a conferência reprova o que não é da pasta, inclusive nomes que só lembram o dela.
  it.each(['.claude/settings.json', '.claude/hooks/path-guard.mjs', '.claude/worktreesx/agent/src/x.ts', 'worktrees/x.ts', 'src/app.ts'])(
    'AI-24 o git não ignora %s',
    (file) => {
      expect(isIgnored(file)).toBe(false);
    },
  );
});
