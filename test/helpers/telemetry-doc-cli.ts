import { repoRoot } from './repo-root.ts';
import { runNode, type NodeRun } from './run-node.ts';

// Roda o CLI do gerador do telemetry.md (scripts/generate-telemetry-doc.ts) como processo, a partir da raiz do
// repositório. Os testes do script e o de repositório usam o mesmo ponto de entrada.
export function runTelemetryDoc(...args: string[]): NodeRun {
  return runNode('scripts/generate-telemetry-doc.ts', args, {
    cwd: repoRoot,
    env: process.env,
  });
}
