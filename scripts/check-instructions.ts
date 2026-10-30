// Confere o tamanho das instruções da IA (FND-06). Da documentação do Claude
// Code vêm: até 200 linhas no AGENTS.md/CLAUDE.md e em cada regra de
// .claude/rules/; até 500 linhas por SKILL.md; e o corte de uma regra carregada
// sob demanda acima de 40.000 caracteres. As 200 linhas por agente são escolha
// do projeto: o corpo do agente entra em toda chamada dele. A skill tem também
// um teto em bytes: depois de uma compactação, o Claude Code devolve ao contexto
// só os primeiros 5.000 tokens de cada skill invocada, e o resto some no meio do
// marco. Sem um contador de tokens que rode sem rede no CI, 12.000 bytes ficam
// abaixo disso com folga para o tokenizador dos modelos em uso (cerca de 3 bytes
// por token); o material de referência vai para arquivos de apoio da skill, que
// não contam. As specs ficam de fora: os agentes as leem por trecho (AD-012).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INSTRUCTION_LINES = 200;
const MAX_SKILL_LINES = 500;
const MAX_SKILL_BYTES = 12_000;
const MAX_RULE_CHARS = 40_000;

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
  for (const path of markdownIn(join(rootDir, '.claude', 'rules'))) {
    const chars = readFileSync(path, 'utf8').length;
    if (chars > MAX_RULE_CHARS) {
      violations.push(`${relative(rootDir, path)} tem ${chars} caracteres, acima do limite de ${MAX_RULE_CHARS} (o Claude Code entrega só o começo)`);
    }
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
