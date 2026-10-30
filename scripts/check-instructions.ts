// Confere o tamanho do que o Claude Code carrega em toda sessão (FND-06), com os
// limites que a documentação dele recomenda: até 200 linhas por arquivo de
// instrução, por agente e por regra de .claude/rules/, e até 500 linhas por
// SKILL.md. Arquivo maior ocupa contexto em toda chamada e é seguido com menos
// fidelidade. A skill tem também um teto em bytes: depois de uma compactação, o
// Claude Code devolve ao contexto só os primeiros 5.000 tokens de cada skill
// invocada, e o que passar disso some no meio do marco. Sem um contador de
// tokens que rode sem rede no CI, 15.000 bytes ficam abaixo desses 5.000 tokens
// com folga (texto em inglês dá perto de 4 bytes por token). As specs ficam de
// fora de propósito: os agentes as leem por trecho (AD-012).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INSTRUCTION_LINES = 200;
const MAX_SKILL_LINES = 500;
const MAX_SKILL_BYTES = 15_000;

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
    ...markdownIn(join(rootDir, '.claude', 'rules')).map((path) => ({ path, max: MAX_INSTRUCTION_LINES })),
    ...skillFiles(join(rootDir, '.claude', 'skills')).map((path) => ({ path, max: MAX_SKILL_LINES })),
  ];

  const violations: string[] = [];
  for (const { path, max } of limits) {
    const lines = countLines(readFileSync(path, 'utf8'));
    if (lines > max) violations.push(`${relative(rootDir, path)} tem ${lines} linhas, acima do limite de ${max}`);
  }
  for (const path of skillFiles(join(rootDir, '.claude', 'skills'))) {
    const bytes = statSync(path).size;
    if (bytes > MAX_SKILL_BYTES) {
      violations.push(`${relative(rootDir, path)} tem ${bytes} bytes, acima do limite de ${MAX_SKILL_BYTES} (o que a compactação devolve ao contexto)`);
    }
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
