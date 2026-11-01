import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EPHEMERAL_PORT_ENV } from '../helpers/compose.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// FND-13 (Checagem): as esperas e as portas dos testes de integração são conferidas pelas regras de lint do plugin
// test-waits (scripts/lint-rules/test-waits.ts), que leem a árvore de sintaxe. Os casos de cada regra, um a um,
// estão em scripts/lint-rules/test-waits.test.ts. Aqui fica o que não é forma de código: a configuração do lint
// (lida como JSON) carrega o plugin e liga as três regras como `error` só nas pastas dos testes de integração e dos
// ajudantes, e os valores que o compose recebe.

const PLUGIN_PATH = './scripts/lint-rules/test-waits.ts';
const RULES = [
  'test-waits/no-fixed-step',
  'test-waits/wait-guard',
  'test-waits/no-port-before-up',
] as const;
const FOLDERS = ['test/integration/**/*.ts', 'test/helpers/**/*.ts'] as const;

interface Override {
  files?: string[];
  rules?: Record<string, unknown>;
}
interface OxlintConfig {
  jsPlugins?: string[];
  overrides?: Override[];
}

function severityOf(setting: unknown): unknown {
  return Array.isArray(setting) ? (setting as unknown[])[0] : setting;
}

// Uma frase por defeito da configuração; vazio quando o plugin é carregado e as três regras são `error` num override
// que cobre as duas pastas, e nenhum outro override as rebaixa.
function waitsConfigViolations(config: OxlintConfig): string[] {
  const found: string[] = [];
  if (!(config.jsPlugins ?? []).includes(PLUGIN_PATH))
    found.push(`jsPlugins não carrega ${PLUGIN_PATH}`);
  const overrides = config.overrides ?? [];
  const covering = overrides.filter((override) =>
    FOLDERS.every((folder) => override.files?.includes(folder)),
  );
  if (covering.length === 0)
    found.push(`nenhum override cobre ${FOLDERS.join(' e ')}`);
  for (const rule of RULES) {
    if (!covering.some((o) => severityOf(o.rules?.[rule]) === 'error'))
      found.push(`${rule} não está como error no override das duas pastas`);
    for (const override of overrides) {
      const setting = override.rules?.[rule];
      if (setting !== undefined && severityOf(setting) !== 'error')
        found.push(
          `${rule} é rebaixada em um override (${(override.files ?? []).join(', ')})`,
        );
    }
  }
  return found;
}

const config = JSON.parse(
  readFileSync(path.join(repoRoot, '.oxlintrc.json'), 'utf8'),
) as OxlintConfig;

function withoutRule(source: OxlintConfig, rule: string): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? [])
    if (override.rules) delete override.rules[rule];
  return copy;
}

function withRuleAs(
  source: OxlintConfig,
  rule: string,
  severity: string,
): OxlintConfig {
  const copy = structuredClone(source);
  for (const override of copy.overrides ?? [])
    if (override.rules && rule in override.rules)
      override.rules[rule] = severity;
  return copy;
}

describe('FND-13 as regras de lint das esperas e das portas valem para os testes de integração e os ajudantes', () => {
  it('FND-13 o .oxlintrc.json carrega o plugin test-waits e liga as três regras como error em test/integration e test/helpers', () => {
    expect(waitsConfigViolations(config)).toEqual([]);
  });

  it.each(RULES)(
    'FND-13 controle negativo: sem a regra %s no override, a conferência reprova',
    (rule) => {
      expect(waitsConfigViolations(withoutRule(config, rule))).toEqual([
        `${rule} não está como error no override das duas pastas`,
      ]);
    },
  );

  it.each(RULES)(
    'FND-13 controle negativo: com a regra %s como warn, a conferência reprova',
    (rule) => {
      const violations = waitsConfigViolations(
        withRuleAs(config, rule, 'warn'),
      );

      expect(violations).toContain(
        `${rule} não está como error no override das duas pastas`,
      );
    },
  );

  it('FND-13 controle negativo: sem o plugin em jsPlugins, a conferência reprova', () => {
    const copy = structuredClone(config);
    copy.jsPlugins = (copy.jsPlugins ?? []).filter(
      (plugin) => plugin !== PLUGIN_PATH,
    );

    expect(waitsConfigViolations(copy)).toEqual([
      `jsPlugins não carrega ${PLUGIN_PATH}`,
    ]);
  });

  it('FND-13 controle negativo: um override que cobre só uma das pastas reprova', () => {
    const copy = structuredClone(config);
    for (const override of copy.overrides ?? []) {
      const { rules } = override;
      if (rules && RULES.every((rule) => rule in rules))
        override.files = ['test/integration/**/*.ts'];
    }

    expect(waitsConfigViolations(copy)).toContain(
      `nenhum override cobre ${FOLDERS.join(' e ')}`,
    );
  });
});

describe('FND-13 a porta do host dos testes de compose', () => {
  it('FND-13 o compose recebe a porta 0 para a API e para a interface do Jaeger, e o Docker escolhe a porta do host', () => {
    expect(EPHEMERAL_PORT_ENV).toEqual({
      API_PORT: '0',
      JAEGER_UI_PORT: '0',
    });
  });
});
