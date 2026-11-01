import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mutated,
  parseYaml,
  readRepoYaml,
  repoRoot,
} from '../helpers/ci-workflow.ts';

// AI-45 (a parte do dependabot.yml): o Dependabot abre os PRs do npm e das actions uma vez por semana, com espera de
// 7 dias desde a publicação (cooldown), um grupo por ecossistema, a versão exata no package.json e o prefixo de commit
// de cada ecossistema. O commitlint dos commits do Dependabot é coberto por commitlint.test.ts.

interface Update {
  'package-ecosystem'?: string;
  directory?: string;
  schedule?: { interval?: string };
  cooldown?: { 'default-days'?: number };
  groups?: Record<string, { patterns?: string[] }>;
  'versioning-strategy'?: string;
  'commit-message'?: { prefix?: string };
  ignore?: { 'dependency-name'?: string; 'update-types'?: string[] }[];
}

interface Dependabot {
  version?: number;
  updates?: Update[];
}

const PREFIXES: Record<string, string> = {
  npm: 'build(deps)',
  'github-actions': 'ci(deps)',
};

function updateViolations(update: Update): string[] {
  const id = update['package-ecosystem'] ?? '?';
  const violations: string[] = [];
  if (update.directory !== '/') violations.push(`${id}: directory não é /`);
  if (update.schedule?.interval !== 'weekly')
    violations.push(`${id}: schedule.interval não é weekly`);
  const days = update.cooldown?.['default-days'];
  if (typeof days !== 'number' || days < 7)
    violations.push(`${id}: cooldown.default-days ausente ou menor que 7`);
  // Um grupo que pega tudo do ecossistema: um PR só por semana.
  const groups = Object.values(update.groups ?? {});
  if (!groups.some((group) => group.patterns?.includes('*')))
    violations.push(`${id}: nenhum grupo com patterns ['*']`);
  if (update['commit-message']?.prefix !== PREFIXES[id])
    violations.push(`${id}: commit-message.prefix não é ${PREFIXES[id]}`);
  if (id === 'npm' && update['versioning-strategy'] !== 'increase')
    violations.push('npm: versioning-strategy não é increase');
  // O @types/node segue o piso do engines (Node 24.12): uma versão maior deixaria o tsc aceitar API que não existe nele.
  const holdsTypesNode = (update.ignore ?? []).some(
    (rule) =>
      rule['dependency-name'] === '@types/node' &&
      rule['update-types']?.includes('version-update:semver-major'),
  );
  if (id === 'npm' && !holdsTypesNode)
    violations.push('npm: sem o ignore das versões maiores do @types/node');
  return violations;
}

function dependabotViolations(config: Dependabot | undefined): string[] {
  if (config === undefined) return ['o arquivo não existe'];
  const updates = config.updates ?? [];
  const ecosystems = updates.map((update) => update['package-ecosystem']);
  const violations: string[] = [];
  if (config.version !== 2) violations.push('version não é 2');
  if (
    JSON.stringify(
      ecosystems.sort((a, b) => String(a).localeCompare(String(b))),
    ) !== '["github-actions","npm"]'
  )
    violations.push(`ecossistemas: ${ecosystems.join(', ')}`);
  return [...violations, ...updates.flatMap(updateViolations)];
}

// --- linha de base em memória -----------------------------------------------------------------------------------

const GOOD = `
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      npm:
        patterns: ['*']
    versioning-strategy: increase
    ignore:
      - dependency-name: '@types/node'
        update-types: ['version-update:semver-major']
    commit-message:
      prefix: build(deps)
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
    groups:
      actions:
        patterns: ['*']
    commit-message:
      prefix: ci(deps)
`;

function edited(from: string, to: string): Dependabot {
  return parseYaml<Dependabot>(mutated(GOOD, from, to));
}

describe('AI-45 a conferência do dependabot.yml enxerga o que procura (controle negativo)', () => {
  it('AI-45 o dependabot.yml correto passa (controle positivo)', () => {
    expect(dependabotViolations(parseYaml<Dependabot>(GOOD))).toEqual([]);
  });

  it('AI-45 sem arquivo, reprova', () => {
    expect(dependabotViolations(undefined)).toEqual(['o arquivo não existe']);
  });

  it.each([
    [
      'o npm sem cooldown',
      '    cooldown:\n      default-days: 7\n    groups:\n      npm:',
    ],
    [
      'as actions sem cooldown',
      '    cooldown:\n      default-days: 7\n    groups:\n      actions:',
    ],
  ])('AI-45 %s reprova', (_label, removed) => {
    const withoutCooldown = removed.replace(
      '    cooldown:\n      default-days: 7\n',
      '',
    );

    expect(dependabotViolations(edited(removed, withoutCooldown))).toHaveLength(
      1,
    );
  });

  it.each([
    ['cooldown de 3 dias', 'default-days: 7', 'default-days: 3'],
    ['cooldown sem default-days', 'default-days: 7', 'semver-major-days: 7'],
    ['atualização diária', 'interval: weekly', 'interval: daily'],
    [
      'o diretório fora da raiz',
      'directory: /\n    schedule',
      'directory: /app\n    schedule',
    ],
    [
      'sem versioning-strategy no npm',
      '    versioning-strategy: increase\n',
      '',
    ],
    [
      'versioning-strategy auto no npm',
      'versioning-strategy: increase',
      'versioning-strategy: auto',
    ],
    ['prefixo errado no npm', 'prefix: build(deps)', 'prefix: chore(deps)'],
    ['prefixo errado nas actions', 'prefix: ci(deps)', 'prefix: build(deps)'],
    ['sem grupo que pega tudo', "patterns: ['*']", "patterns: ['@types/*']"],
    ['sem o ecossistema das actions', 'github-actions', 'pip'],
    ['sem a version 2', 'version: 2', 'version: 1'],
    [
      'sem o ignore do @types/node',
      "    ignore:\n      - dependency-name: '@types/node'\n        update-types: ['version-update:semver-major']\n",
      '',
    ],
    [
      'o ignore de outro pacote que o @types/node',
      "dependency-name: '@types/node'",
      "dependency-name: 'typescript'",
    ],
    [
      'o ignore do @types/node só das versões menores',
      "['version-update:semver-major']",
      "['version-update:semver-minor']",
    ],
  ])('AI-45 %s reprova', (_label, from, to) => {
    expect(dependabotViolations(edited(from, to))).not.toEqual([]);
  });
});

describe('AI-45 o .github/dependabot.yml atualiza o npm e as actions toda semana, com cooldown de 7 dias', () => {
  it('AI-45 o arquivo .github/dependabot.yml existe', () => {
    expect(existsSync(join(repoRoot, '.github', 'dependabot.yml'))).toBe(true);
  });

  it('AI-45 os dois ecossistemas são semanais, com cooldown de 7 dias, um grupo que pega tudo e o prefixo certo; o npm mantém a versão exata (increase)', () => {
    expect(
      dependabotViolations(
        readRepoYaml<Dependabot>('.github', 'dependabot.yml'),
      ),
    ).toEqual([]);
  });
});
