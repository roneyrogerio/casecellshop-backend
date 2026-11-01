import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoRoot as root } from '../helpers/repo-root.ts';

const REVIEWER = '.claude/agents/reviewer.md';
const MARCO = '.claude/skills/marco/SKILL.md';
const MAX_SKILL_BYTES = 12_000;

// Lê o arquivo linha a linha sabendo o que está dentro de um bloco cercado: o esqueleto do relatório
// traz títulos `## Revisão` dentro de um bloco, e eles não encerram a seção em que o bloco está.
function fenceMarker(line: string): string | undefined {
  return /^(`{3,}|~{3,})/.exec(line)?.[1];
}

function sectionOf(content: string, title: string): string {
  const heading = new RegExp(`^## (?:\\d+\\.\\s*)?${title}\\s*$`);
  const out: string[] = [];
  let fence: string | null = null;
  let inside = false;
  for (const line of content.split('\n')) {
    const marker = fenceMarker(line);
    if (fence !== null) {
      if (
        marker !== undefined &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        line.trim() === marker
      )
        fence = null;
    } else if (marker !== undefined) {
      fence = marker;
    } else if (line.startsWith('## ')) {
      if (inside) break;
      inside = heading.test(line);
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join('\n');
}

// Os blocos cercados do texto (o corpo, sem as cercas) e o texto sem eles.
function splitFences(text: string): { blocks: string[]; prose: string } {
  const blocks: string[] = [];
  const prose: string[] = [];
  let fence: string | null = null;
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const marker = fenceMarker(line);
    if (fence === null) {
      if (marker === undefined) prose.push(line);
      else {
        fence = marker;
        current = [];
      }
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      blocks.push(current.join('\n'));
      fence = null;
    } else {
      current.push(line);
    }
  }
  return { blocks, prose: prose.join('\n') };
}

// Itens de lista e parágrafos, para exigir que duas ideias estejam no mesmo trecho e não espalhadas pelo arquivo.
function chunksOf(text: string): string[] {
  return text.split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.)\s)/);
}

function someChunk(text: string, patterns: RegExp[]): boolean {
  return chunksOf(text).some((chunk) =>
    patterns.every((pattern) => pattern.test(chunk)),
  );
}

// O esqueleto do relatório: o primeiro bloco cercado da seção Report que abre com o título `## Revisão`.
function skeletonOf(report: string): string | undefined {
  return splitFences(report).blocks.find((block) =>
    /^## Revisão\b/m.test(block),
  );
}

function reviewerViolations(content: string): string[] {
  const violations: string[] = [];
  const report = sectionOf(content, 'Report');
  if (report === '') return ['o reviewer não tem a seção ## Report'];

  const skeleton = skeletonOf(report);
  if (skeleton === undefined) {
    violations.push(
      'a seção Report não traz o esqueleto do relatório num bloco de código com o título ## Revisão',
    );
  } else {
    if (!/^## Revisão\b[^\n]*\b(?:APROVADO|REPROVADO)\b/m.test(skeleton)) {
      violations.push(
        'o esqueleto não abre com ## Revisão e o veredito (APROVADO ou REPROVADO) na mesma linha',
      );
    }

    // As linhas logo abaixo do título e antes da tabela: a base e o head, e as contagens com o CI.
    const lines = skeleton.split('\n');
    const headingAt = lines.findIndex((line) => /^## Revisão\b/.test(line));
    const top: string[] = [];
    for (const line of lines.slice(headingAt + 1)) {
      if (line.trim() === '') continue;
      if (line.trimStart().startsWith('|') || top.length >= 4) break;
      top.push(line);
    }
    if (!top.some((line) => /\bbase\b/i.test(line) && /\bhead\b/i.test(line))) {
      violations.push(
        'o esqueleto não traz, logo abaixo do veredito, a linha com a base e o head',
      );
    }
    if (
      !top.some(
        (line) =>
          /\balta\b/.test(line) &&
          /m[ée]dia/.test(line) &&
          /\bbaixa\b/.test(line) &&
          /\bCI\b/.test(line),
      )
    ) {
      violations.push(
        'o esqueleto não traz, logo abaixo do veredito, a linha com a contagem de abertos por severidade (alta, média, baixa) e o CI',
      );
    }

    if (
      !/^\|\s*ID\s*\|[^\n]*severidade[^\n]*\|[^\n]*onde[^\n]*\|[^\n]*problema[^\n|]*\|?\s*\n\|\s*:?-+/im.test(
        skeleton,
      )
    ) {
      violations.push(
        'o esqueleto não traz a tabela de achados abertos (colunas ID, severidade, onde, problema)',
      );
    }
    if (!/rodada anterior/i.test(skeleton))
      violations.push('o esqueleto não traz a linha da rodada anterior');
    if (!/cr[ií]t[ée]rios sem teste/i.test(skeleton))
      violations.push('o esqueleto não traz a linha dos critérios sem teste');

    const summaries = [
      ...skeleton.matchAll(
        /<details>\s*<summary>([^<]*)<\/summary>[\s\S]*?<\/details>/g,
      ),
    ].map((match) => match[1] ?? '');
    if (!summaries.some((summary) => /Conferido sem achado/i.test(summary))) {
      violations.push(
        'o esqueleto não recolhe "Conferido sem achado" em <details> com <summary>',
      );
    }
    if (!summaries.some((summary) => /\bCI\b/.test(summary))) {
      violations.push(
        'o esqueleto não recolhe "CI" em <details> com <summary>',
      );
    }

    const trailer = /<!--([\s\S]*?)-->\s*$/.exec(skeleton)?.[1];
    if (trailer === undefined)
      violations.push(
        'o esqueleto não termina com um comentário HTML (<!-- … -->)',
      );
    else if (!/\{[\s\S]*"[^"]+"\s*:[\s\S]*\}/.test(trailer))
      violations.push('o comentário HTML final do esqueleto não traz um JSON');
  }

  const prose = splitFences(report).prose;
  if (
    !someChunk(prose, [
      /\balta\b/,
      /m[ée]dia/,
      /falha|failure/i,
      /reprodu[cç]/i,
      /corre[cç]|fix/i,
    ])
  ) {
    violations.push(
      'o texto não exige o bloco completo (falha, reprodução, correção) para alta e média',
    );
  }
  if (
    !someChunk(prose, [
      /path:line/,
      /a confirmar/,
      /reprodu[cç]/i,
      /crit[ée]rio|criteri(?:on|a)/i,
      /sem teste|without (?:a )?test/i,
      /\bnada\b|\bnothing\b/i,
    ])
  ) {
    violations.push(
      'o texto não diz que nada que o processo exige sai (reprodução, path:line, critério, "a confirmar", critérios sem teste)',
    );
  }
  if (
    !someChunk(prose, [
      /\b(?:size|length|tamanho)\b/i,
      /\b(?:task|tarefa)\b/i,
      /adjust|ajust|scale|match|fit|proporcion/i,
    ])
  ) {
    violations.push(
      'o texto não manda ajustar o tamanho do relatório ao que a tarefa pede',
    );
  }
  return violations;
}

function marcoViolations(content: string): string[] {
  const violations: string[] = [];
  const step = sectionOf(content, 'Ready and merge');
  if (step === '') return ['a skill não tem o passo "Ready and merge"'];

  const at = step.indexOf('Resumo de decisão');
  if (at < 0) {
    violations.push(
      'o passo "Ready and merge" não manda abrir a descrição do PR com o "Resumo de decisão"',
    );
  } else {
    if (
      !/(?:description|descri[cç][ãa]o)[^\n]{0,120}\b(?:open|start|begin|top|abre)|\b(?:open|start|begin|top)[^\n]{0,120}(?:description|descri[cç][ãa]o)/i.test(
        step,
      )
    ) {
      violations.push(
        'o passo não diz que a descrição do PR abre (topo) com o resumo',
      );
    }
    const summary = step.slice(at);
    const items: [string, RegExp][] = [
      ['o que o PR entrega', /deliver|entreg/i],
      ['o que pede o julgamento do mantenedor', /judg?ment|julgamento/i],
      ['"nada" quando nada pede decisão', /\bnada\b|\bnothing\b/i],
      [
        'a evidência de máquina',
        /machine evidence|evid[êe]ncia de m[áa]quina/i,
      ],
      ['as áreas de risco tocadas', /risk areas?|[áa]reas? de risco/i],
    ];
    for (const [label, pattern] of items) {
      if (!pattern.test(summary))
        violations.push(`o "Resumo de decisão" não lista ${label}`);
    }
  }

  if (!/\b2\s*(?:to|-|–|a|à)\s*5\s*min/i.test(step))
    violations.push(
      'o passo "Ready and merge" não fixa o alvo de leitura de 2 a 5 minutos',
    );
  if (/~\s*10\s*min/i.test(content))
    violations.push('a skill ainda fala da leitura de "~10 min"');
  if (Buffer.byteLength(content) > MAX_SKILL_BYTES)
    violations.push(
      `a skill passa de ${MAX_SKILL_BYTES} bytes (limite do check:instructions)`,
    );
  return violations;
}

const scratch = mkdtempSync(path.join(tmpdir(), 'review-format-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// Escreve a cópia numa pasta temporária fora do repositório e a lê de volta, como a conferência a leria.
function copyOf(name: string, content: string): string {
  const folder = path.join(scratch, name);
  mkdirSync(folder, { recursive: true });
  const copy = path.join(folder, 'copy.md');
  writeFileSync(copy, content);
  return readFileSync(copy, 'utf8');
}

function readRepo(relative: string): string {
  return readFileSync(path.join(root, relative), 'utf8');
}

// Uma seção Report conforme o AI-23, para provar que a conferência aceita o formato certo e reprova cada desvio.
const FENCE = '`'.repeat(4);
const GOOD_REVIEWER = [
  '---',
  'name: reviewer',
  '---',
  '',
  '## Scope',
  '',
  'Texto qualquer.',
  '',
  '## Report',
  '',
  'Adjust the length of the report to what the task asks for: a text-fix check is a few lines, a whole-PR round is the full skeleton.',
  '',
  '- Only an `alta` or `média` finding gets the full block (falha, reprodução, correção); a `baixa` stays in its table row.',
  '- Nothing the process requires leaves the report: the reproduction, the `path:line`, the criterion, what stays "a confirmar" and the',
  '  "Critérios sem teste", even when there is none ("nenhum").',
  '',
  `${FENCE}markdown`,
  '## Revisão <n> · APROVADO | REPROVADO',
  'Base `<sha>` · head `<sha>`',
  'Abertos: <n> alta, <n> média, <n> baixa · CI: verde | vermelho',
  'Critérios sem teste: nenhum',
  '',
  '| ID | Severidade | Onde | Problema |',
  '| --- | --- | --- | --- |',
  '| A1 | alta | `src/x.ts:10` | uma linha |',
  '',
  '### A1 · alta · `src/x.ts:10` · AI-00',
  '**Falha:** …  **Reprodução:** …  **Correção:** …',
  '',
  'Rodada anterior: A1 corrigido',
  '',
  '<details>',
  '<summary>Conferido sem achado</summary>',
  '',
  '- item',
  '</details>',
  '',
  '<details>',
  '<summary>CI e comandos</summary>',
  '',
  '- comando',
  '</details>',
  '',
  '<!-- {"rodada": 1, "veredito": "APROVADO", "alta": 0, "media": 0, "baixa": 0} -->',
  FENCE,
  '',
].join('\n');

const GOOD_MARCO = [
  '---',
  'name: marco',
  '---',
  '',
  '## Essentials',
  '',
  '- The maintainer reads only the "Resumo de decisão", in 2 to 5 minutes.',
  '',
  '## 6. Ready and merge',
  '',
  'Then:',
  '',
  '- open the PR description with a "Resumo de decisão" of up to ~300 words: what the PR delivers; what needs the maintainer\'s judgment',
  '  (or "nada"); the machine evidence, one line each; and the risk areas touched. The maintainer reads only that block, in 2 to 5 minutes.',
  '',
  '## 7. Close',
  '',
  'Fim.',
  '',
].join('\n');

describe('AI-23 o esqueleto do relatório nas instruções do reviewer', () => {
  const report = (): string => sectionOf(readRepo(REVIEWER), 'Report');
  const skeleton = (): string => skeletonOf(report()) ?? '';

  it('AI-23 a seção Report traz o esqueleto do relatório num bloco de código markdown', () => {
    expect(
      skeletonOf(report()),
      'a seção Report não tem um bloco de código com o título ## Revisão',
    ).toBeDefined();
  });

  it('AI-23 o esqueleto abre com ## Revisão e o veredito na mesma linha, e logo abaixo vêm a base e o head e a contagem por severidade com o CI', () => {
    // Sem o esqueleto as linhas não existem: a conferência dele precisa vir antes, para não passar no vazio.
    expect(
      skeletonOf(report()),
      'a seção Report não tem o esqueleto',
    ).toBeDefined();
    const violations = reviewerViolations(readRepo(REVIEWER)).filter(
      (violation) =>
        violation.includes('abre com') || violation.includes('logo abaixo'),
    );

    expect(violations).toEqual([]);
  });

  it('AI-23 o esqueleto traz a tabela de achados abertos, a rodada anterior e os critérios sem teste', () => {
    const text = skeleton();

    expect(text).toMatch(
      /^\|\s*ID\s*\|[^\n]*severidade[^\n]*\|[^\n]*onde[^\n]*\|[^\n]*problema/im,
    );
    expect(text).toMatch(/rodada anterior/i);
    expect(text).toMatch(/cr[ií]t[ée]rios sem teste/i);
  });

  it('AI-23 o esqueleto recolhe "Conferido sem achado" e "CI" em <details> com <summary>', () => {
    const text = skeleton();

    expect(text).toMatch(
      /<details>\s*<summary>[^<]*Conferido sem achado[^<]*<\/summary>[\s\S]*?<\/details>/i,
    );
    expect(text).toMatch(
      /<details>\s*<summary>[^<]*\bCI\b[^<]*<\/summary>[\s\S]*?<\/details>/,
    );
  });

  it('AI-23 o esqueleto termina com um comentário HTML com as contagens em JSON', () => {
    const trailer = /<!--([\s\S]*?)-->\s*$/.exec(skeleton())?.[1];

    expect(trailer, 'o esqueleto não termina com <!-- … -->').toBeDefined();
    expect(trailer).toMatch(/\{[\s\S]*"[^"]+"\s*:[\s\S]*\}/);
  });

  it('AI-23 o texto exige o bloco completo (falha, reprodução, correção) para alta e média', () => {
    const prose = splitFences(report()).prose;

    expect(
      someChunk(prose, [
        /\balta\b/,
        /m[ée]dia/,
        /falha|failure/i,
        /reprodu[cç]/i,
        /corre[cç]|fix/i,
      ]),
    ).toBe(true);
  });

  it('AI-23 o texto diz que nada que o processo exige sai: reprodução, path:line, critério, "a confirmar" e critérios sem teste', () => {
    const prose = splitFences(report()).prose;

    expect(
      someChunk(prose, [
        /path:line/,
        /a confirmar/,
        /reprodu[cç]/i,
        /crit[ée]rio|criteri(?:on|a)/i,
        /sem teste|without (?:a )?test/i,
        /\bnada\b|\bnothing\b/i,
      ]),
    ).toBe(true);
  });

  it('AI-23 o texto manda ajustar o tamanho do relatório ao que a tarefa pede', () => {
    const prose = splitFences(report()).prose;

    expect(
      someChunk(prose, [
        /\b(?:size|length|tamanho)\b/i,
        /\b(?:task|tarefa)\b/i,
        /adjust|ajust|scale|match|fit|proporcion/i,
      ]),
    ).toBe(true);
  });

  it('AI-23 a conferência inteira não acusa nada nas instruções do reviewer', () => {
    expect(reviewerViolations(readRepo(REVIEWER))).toEqual([]);
  });

  it('AI-23 controle positivo: a conferência aceita uma cópia no formato do AI-23', () => {
    expect(reviewerViolations(copyOf('reviewer-bom', GOOD_REVIEWER))).toEqual(
      [],
    );
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer sem o <details>', () => {
    const copy = copyOf(
      'reviewer-sem-details',
      GOOD_REVIEWER.replace(/<\/?details>/g, '').replace(/<\/?summary>/g, ''),
    );

    expect(reviewerViolations(copy)).toEqual([
      'o esqueleto não recolhe "Conferido sem achado" em <details> com <summary>',
      'o esqueleto não recolhe "CI" em <details> com <summary>',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer sem o comentário HTML final', () => {
    const copy = copyOf(
      'reviewer-sem-comentario',
      GOOD_REVIEWER.replace(/^<!--.*-->\n/m, ''),
    );

    expect(reviewerViolations(copy)).toEqual([
      'o esqueleto não termina com um comentário HTML (<!-- … -->)',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer cujo comentário final não traz JSON', () => {
    const copy = copyOf(
      'reviewer-comentario-sem-json',
      GOOD_REVIEWER.replace(/^<!--.*-->$/m, '<!-- rodada 1, sem achados -->'),
    );

    expect(reviewerViolations(copy)).toEqual([
      'o comentário HTML final do esqueleto não traz um JSON',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer sem o esqueleto (o formato antigo)', () => {
    const copy = copyOf(
      'reviewer-sem-esqueleto',
      GOOD_REVIEWER.replace(/^````markdown[\s\S]*?^````\n/m, ''),
    );

    expect(reviewerViolations(copy)).toContain(
      'a seção Report não traz o esqueleto do relatório num bloco de código com o título ## Revisão',
    );
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer sem a tabela de achados', () => {
    const copy = copyOf(
      'reviewer-sem-tabela',
      GOOD_REVIEWER.replace(/^\| ID .*\n^\| --- .*\n/gm, ''),
    );

    expect(reviewerViolations(copy)).toEqual([
      'o esqueleto não traz a tabela de achados abertos (colunas ID, severidade, onde, problema)',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer com o veredito fora da linha do título', () => {
    const copy = copyOf(
      'reviewer-veredito',
      GOOD_REVIEWER.replace(
        '## Revisão <n> · APROVADO | REPROVADO',
        '## Revisão <n>\nAPROVADO',
      ),
    );

    expect(reviewerViolations(copy)).toContain(
      'o esqueleto não abre com ## Revisão e o veredito (APROVADO ou REPROVADO) na mesma linha',
    );
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia do reviewer sem a instrução do bloco completo e sem a de tamanho', () => {
    const copy = copyOf(
      'reviewer-sem-regras',
      GOOD_REVIEWER.replace(/^Adjust the length.*\n/m, '')
        .replace(/^- Only an .*\n/m, '')
        .replace(/^- Nothing the process[\s\S]*?\n\n/m, ''),
    );

    expect(reviewerViolations(copy)).toEqual([
      'o texto não exige o bloco completo (falha, reprodução, correção) para alta e média',
      'o texto não diz que nada que o processo exige sai (reprodução, path:line, critério, "a confirmar", critérios sem teste)',
      'o texto não manda ajustar o tamanho do relatório ao que a tarefa pede',
    ]);
  });
});

describe('AI-23 o resumo de decisão e o alvo de tempo na skill marco', () => {
  const step = (): string => sectionOf(readRepo(MARCO), 'Ready and merge');

  it('AI-23 o passo "Ready and merge" manda a descrição do PR abrir com o "Resumo de decisão"', () => {
    expect(step(), 'a skill marco não tem o passo "Ready and merge"').not.toBe(
      '',
    );
    expect(step()).toContain('Resumo de decisão');
  });

  it('AI-23 o "Resumo de decisão" tem os quatro itens: o que entrega, o julgamento do mantenedor ou "nada", a evidência de máquina e as áreas de risco', () => {
    const violations = marcoViolations(readRepo(MARCO)).filter(
      (violation) =>
        violation.startsWith('o "Resumo de decisão"') ||
        violation.includes('abre (topo)'),
    );

    expect(violations).toEqual([]);
    expect(step()).toContain('Resumo de decisão');
  });

  it('AI-23 o alvo de leitura do mantenedor é de 2 a 5 minutos', () => {
    expect(step()).toMatch(/\b2\s*(?:to|-|–|a|à)\s*5\s*min/i);
  });

  it('AI-23 o texto antigo "~10 min" não aparece mais na skill', () => {
    expect(readRepo(MARCO)).not.toMatch(/~\s*10\s*min/i);
  });

  it('AI-23 a skill continua com até 12.000 bytes, o limite do check:instructions', () => {
    expect(Buffer.byteLength(readRepo(MARCO))).toBeLessThanOrEqual(
      MAX_SKILL_BYTES,
    );
  });

  it('AI-23 a conferência inteira não acusa nada na skill marco', () => {
    expect(marcoViolations(readRepo(MARCO))).toEqual([]);
  });

  it('AI-23 controle positivo: a conferência aceita uma cópia da skill no formato do AI-23', () => {
    expect(marcoViolations(copyOf('marco-bom', GOOD_MARCO))).toEqual([]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia da skill que ainda diz "~10 min"', () => {
    const copy = copyOf(
      'marco-10-min',
      GOOD_MARCO.replace('in 2 to 5 minutes.', 'in ~10 min.').replace(
        'in 2 to 5 minutes.',
        'in ~10 min.',
      ),
    );

    expect(marcoViolations(copy)).toEqual([
      'o passo "Ready and merge" não fixa o alvo de leitura de 2 a 5 minutos',
      'a skill ainda fala da leitura de "~10 min"',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia da skill que mantém "~10 min" fora do passo, ao lado do alvo novo', () => {
    const copy = copyOf(
      'marco-10-min-essentials',
      GOOD_MARCO.replace('in 2 to 5 minutes.\n\n## 6.', 'in ~10 min.\n\n## 6.'),
    );

    expect(marcoViolations(copy)).toEqual([
      'a skill ainda fala da leitura de "~10 min"',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia da skill sem o "Resumo de decisão"', () => {
    const copy = copyOf(
      'marco-sem-resumo',
      GOOD_MARCO.replace(
        'with a "Resumo de decisão" of up to ~300 words',
        'with the milestone record',
      ),
    );

    expect(marcoViolations(copy)[0]).toBe(
      'o passo "Ready and merge" não manda abrir a descrição do PR com o "Resumo de decisão"',
    );
  });

  it('AI-23 controle negativo: a conferência reprova um "Resumo de decisão" sem a evidência de máquina e sem as áreas de risco', () => {
    const copy = copyOf(
      'marco-resumo-incompleto',
      GOOD_MARCO.replace(
        'the machine evidence, one line each; and the risk areas touched',
        'and the rest',
      ),
    );

    expect(marcoViolations(copy)).toEqual([
      'o "Resumo de decisão" não lista a evidência de máquina',
      'o "Resumo de decisão" não lista as áreas de risco tocadas',
    ]);
  });

  it('AI-23 controle negativo: a conferência reprova uma cópia da skill acima de 12.000 bytes', () => {
    const copy = copyOf(
      'marco-grande',
      `${GOOD_MARCO}\n${'x'.repeat(MAX_SKILL_BYTES)}\n`,
    );

    expect(marcoViolations(copy)).toEqual([
      `a skill passa de ${MAX_SKILL_BYTES} bytes (limite do check:instructions)`,
    ]);
  });
});
