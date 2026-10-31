import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface VitestReport {
  testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }>;
}

let criteriaIds: (specText: string) => string[];
let testIdOf: (title: string) => string | null;
let buildReport: (specText: string, report: VitestReport) => string;

const script = join(import.meta.dirname, 'criteria-report.ts');
const realSpecPath = join(import.meta.dirname, '..', '.specs', 'features', 'casecellshop', 'spec.md');

// Import dinâmico: o teste falha pela asserção, e não por import, enquanto o módulo é só um esboço.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(script).href)) as {
    criteriaIds: typeof criteriaIds;
    testIdOf: typeof testIdOf;
    buildReport: typeof buildReport;
  };
  criteriaIds = mod.criteriaIds;
  testIdOf = mod.testIdOf;
  buildReport = mod.buildReport;
});

const tmp = mkdtempSync(join(tmpdir(), 'criteria-report-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Spec sintético: um ID composto, dois IDs onde um é prefixo do outro, item aninhado, negrito que não é ID,
// ID repetido e ID fora do começo da linha.
const SPEC = [
  '# Spec',
  '',
  '- **AAA-01** primeiro critério',
  '  - **Modo bot:** item aninhado, não é critério',
  '- **BB-02** segundo critério, com **negrito** no meio',
  '- **Nota:** negrito que não é ID',
  '- **DOC-DIA-03** ID com duas partes',
  '- **AAA-010** ID que começa como o primeiro',
  'Veja **ZZ-99** na prosa e - **YY-98** no meio da linha.',
  '- **AAA-01** repetido',
  '- **aa-04** minúsculas não são ID',
  '',
].join('\n');

const t = (title: string, status = 'passed') => ({ title, status });
const report = (...files: Array<Array<{ title: string; status: string }>>): VitestReport => ({
  testResults: files.map((assertionResults) => ({ assertionResults })),
});

// Linhas da tabela (começam por `|`) que citam o ID inteiro, sem confundir AAA-01 com AAA-010.
function hasId(line: string, id: string): boolean {
  return new RegExp(`(?<![A-Z0-9-])${id}(?![A-Z0-9-])`).test(line);
}
function tableRows(markdown: string, id: string): string[] {
  return markdown.split('\n').filter((line) => line.trimStart().startsWith('|') && hasId(line, id));
}
function nonTableLines(markdown: string): string[] {
  return markdown.split('\n').filter((line) => !line.trimStart().startsWith('|'));
}
// Os números da linha, sem o ID: passou e falhou, nessa ordem.
function countsOf(row: string, id: string): string[] {
  return row.replace(new RegExp(`(?<![A-Z0-9-])${id}(?![A-Z0-9-])`), '').match(/\d+/g) ?? [];
}

describe('AI-18 criteriaIds lê os IDs dos itens do spec.md', () => {
  it('AI-18 devolve os IDs dos itens na ordem do spec, sem repetir', () => {
    expect(criteriaIds(SPEC)).toEqual(['AAA-01', 'BB-02', 'DOC-DIA-03', 'AAA-010']);
  });

  it('AI-18 item aninhado e negrito que não é ID não contam (controle negativo)', () => {
    const ids = criteriaIds(SPEC);

    expect(ids).not.toContain('Modo bot:');
    expect(ids).not.toContain('Nota:');
    expect(ids).toHaveLength(4);
  });

  it('AI-18 ID em negrito na prosa, no meio da linha ou em minúsculas não conta (controle negativo)', () => {
    const ids = criteriaIds(SPEC);

    expect(ids).not.toContain('ZZ-99');
    expect(ids).not.toContain('YY-98');
    expect(ids).not.toContain('aa-04');
  });

  it('AI-18 sem nenhum item devolve lista vazia', () => {
    expect(criteriaIds('# Spec\n\nsó texto\n')).toEqual([]);
    expect(criteriaIds('')).toEqual([]);
  });

  it('AI-18 no spec.md real acha FND-01, AI-18 e DOC-DIA-03, todos no formato de ID e sem repetição', () => {
    const ids = criteriaIds(readFileSync(realSpecPath, 'utf8'));

    expect(ids).toContain('FND-01');
    expect(ids).toContain('AI-18');
    expect(ids).toContain('DOC-DIA-03');
    expect(ids.every((id) => /^[A-Z]+(?:-[A-Z]+)*-\d+$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('AI-18 testIdOf devolve o ID que abre o nome do teste', () => {
  it.each([
    ['AI-15 o agent_id aparece no log', 'AI-15'],
    ['DOC-DIA-03 x', 'DOC-DIA-03'],
    ['FND-06', 'FND-06'],
    ['CHK-09 50 checkouts simultâneos', 'CHK-09'],
  ])('AI-18 o nome %j começa pelo ID %j', (title, id) => {
    expect(testIdOf(title)).toBe(id);
  });

  it.each([['controle: AI-15'], ['ai-15 x'], ['AI-15x'], ['AI-15-x y'], [' AI-15 x'], ['sem ID nenhum'], ['']])(
    'AI-18 o nome %j não começa por um ID (controle negativo)',
    (title) => {
      expect(testIdOf(title)).toBeNull();
    },
  );
});

describe('AI-18 buildReport cruza o relatório do Vitest com os critérios do spec.md', () => {
  it('AI-18 conta passou e falhou por critério, somando os arquivos do relatório', () => {
    const markdown = buildReport(
      SPEC,
      report(
        [t('BB-02 um'), t('BB-02 dois'), t('BB-02 três', 'failed')],
        [t('BB-02 quatro'), t('AAA-01 só falha', 'failed'), t('AAA-01 outra falha', 'failed')],
      ),
    );

    const bb = tableRows(markdown, 'BB-02');
    const aaa = tableRows(markdown, 'AAA-01');
    expect(bb).toHaveLength(1);
    expect(countsOf(bb[0] as string, 'BB-02')).toEqual(['3', '1']);
    expect(aaa).toHaveLength(1);
    expect(countsOf(aaa[0] as string, 'AAA-01')).toEqual(['0', '2']);
  });

  it('AI-18 teste skipped e todo não contam como passou nem como falhou', () => {
    const markdown = buildReport(
      SPEC,
      report([t('BB-02 passa'), t('BB-02 pulado', 'skipped'), t('BB-02 a fazer', 'todo'), t('BB-02 quebra', 'failed')]),
    );

    const rows = tableRows(markdown, 'BB-02');
    expect(rows).toHaveLength(1);
    expect(countsOf(rows[0] as string, 'BB-02')).toEqual(['1', '1']);
  });

  it('AI-18 critério sem nenhum teste de nome iniciado pelo ID leva a marca "sem teste"', () => {
    const markdown = buildReport(SPEC, report([t('BB-02 coberto')]));

    const covered = tableRows(markdown, 'BB-02');
    const bare = tableRows(markdown, 'DOC-DIA-03');
    expect(covered).toHaveLength(1);
    expect(covered[0]).not.toMatch(/sem teste/i);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatch(/sem teste/i);
  });

  it('AI-18 critério só com teste pulado tem teste (nome inicia pelo ID): a linha mostra 0 e 0, e não "sem teste"', () => {
    const markdown = buildReport(SPEC, report([t('BB-02 pulado', 'skipped')]));

    const rows = tableRows(markdown, 'BB-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/sem teste/i);
    expect(countsOf(rows[0] as string, 'BB-02')).toEqual(['0', '0']);
  });

  it('AI-18 relatório vazio deixa todos os critérios do spec "sem teste", um por linha, na ordem do spec', () => {
    const markdown = buildReport(SPEC, report());

    const order = ['AAA-01', 'BB-02', 'DOC-DIA-03', 'AAA-010'];
    for (const id of order) {
      const rows = tableRows(markdown, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatch(/sem teste/i);
    }
    const lines = markdown.split('\n');
    const positions = order.map((id) => lines.findIndex((line) => line.trimStart().startsWith('|') && hasId(line, id)));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it('AI-18 ID no meio do nome não conta para o critério (controle negativo)', () => {
    const markdown = buildReport(SPEC, report([t('controle: BB-02 no meio'), t('o teste do BB-02', 'failed')]));

    const rows = tableRows(markdown, 'BB-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/sem teste/i);
  });

  it('AI-18 um ID que é prefixo de outro não rouba os testes dele: AAA-010 não conta para AAA-01 (controle negativo)', () => {
    const markdown = buildReport(SPEC, report([t('AAA-010 longo'), t('AAA-010 longo dois'), t('AAA-01x colado')]));

    const short = tableRows(markdown, 'AAA-01');
    const long = tableRows(markdown, 'AAA-010');
    expect(short).toHaveLength(1);
    expect(short[0]).toMatch(/sem teste/i);
    expect(long).toHaveLength(1);
    expect(countsOf(long[0] as string, 'AAA-010')).toEqual(['2', '0']);
  });

  it('AI-18 ID composto com duas partes é contado pelo ID inteiro', () => {
    const markdown = buildReport(SPEC, report([t('DOC-DIA-03 x'), t('DOC-DIA-03 y', 'failed')]));

    const rows = tableRows(markdown, 'DOC-DIA-03');
    expect(rows).toHaveLength(1);
    expect(countsOf(rows[0] as string, 'DOC-DIA-03')).toEqual(['1', '1']);
  });

  it('AI-18 ID que não existe no spec.md vai para a lista à parte e não vira linha da tabela', () => {
    const markdown = buildReport(SPEC, report([t('BB-02 ok'), t('XYZ-77 órfão'), t('XYZ-77 outro órfão', 'failed')]));

    expect(tableRows(markdown, 'XYZ-77')).toEqual([]);
    const apart = nonTableLines(markdown).filter((line) => hasId(line, 'XYZ-77'));
    expect(apart).toHaveLength(1);
  });

  it('AI-18 sem ID órfão a lista à parte não cita nenhum ID (controle negativo)', () => {
    const markdown = buildReport(SPEC, report([t('BB-02 ok'), t('AAA-01 ok'), t('sem ID nenhum')]));

    const ids = ['AAA-01', 'BB-02', 'DOC-DIA-03', 'AAA-010', 'ZZ-99', 'YY-98'];
    const cited = nonTableLines(markdown).filter((line) => ids.some((id) => hasId(line, id)));
    expect(cited).toEqual([]);
  });

  it('AI-18 teste sem ID no nome não entra na tabela nem na lista à parte', () => {
    const markdown = buildReport(SPEC, report([t('um teste qualquer sem ID', 'failed'), t('outro sem ID')]));

    expect(markdown).not.toContain('um teste qualquer sem ID');
    expect(markdown).not.toContain('outro sem ID');
    expect(tableRows(markdown, 'BB-02')[0]).toMatch(/sem teste/i);
  });

  it('AI-18 a tabela não reprova: relatório com falhas ainda gera Markdown com título e as linhas', () => {
    const markdown = buildReport(SPEC, report([t('BB-02 quebra', 'failed')]));

    expect(markdown).toMatch(/^#/m);
    expect(tableRows(markdown, 'BB-02')).toHaveLength(1);
  });
});

describe('AI-18 o processo criteria-report.ts: stdout, código de saída e stderr', () => {
  const specFile = join(tmp, 'spec.md');
  const reportFile = join(tmp, 'report.json');
  const garbageFile = join(tmp, 'garbage.json');

  beforeAll(() => {
    writeFileSync(specFile, SPEC);
    writeFileSync(
      reportFile,
      JSON.stringify(report([t('BB-02 passa'), t('BB-02 falha', 'failed'), t('FND-01 do spec real')])),
    );
    writeFileSync(garbageFile, '{ isto não é JSON');
  });

  function run(args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: tmp });
  }

  it('AI-18 imprime a tabela no stdout e sai com 0, mesmo com teste falhando no relatório', () => {
    const result = run([reportFile, specFile]);

    expect(result.status).toBe(0);
    const rows = tableRows(result.stdout, 'BB-02');
    expect(rows).toHaveLength(1);
    expect(countsOf(rows[0] as string, 'BB-02')).toEqual(['1', '1']);
    expect(tableRows(result.stdout, 'DOC-DIA-03')[0]).toMatch(/sem teste/i);
  });

  it('AI-18 sem o segundo argumento usa o spec.md do repositório, qualquer que seja o diretório de trabalho', () => {
    const result = run([reportFile]);

    expect(result.status).toBe(0);
    const fnd = tableRows(result.stdout, 'FND-01');
    expect(fnd).toHaveLength(1);
    expect(countsOf(fnd[0] as string, 'FND-01')).toEqual(['1', '0']);
    expect(tableRows(result.stdout, 'AAA-01')).toEqual([]);
  });

  it('AI-18 sem o argumento do relatório sai com código diferente de 0 e diz o motivo no stderr', () => {
    const result = run([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });

  it('AI-18 relatório inexistente sai com código diferente de 0 e diz o motivo no stderr', () => {
    const result = run([join(tmp, 'nao-existe.json'), specFile]);

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });

  it('AI-18 relatório com JSON ilegível sai com código diferente de 0 e diz o motivo no stderr', () => {
    const result = run([garbageFile, specFile]);

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });

  it('AI-18 spec.md ilegível (inexistente) sai com código diferente de 0 e diz o motivo no stderr', () => {
    const result = run([reportFile, join(tmp, 'sem-spec.md')]);

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe('');
  });
});
