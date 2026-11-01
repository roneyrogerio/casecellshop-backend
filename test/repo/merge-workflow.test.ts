import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  uses?: string;
  run?: string;
}

interface Job {
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  on?: Record<string, { types?: string[] }>;
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

const EXPECTED_PERMISSIONS = {
  contents: 'write',
  'pull-requests': 'write',
} as const;

function loadWorkflow(): Workflow {
  const path = join(
    import.meta.dirname,
    '..',
    '..',
    '.github',
    'workflows',
    'merge-on-approval.yml',
  );
  return parse(readFileSync(path, 'utf8')) as Workflow;
}

function jobsOf(workflow: Workflow): Job[] {
  return Object.values(workflow.jobs ?? {});
}

function stepsOf(workflow: Workflow): Step[] {
  return jobsOf(workflow).flatMap((job) => job.steps ?? []);
}

// Critérios como funções, para provar também que reprovam uma variação do arquivo (controle negativo).
function triggersOnSubmittedReview(workflow: Workflow): boolean {
  const types = workflow.on?.pull_request_review?.types;
  return Array.isArray(types) && types.length === 1 && types[0] === 'submitted';
}

function jobsRequireOwnerApproval(workflow: Workflow): boolean {
  const jobs = jobsOf(workflow);
  return (
    jobs.length > 0 &&
    jobs.every(
      (job) =>
        (job.if ?? '').includes("github.event.review.state == 'approved'") &&
        (job.if ?? '').includes(
          "github.event.review.author_association == 'OWNER'",
        ),
    )
  );
}

function permissionsAreExact(workflow: Workflow): boolean {
  const blocks = [
    workflow.permissions,
    ...jobsOf(workflow).map((job) => job.permissions),
  ].filter((block): block is Record<string, string> => block !== undefined);
  return (
    blocks.length > 0 &&
    blocks.every(
      (block) =>
        Object.keys(block).length === 2 &&
        block.contents === 'write' &&
        block['pull-requests'] === 'write',
    )
  );
}

function mergesWithAutoMergeCommit(workflow: Workflow): boolean {
  return stepsOf(workflow).some((step) => {
    const run = step.run ?? '';
    return (
      run.includes('gh pr merge') &&
      /--auto\b/.test(run) &&
      /--merge\b/.test(run)
    );
  });
}

function checksOutCode(workflow: Workflow): boolean {
  return stepsOf(workflow).some(
    (step) =>
      (step.uses ?? '').startsWith('actions/checkout') ||
      /git checkout|gh pr checkout|git clone|git fetch/.test(step.run ?? ''),
  );
}

describe('AI-10 workflow merge-on-approval', () => {
  it('AI-10 roda em pull_request_review com types [submitted]', () => {
    const workflow = loadWorkflow();

    expect(triggersOnSubmittedReview(workflow)).toBe(true);
    expect(
      triggersOnSubmittedReview({
        on: { pull_request_review: { types: ['submitted', 'edited'] } },
      }),
    ).toBe(false);
    expect(
      triggersOnSubmittedReview({
        on: { pull_request: { types: ['submitted'] } },
      }),
    ).toBe(false);
  });

  it('AI-10 o job só age para revisão approved de autor OWNER', () => {
    const workflow = loadWorkflow();

    expect(jobsRequireOwnerApproval(workflow)).toBe(true);
    expect(
      jobsRequireOwnerApproval({
        jobs: { merge: { if: "github.event.review.state == 'approved'" } },
      }),
    ).toBe(false);
    expect(
      jobsRequireOwnerApproval({
        jobs: {
          merge: { if: "github.event.review.author_association == 'OWNER'" },
        },
      }),
    ).toBe(false);
    expect(jobsRequireOwnerApproval({ jobs: { merge: {} } })).toBe(false);
  });

  it('AI-10 tem exatamente as permissões contents: write e pull-requests: write', () => {
    const workflow = loadWorkflow();

    expect(permissionsAreExact(workflow)).toBe(true);
    expect(permissionsAreExact({ permissions: { contents: 'write' } })).toBe(
      false,
    );
    expect(
      permissionsAreExact({
        permissions: { ...EXPECTED_PERMISSIONS, actions: 'write' },
      }),
    ).toBe(false);
    expect(
      permissionsAreExact({
        jobs: {
          merge: {
            permissions: { contents: 'write', 'pull-requests': 'read' },
          },
        },
      }),
    ).toBe(false);
  });

  it('AI-10 um passo liga o auto-merge com merge commit (gh pr merge --auto --merge)', () => {
    const workflow = loadWorkflow();

    expect(mergesWithAutoMergeCommit(workflow)).toBe(true);
    expect(
      mergesWithAutoMergeCommit({
        jobs: { merge: { steps: [{ run: 'gh pr merge 1 --merge' }] } },
      }),
    ).toBe(false);
    expect(
      mergesWithAutoMergeCommit({
        jobs: { merge: { steps: [{ run: 'gh pr merge 1 --auto --squash' }] } },
      }),
    ).toBe(false);
  });

  it('AI-10 nenhum passo faz checkout do código do PR', () => {
    const workflow = loadWorkflow();

    expect(checksOutCode(workflow)).toBe(false);
    expect(
      checksOutCode({
        jobs: { merge: { steps: [{ uses: 'actions/checkout@v4' }] } },
      }),
    ).toBe(true);
    expect(
      checksOutCode({
        jobs: { merge: { steps: [{ run: 'gh pr checkout 1' }] } },
      }),
    ).toBe(true);
  });
});
