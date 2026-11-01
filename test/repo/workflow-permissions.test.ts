import { describe, expect, it } from 'vitest';
import {
  jobOf,
  parseWorkflow,
  readWorkflowFile,
  topPermissionViolations,
  workflowFileNames,
  writeGrants,
} from '../helpers/ci-workflow.ts';

// AI-05 (permissões): todo workflow declara no topo só permissão de leitura, e a de escrita fica no job que precisa
// dela (o analyze do codeql.yml, AI-44, e o report do nightly.yml, AI-46). O merge (AI-10) não escreve com o
// GITHUB_TOKEN: os dois workflows dele ficam com permissions: {} e o merge-by-app.yml usa o token do App.

describe('AI-05 a conferência das permissões do topo enxerga o que procura (controle negativo)', () => {
  const top = (permissions: string): string[] =>
    topPermissionViolations(parseWorkflow(`${permissions}\njobs: {}\n`));

  it.each([
    ['vazio {}', 'permissions: {}'],
    ['read-all', 'permissions: read-all'],
    ['só read', 'permissions:\n  contents: read\n  pull-requests: read'],
    ['none', 'permissions:\n  contents: none'],
  ])('AI-05 o topo %s passa (controle positivo)', (_label, permissions) => {
    expect(top(permissions)).toEqual([]);
  });

  it.each([
    ['contents: write', 'permissions:\n  contents: write'],
    [
      'uma escrita entre leituras',
      'permissions:\n  contents: read\n  pull-requests: write',
    ],
    ['write-all', 'permissions: write-all'],
    ['security-events: write', 'permissions:\n  security-events: write'],
    ['sem permissions', 'name: sem permissões'],
  ])('AI-05 o topo com %s reprova', (_label, permissions) => {
    expect(top(permissions)).not.toEqual([]);
  });

  it('AI-05 a escrita só no job passa no topo, e a leitura dela enxerga o job', () => {
    const workflow = parseWorkflow(
      'permissions: {}\njobs:\n  j:\n    permissions:\n      contents: write\n',
    );

    expect(topPermissionViolations(workflow)).toEqual([]);
    expect(writeGrants(jobOf(workflow, 'j')?.permissions)).toEqual([
      'contents: write',
    ]);
  });
});

describe('AI-05 todo workflow do repositório declara no topo só permissão de leitura', () => {
  it('AI-05 a pasta tem o ci.yml, o codeql.yml, o merge-on-approval.yml, o merge-by-app.yml e o nightly.yml', () => {
    expect(workflowFileNames()).toEqual(
      expect.arrayContaining([
        'ci.yml',
        'codeql.yml',
        'merge-by-app.yml',
        'merge-on-approval.yml',
        'nightly.yml',
      ]),
    );
  });

  it.each(workflowFileNames())(
    'AI-05 o %s não tem permissão de escrita no topo',
    (name) => {
      expect(topPermissionViolations(readWorkflowFile(name) ?? {})).toEqual([]);
    },
  );

  it.each(['merge-on-approval.yml', 'merge-by-app.yml'])(
    'AI-05 todo job do %s fica com permissions: {}, porque o merge usa o token do App (AI-10)',
    (name) => {
      const jobs = Object.values(readWorkflowFile(name)?.jobs ?? {});

      expect(jobs).not.toEqual([]);
      expect(jobs.map((job) => job.permissions)).toEqual(jobs.map(() => ({})));
    },
  );

  it('AI-05 só os jobs analyze e report escrevem; os workflows do merge e o ci.yml não escrevem em nenhum job', () => {
    const writers = workflowFileNames().flatMap((name) =>
      Object.entries(readWorkflowFile(name)?.jobs ?? {})
        .filter(([, job]) => writeGrants(job.permissions).length > 0)
        .map(([id]) => `${name}:${id}`),
    );

    expect(writers).toEqual(['codeql.yml:analyze', 'nightly.yml:report']);
  });
});
