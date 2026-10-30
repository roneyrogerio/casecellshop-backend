// Confere o tamanho do que o Claude Code carrega em toda sessão (FND-06), com os
// limites que a documentação dele recomenda: até 200 linhas por arquivo de
// instrução e por agente, e até 500 linhas por SKILL.md. Arquivo maior ocupa
// contexto em toda chamada e é seguido com menos fidelidade. As specs ficam de
// fora de propósito: os agentes as leem por trecho, e um teto de palavras só
// forçava apagar raciocínio (AD-012).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INSTRUCTION_LINES = 200;
const MAX_SKILL_LINES = 500;

// Como o `wc -l`: conta as quebras de linha.
function countLines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function markdownIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => join(dir, file));
}

function skillFiles(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsDir, entry.name, 'SKILL.md'))
    .filter((path) => existsSync(path));
}

export function checkInstructions(rootDir: string): string[] {
  const limits: { path: string; max: number }[] = [
    ...[join(rootDir, 'AGENTS.md'), join(rootDir, 'CLAUDE.md')]
      .filter((path) => existsSync(path))
      .map((path) => ({ path, max: MAX_INSTRUCTION_LINES })),
    ...markdownIn(join(rootDir, '.claude', 'agents')).map((path) => ({ path, max: MAX_INSTRUCTION_LINES })),
    ...skillFiles(join(rootDir, '.claude', 'skills')).map((path) => ({ path, max: MAX_SKILL_LINES })),
  ];

  const violations: string[] = [];
  for (const { path, max } of limits) {
    const lines = countLines(readFileSync(path, 'utf8'));
    if (lines > max) violations.push(`${relative(rootDir, path)} tem ${lines} linhas, acima do limite de ${max}`);
  }
  return violations;
}

// Importar o módulo não roda a verificação: só a execução direta.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const violations = checkInstructions(root);
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  if (violations.length > 0) process.exit(1);
  process.stdout.write('Instruções dentro dos limites do Claude Code.\n');
}
