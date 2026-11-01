import { describe, expect, it } from 'vitest';
import {
  readCi,
  stepsOfWorkflow,
  workflowOf,
  type CiStep,
  type CiWorkflow,
} from '../helpers/ci-workflow.ts';

// AI-39: o CI roda `npm audit --omit=dev` e reprova o PR com qualquer vulnerabilidade conhecida nas dependências
// de produção. O passo tem de poder reprovar: nada de `|| true` nem `continue-on-error`.
const AUDIT = /(^|[\s;&|])npm audit(\s+--omit=dev)(\s|$)/;
const SWALLOWED = /\|\|\s*(true|exit\s+0|:)|;\s*(true|exit\s+0)\s*$/;

function auditSteps(workflow: CiWorkflow): CiStep[] {
  return stepsOfWorkflow(workflow).filter((step) => AUDIT.test(step.run ?? ''));
}

function canFail(step: CiStep): boolean {
  const ignored = step['continue-on-error'];
  return (
    !SWALLOWED.test(step.run ?? '') && ignored !== true && ignored !== 'true'
  );
}

describe('AI-39 o ci.yml audita as dependências de produção', () => {
  it('AI-39 o leitor acha npm audit --omit=dev e recusa o audit sem --omit=dev e o que não é audit', () => {
    expect(auditSteps(workflowOf('npm audit --omit=dev'))).toHaveLength(1);
    expect(auditSteps(workflowOf('npm audit'))).toHaveLength(0);
    expect(auditSteps(workflowOf('npm audit --omit=dev --json'))).toHaveLength(
      1,
    );
    expect(auditSteps(workflowOf('npm run audit'))).toHaveLength(0);
  });

  it('AI-39 o leitor reconhece o passo que engole a falha', () => {
    expect(canFail({ run: 'npm audit --omit=dev' })).toBe(true);
    expect(canFail({ run: 'npm audit --omit=dev || true' })).toBe(false);
    expect(canFail({ run: 'npm audit --omit=dev || exit 0' })).toBe(false);
    expect(
      canFail({ run: 'npm audit --omit=dev', 'continue-on-error': true }),
    ).toBe(false);
  });

  it('AI-39 tem um passo que roda npm audit --omit=dev', () => {
    expect(auditSteps(readCi()).length).toBeGreaterThan(0);
  });

  it('AI-39 o passo da auditoria reprova o PR: não engole a falha', () => {
    const steps = auditSteps(readCi());

    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) expect(canFail(step)).toBe(true);
  });
});
