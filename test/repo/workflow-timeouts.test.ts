import { describe, expect, it } from 'vitest';
import {
  parseWorkflow,
  readWorkflowFile,
  workflowFileNames,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';

// AI-05 (tempo): todo job declara `timeout-minutes`, para um passo travado não segurar o runner pelas 6 horas do
// padrão. O valor tem de ser um número positivo: uma expressão ou um texto não vale, porque o actionlint e o GitHub
// só o aceitam como número na leitura estática.

function jobsWithoutTimeout(workflow: CiWorkflow): string[] {
  return Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => {
      const minutes = job['timeout-minutes'];
      return typeof minutes !== 'number' || !(minutes > 0);
    })
    .map(([id]) => id);
}

describe('AI-05 a conferência do timeout-minutes enxerga o que procura (controle negativo)', () => {
  const withJob = (job: string): CiWorkflow =>
    parseWorkflow(`jobs:\n  a:\n    runs-on: ubuntu-latest\n${job}`);

  it('AI-05 o job com timeout-minutes numérico passa (controle positivo)', () => {
    expect(jobsWithoutTimeout(withJob('    timeout-minutes: 15\n'))).toEqual(
      [],
    );
  });

  it.each([
    ['sem timeout-minutes', ''],
    ['com timeout-minutes zero', '    timeout-minutes: 0\n'],
    ['com timeout-minutes negativo', '    timeout-minutes: -5\n'],
    ['com timeout-minutes em texto', "    timeout-minutes: 'quinze'\n"],
    [
      'com timeout-minutes por expressão',
      "    timeout-minutes: ${{ fromJSON('15') }}\n",
    ],
  ])('AI-05 o job %s reprova', (_label, job) => {
    expect(jobsWithoutTimeout(withJob(job))).toEqual(['a']);
  });

  it('AI-05 só o job sem timeout-minutes é apontado, entre dois jobs', () => {
    const workflow = parseWorkflow(
      'jobs:\n  a:\n    timeout-minutes: 5\n  b:\n    runs-on: ubuntu-latest\n',
    );

    expect(jobsWithoutTimeout(workflow)).toEqual(['b']);
  });
});

describe('AI-05 todo job de todo workflow do repositório declara timeout-minutes', () => {
  it('AI-05 a pasta de workflows tem arquivos para conferir', () => {
    expect(workflowFileNames().length).toBeGreaterThan(0);
  });

  it.each(workflowFileNames())(
    'AI-05 todo job do %s declara timeout-minutes numérico',
    (name) => {
      const workflow = readWorkflowFile(name) ?? {};

      expect(Object.keys(workflow.jobs ?? {})).not.toEqual([]);
      expect(jobsWithoutTimeout(workflow)).toEqual([]);
    },
  );
});
