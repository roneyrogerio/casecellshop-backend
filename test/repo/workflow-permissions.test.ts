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
// dela (o analyze do codeql.yml, AI-44, e o auto-merge do merge-on-approval.yml, AI-10).

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
  it('AI-05 a pasta tem o ci.yml, o codeql.yml e o merge-on-approval.yml', () => {
    expect(workflowFileNames()).toEqual(
      expect.arrayContaining(['ci.yml', 'codeql.yml', 'merge-on-approval.yml']),
    );
  });

  it.each(workflowFileNames())(
    'AI-05 o %s não tem permissão de escrita no topo',
    (name) => {
      expect(topPermissionViolations(readWorkflowFile(name) ?? {})).toEqual([]);
    },
  );

  it('AI-05 o job auto-merge do merge-on-approval.yml tem as permissões contents: write e pull-requests: write', () => {
    const job = jobOf(
      readWorkflowFile('merge-on-approval.yml') ?? {},
      'auto-merge',
    );

    expect(job?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
  });

  it('AI-05 só os jobs auto-merge e analyze escrevem; o ci.yml não escreve em nenhum job', () => {
    const writers = workflowFileNames().flatMap((name) =>
      Object.entries(readWorkflowFile(name)?.jobs ?? {})
        .filter(([, job]) => writeGrants(job.permissions).length > 0)
        .map(([id]) => `${name}:${id}`),
    );

    expect(writers).toEqual(
      expect.arrayContaining([
        'codeql.yml:analyze',
        'merge-on-approval.yml:auto-merge',
      ]),
    );
    expect(writers.filter((id) => id.startsWith('ci.yml:'))).toEqual([]);
  });
});
