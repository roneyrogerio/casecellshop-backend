import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';
import { WAIT_GUARD_MS } from '../helpers/async.ts';

// O vitest.config.ts é lido como objeto (o que o vitest recebe), e não como texto: o teste não depende de a
// configuração estar escrita de uma forma ou de outra.
interface ProjectConfig {
  test?: {
    name?: string;
    testTimeout?: number;
    maxWorkers?: number;
    sequence?: { groupOrder?: number };
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

// Quantos arquivos de integração rodam ao mesmo tempo (FND-13, "Paralelismo"): com mais de 4 contêineres
// de banco, o Docker de 4 CPUs derrubou um banco no meio da suíte. Devolve o que falta, uma frase por problema.
const INTEGRATION_MAX_WORKERS = 4;

function maxWorkersViolations(source: unknown): string[] {
  const integration = projectNamed(projectsOf(source), 'integration');
  if (integration?.maxWorkers === undefined)
    return ['o projeto integration precisa declarar maxWorkers'];
  if (integration.maxWorkers !== INTEGRATION_MAX_WORKERS)
    return [
      `o projeto integration roda ${integration.maxWorkers} arquivos ao mesmo tempo, e o limite é ${INTEGRATION_MAX_WORKERS}`,
    ];
  return [];
}

// Uma cópia da configuração em que o projeto integration muda o maxWorkers (ou perde a chave, com `undefined`).
function withIntegrationMaxWorkers(
  source: unknown,
  maxWorkers: number | undefined,
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

describe('FND-13 o prazo real das esperas é o testTimeout do projeto de integração', () => {
  it('FND-13 WAIT_GUARD_MS dos testes é igual ao testTimeout do projeto integration', () => {
    const integration = projectNamed(projectsOf(config), 'integration');

    expect(integration?.testTimeout).toBe(WAIT_GUARD_MS);
  });
});

describe('FND-13 o projeto de integração roda no máximo 4 arquivos ao mesmo tempo', () => {
  it('FND-13 o projeto integration declara maxWorkers igual a 4', () => {
    expect(maxWorkersViolations(config)).toEqual([]);
    expect(projectNamed(projectsOf(config), 'integration')?.maxWorkers).toBe(
      INTEGRATION_MAX_WORKERS,
    );
  });

  it('FND-13 controle negativo: uma configuração sem o maxWorkers do integration reprova', () => {
    const violations = maxWorkersViolations(
      withoutIntegrationMaxWorkers(config),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('precisa declarar maxWorkers');
  });

  it('FND-13 controle negativo: um maxWorkers diferente de 4 no integration reprova', () => {
    for (const other of [1, 3, 5, 8]) {
      const violations = maxWorkersViolations(
        withIntegrationMaxWorkers(config, other),
      );

      expect(violations, `maxWorkers ${other}`).toHaveLength(1);
      expect(violations[0]).toContain('o limite é 4');
    }
  });
});
