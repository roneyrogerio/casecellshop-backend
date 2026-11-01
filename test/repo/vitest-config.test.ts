import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';
import { WAIT_GUARD_MS } from '../helpers/async.ts';
import { PROPERTY_BASE_TIMEOUT_MS } from '../helpers/property-setup.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// O vitest.config.ts é lido como objeto (o que o vitest recebe), e não como texto: o teste não depende de a
// configuração estar escrita de uma forma ou de outra.
interface ProjectConfig {
  test?: {
    name?: string;
    testTimeout?: number;
    maxWorkers?: number | string;
    sequence?: { groupOrder?: number };
    setupFiles?: string | string[];
  };
}

function projectsOf(source: unknown): ProjectConfig[] {
  const { test } = source as { test?: { projects?: ProjectConfig[] } };
  return test?.projects ?? [];
}

function projectNamed(projects: ProjectConfig[], name: string) {
  return projects.find((project) => project.test?.name === name)?.test;
}

// O `unit` precisa rodar antes do `integration` (o vitest roda primeiro o grupo de menor `sequence.groupOrder`,
// e projetos do mesmo grupo rodam juntos). Devolve o que falta, uma frase por problema.
function groupOrderViolations(source: unknown): string[] {
  const projects = projectsOf(source);
  const unit = projectNamed(projects, 'unit')?.sequence?.groupOrder;
  const integration = projectNamed(projects, 'integration')?.sequence
    ?.groupOrder;
  if (unit === undefined || integration === undefined)
    return [
      'os projetos unit e integration precisam declarar sequence.groupOrder',
    ];
  if (unit >= integration)
    return [
      `o unit (groupOrder ${unit}) não roda antes do integration (groupOrder ${integration})`,
    ];
  return [];
}

// Uma cópia da configuração com os dois projetos no mesmo grupo.
function withSameGroup(source: unknown): unknown {
  const projects = projectsOf(source).map((project) => ({
    ...project,
    test: { ...project.test, sequence: { groupOrder: 0 } },
  }));
  return { ...(source as object), test: { projects } };
}

describe('AI-52 o npm test roda o projeto unit antes do integration', () => {
  it('AI-52 o projeto unit tem sequence.groupOrder menor que o do integration, na mesma execução', () => {
    expect(groupOrderViolations(config)).toEqual([]);
  });

  it('AI-52 controle negativo: uma configuração com os dois projetos no mesmo grupo reprova', () => {
    const violations = groupOrderViolations(withSameGroup(config));

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('não roda antes');
  });

  it('AI-52 controle negativo: o integration antes do unit também reprova', () => {
    const swapped = {
      test: {
        projects: projectsOf(config).map((project) => ({
          ...project,
          test: {
            ...project.test,
            sequence: {
              groupOrder: project.test?.name === 'unit' ? 2 : 1,
            },
          },
        })),
      },
    };

    expect(groupOrderViolations(swapped)).toHaveLength(1);
  });

  it('AI-52 os dois projetos seguem na mesma configuração, para a mesma execução e o mesmo relatório JSON', () => {
    const names = projectsOf(config).map((project) => project.test?.name);

    expect(names).toEqual(expect.arrayContaining(['unit', 'integration']));
  });
});

// Quantos arquivos de integração rodam ao mesmo tempo (FND-13, "Paralelismo"): "no máximo 4", porque com mais de 4
// contêineres de banco o Docker de 4 CPUs derrubou um banco no meio da suíte. Um número inteiro de 1 a 4 vale (o
// FND-14 revê o limite pela medição, e baixá-lo não viola o critério); texto como `'100%'` não é número e não
// prova o limite. Devolve o que falta, uma frase por problema.
const INTEGRATION_MAX_WORKERS = 4;

function maxWorkersViolations(source: unknown): string[] {
  const integration = projectNamed(projectsOf(source), 'integration');
  const declared = integration?.maxWorkers;
  if (declared === undefined)
    return ['o projeto integration precisa declarar maxWorkers'];
  if (typeof declared !== 'number' || !Number.isInteger(declared))
    return [
      `o maxWorkers do integration (${JSON.stringify(declared)}) precisa ser um número inteiro`,
    ];
  if (declared < 1 || declared > INTEGRATION_MAX_WORKERS)
    return [
      `o projeto integration roda ${declared} arquivos ao mesmo tempo, e o limite é de 1 a ${INTEGRATION_MAX_WORKERS}`,
    ];
  return [];
}

// Uma cópia da configuração em que o projeto integration muda o maxWorkers (ou perde a chave, com `undefined`).
function withIntegrationMaxWorkers(
  source: unknown,
  maxWorkers: number | string | undefined,
): unknown {
  const projects = projectsOf(source).map((project) =>
    project.test?.name === 'integration'
      ? { ...project, test: { ...project.test, maxWorkers } }
      : project,
  );
  return { ...(source as object), test: { projects } };
}

function withoutIntegrationMaxWorkers(source: unknown): unknown {
  const projects = projectsOf(source).map((project) => {
    if (project.test?.name !== 'integration') return project;
    const { maxWorkers: _removed, ...rest } = project.test;
    return { ...project, test: rest };
  });
  return { ...(source as object), test: { projects } };
}

// FND-15: o projeto unit liga a semente e o número de casos do fast-check pelo `setupFiles`. Sem ele, o fast-check
// usa a hora como semente e o PR deixa de ser repetível, sem nenhum teste reprovar. O módulo property-setup.ts já é
// testado direto; aqui se confere só a ligação. Devolve o que falta, uma frase por problema.
const PROPERTY_SETUP = './test/helpers/property-setup.ts';

function propertySetupViolations(source: unknown): string[] {
  const declared = projectNamed(projectsOf(source), 'unit')?.setupFiles;
  const files = typeof declared === 'string' ? [declared] : (declared ?? []);
  return files.includes(PROPERTY_SETUP)
    ? []
    : [`o projeto unit precisa ter ${PROPERTY_SETUP} em setupFiles`];
}

// Uma cópia da configuração em que o projeto unit troca os setupFiles (ou os perde, com `undefined`).
function withUnitSetupFiles(
  source: unknown,
  setupFiles: string | string[] | undefined,
): unknown {
  const projects = projectsOf(source).map((project) =>
    project.test?.name === 'unit'
      ? { ...project, test: { ...project.test, setupFiles } }
      : project,
  );
  return { ...(source as object), test: { projects } };
}

describe('FND-15 o projeto unit liga a configuração das propriedades do fast-check', () => {
  it('FND-15 o projeto unit tem ./test/helpers/property-setup.ts em setupFiles, e o arquivo existe', () => {
    expect(propertySetupViolations(config)).toEqual([]);
    expect(existsSync(join(repoRoot, PROPERTY_SETUP))).toBe(true);
  });

  it('FND-15 controle negativo: uma configuração sem o property-setup em setupFiles reprova', () => {
    for (const other of [undefined, [], ['./outro.ts'], './outro.ts']) {
      const violations = propertySetupViolations(
        withUnitSetupFiles(config, other),
      );

      expect(violations, JSON.stringify(other)).toHaveLength(1);
      expect(violations[0]).toContain('setupFiles');
    }
  });

  it('FND-15 controle negativo: o property-setup entre outros arquivos e como texto único passa', () => {
    for (const allowed of [
      [PROPERTY_SETUP],
      ['./antes.ts', PROPERTY_SETUP],
      PROPERTY_SETUP,
    ]) {
      expect(
        propertySetupViolations(withUnitSetupFiles(config, allowed)),
        JSON.stringify(allowed),
      ).toEqual([]);
    }
  });

  it('FND-15 o prazo dos testes de propriedade cresce com o número de casos sem subir o testTimeout do projeto unit', () => {
    const unit = projectNamed(projectsOf(config), 'unit');

    expect(unit?.testTimeout ?? PROPERTY_BASE_TIMEOUT_MS).toBeLessThanOrEqual(
      PROPERTY_BASE_TIMEOUT_MS,
    );
  });

  it('FND-15 o property-setup só vale no unit: o projeto integration não o liga', () => {
    const integration = projectNamed(projectsOf(config), 'integration');

    expect(integration?.setupFiles ?? []).not.toContain(PROPERTY_SETUP);
  });
});

describe('FND-13 o prazo real das esperas é o testTimeout do projeto de integração', () => {
  it('FND-13 WAIT_GUARD_MS dos testes é igual ao testTimeout do projeto integration', () => {
    const integration = projectNamed(projectsOf(config), 'integration');

    expect(integration?.testTimeout).toBe(WAIT_GUARD_MS);
  });
});

describe('FND-13 o projeto de integração roda no máximo 4 arquivos ao mesmo tempo', () => {
  it('FND-13 o projeto integration declara maxWorkers como um número inteiro de 1 a 4', () => {
    const declared = projectNamed(
      projectsOf(config),
      'integration',
    )?.maxWorkers;

    expect(maxWorkersViolations(config)).toEqual([]);
    expect(typeof declared).toBe('number');
    expect(Number.isInteger(declared)).toBe(true);
    expect(declared).toBeGreaterThanOrEqual(1);
    expect(declared).toBeLessThanOrEqual(INTEGRATION_MAX_WORKERS);
  });

  it('FND-13 controle negativo: de 1 a 4 passa, e o limite exato de 4 também', () => {
    for (const allowed of [1, 2, 3, INTEGRATION_MAX_WORKERS]) {
      expect(
        maxWorkersViolations(withIntegrationMaxWorkers(config, allowed)),
        `maxWorkers ${allowed}`,
      ).toEqual([]);
    }
  });

  it('FND-13 controle negativo: uma configuração sem o maxWorkers do integration reprova', () => {
    const violations = maxWorkersViolations(
      withoutIntegrationMaxWorkers(config),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('precisa declarar maxWorkers');
  });

  it('FND-13 controle negativo: um maxWorkers acima de 4 ou abaixo de 1 no integration reprova', () => {
    for (const other of [0, 5, 8]) {
      const violations = maxWorkersViolations(
        withIntegrationMaxWorkers(config, other),
      );

      expect(violations, `maxWorkers ${other}`).toHaveLength(1);
      expect(violations[0]).toContain('o limite é de 1 a 4');
    }
  });

  it('FND-13 controle negativo: um maxWorkers que não é número inteiro, como o texto "100%" ou 2.5, reprova', () => {
    for (const other of ['100%', '4', 2.5]) {
      const violations = maxWorkersViolations(
        withIntegrationMaxWorkers(config, other),
      );

      expect(violations, `maxWorkers ${JSON.stringify(other)}`).toHaveLength(1);
      expect(violations[0]).toContain('precisa ser um número inteiro');
    }
  });
});
