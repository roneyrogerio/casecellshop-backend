// AI-18: tabela critério × teste para o resumo do CI, que o dono lê antes de
// aprovar. Cruza o relatório JSON do Vitest com os IDs do spec.md: um teste conta
// para o critério cujo ID abre o nome dele. Informa e não reprova; só falha sem
// relatório ou spec legível, porque aí a tabela sairia vazia sem aviso.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface VitestReport {
  testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
}

const ID = String.raw`[A-Z]+(?:-[A-Z]+)*-\d+`;
// Com recuo também: os critérios DOC-* são itens aninhados sob a pergunta do desafio.
const SPEC_ITEM = new RegExp(String.raw`^\s*- \*\*(${ID})\*\*`);
const TEST_ID = new RegExp(String.raw`^(${ID})(?= |$)`);

// IDs dos critérios do spec.md, na ordem em que aparecem (itens `- **ID**`).
export function criteriaIds(specText: string): string[] {
  const ids = specText.split('\n').flatMap((line) => SPEC_ITEM.exec(line)?.[1] ?? []);
  return [...new Set(ids)];
}

// O ID que abre o nome do teste, ou null quando o nome não começa por um ID.
export function testIdOf(title: string): string | null {
  return TEST_ID.exec(title)?.[1] ?? null;
}

// A tabela em Markdown, com a lista à parte dos IDs que não estão no spec.md.
// Teste pulado ou pendente tem nome com o ID, então o critério tem teste, mas
// não conta como passou nem como falhou.
export function buildReport(specText: string, report: VitestReport): string {
  const ids = criteriaIds(specText);
  const counts = new Map<string, { passed: number; failed: number }>();
  for (const { title, status } of report.testResults.flatMap((file) => file.assertionResults)) {
    const id = testIdOf(title);
    if (!id) continue;
    const count = counts.get(id) ?? { passed: 0, failed: 0 };
    if (status === 'passed') count.passed += 1;
    if (status === 'failed') count.failed += 1;
    counts.set(id, count);
  }

  const rows = ids.map((id) => {
    const count = counts.get(id);
    return count ? `| ${id} | ${count.passed} | ${count.failed} |` : `| ${id} | sem teste | |`;
  });
  const orphans = [...counts.keys()].filter((id) => !ids.includes(id)).sort();

  return [
    '## Critérios × testes',
    '',
    '| Critério | Passaram | Falharam |',
    '| --- | --- | --- |',
    ...rows,
    '',
    orphans.length > 0
      ? `Testes com ID fora do spec.md: ${orphans.map((id) => `\`${id}\``).join(', ')}.`
      : 'Todo ID em nome de teste existe no spec.md.',
    '',
  ].join('\n');
}

function main(): number {
  const [reportPath, specPath = join(import.meta.dirname, '..', '.specs', 'features', 'casecellshop', 'spec.md')] =
    process.argv.slice(2);
  if (!reportPath) {
    console.error('uso: node scripts/criteria-report.ts <relatório.json do Vitest> [spec.md]');
    return 1;
  }
  let report: VitestReport;
  let specText: string;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestReport;
    specText = readFileSync(specPath, 'utf8');
  } catch (error) {
    console.error(`criteria-report: não deu para ler o relatório ou o spec (${(error as Error).message}).`);
    return 1;
  }
  if (!Array.isArray(report?.testResults)) {
    console.error('criteria-report: o relatório não tem testResults; é o JSON do reporter json do Vitest?');
    return 1;
  }
  process.stdout.write(buildReport(specText, report));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
