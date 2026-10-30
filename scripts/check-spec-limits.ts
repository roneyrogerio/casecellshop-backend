// Confere os limites de tamanho das specs (FND-06): palavras de cada arquivo da
// tabela do .specs/README.md e 200 linhas no AGENTS.md e em cada agente.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INSTRUCTION_LINES = 200;

// Os seis arquivos da tabela do .specs/README.md. Se a tabela mudar de formato e
// o leitor não reconhecer uma linha, o arquivo ficaria sem conferência e o CI
// passaria verde; por isso a ausência do limite também é violação.
const SPEC_FILES = ['PROJECT.md', 'ROADMAP.md', 'STATE.md', 'spec.md', 'design.md', 'CONVENTIONS.md'];

// Como o `wc -w`: sequências separadas por espaço em branco.
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Como o `wc -l`: conta as quebras de linha.
function countLines(text: string): number {
  return (text.match(/\n/g) ?? []).length;
}

function findSpecFile(specsDir: string, name: string): string | undefined {
  const stack = [specsDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === name) return path;
    }
  }
  return undefined;
}

// Linhas da tabela: | `ARQUIVO.md` | 1.200 |  (o ponto é separador de milhar).
function readLimits(readme: string): { name: string; limit: number }[] {
  const limits: { name: string; limit: number }[] = [];
  for (const line of readme.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([\d.]+)\s*\|\s*$/.exec(line);
    if (match?.[1] && match[2]) limits.push({ name: match[1], limit: Number(match[2].replaceAll('.', '')) });
  }
  return limits;
}

export function checkSpecLimits(rootDir: string): string[] {
  const violations: string[] = [];
  const specsDir = join(rootDir, '.specs');

  const readmePath = join(specsDir, 'README.md');
  if (!existsSync(readmePath)) return [`.specs/README.md não existe em ${rootDir}`];

  const limits = readLimits(readFileSync(readmePath, 'utf8'));
  for (const name of SPEC_FILES) {
    if (!limits.some((entry) => entry.name === name)) {
      violations.push(`${name} não tem limite lido na tabela do .specs/README.md`);
    }
  }

  for (const { name, limit } of limits) {
    const path = findSpecFile(specsDir, name);
    if (!path) {
      violations.push(`${name} está na tabela do .specs/README.md, mas não foi encontrado`);
      continue;
    }
    const words = countWords(readFileSync(path, 'utf8'));
    if (words > limit) violations.push(`${name} tem ${words} palavras, acima do limite de ${limit}`);
  }

  const instructionFiles = [join(rootDir, 'AGENTS.md')];
  const agentsDir = join(rootDir, '.claude', 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir).filter((file) => file.endsWith('.md'))) {
      instructionFiles.push(join(agentsDir, entry));
    }
  }
  for (const path of instructionFiles) {
    if (!existsSync(path)) continue;
    const lines = countLines(readFileSync(path, 'utf8'));
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (lines > MAX_INSTRUCTION_LINES) {
      violations.push(`${name} tem ${lines} linhas, acima do limite de ${MAX_INSTRUCTION_LINES}`);
    }
  }
  return violations;
}

// Importar o módulo não roda a verificação: só a execução direta.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const violations = checkSpecLimits(root);
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  if (violations.length > 0) process.exit(1);
  process.stdout.write('Limites de tamanho respeitados.\n');
}
