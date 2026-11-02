import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCi } from '../helpers/ci-workflow.ts';
import { repoRoot } from '../helpers/repo-root.ts';
import { runCommand } from '../helpers/run-node.ts';

// AI-53: o job `test` é pulado em PR que só muda os arquivos da lista DOCS_ONLY_PATHS do ci.yml, porque nenhum teste os
// lê. Esta guarda de leitura vale a premissa: um texto entre aspas de um arquivo de código rastreado (.ts, .mjs, .js,
// .cjs), fora de comentário, que cita um caminho da lista, o nome de um desses arquivos ou a pasta `.specs` seria um
// teste (ou um script que o teste roda) que lê o arquivo, e o PR que o muda não poderia pular o `test`. A lista vem do
// ci.yml, e não daqui. Citações que não leem o arquivo ficam em EXCEPTIONS, com o motivo; uma exceção que já não casa
// com nenhuma citação reprova, para a lista não ganhar sobra.

const SELF = 'test/repo/docs-only-paths.test.ts';

// --- leitura dos literais de texto ------------------------------------------------------------------------------

// Depois destas palavras uma barra abre uma expressão regular, e não uma divisão.
const BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'else',
  'do',
  'yield',
  'await',
  'instanceof',
]);

// O texto de cada literal entre aspas simples, duplas ou crases (as partes fixas de uma crase com `${ }`), na ordem do
// arquivo e fora dos comentários `//` e `/* */`. Não é um analisador completo: a barra é uma expressão regular ou uma
// divisão conforme o símbolo anterior, que basta para o código do repositório (a guarda se prova contra os casos
// difíceis nos testes abaixo, e o arquivo real é conferido contra a lista de exceções).
function stringLiterals(source: string): string[] {
  const found: string[] = [];
  // Uma entrada por `${` aberto: as chaves `{` abertas dentro dele que ainda esperam o `}`.
  const open: number[] = [];
  let i = 0;
  let regexAllowed = true;

  // Lê a parte fixa de uma crase, a partir do primeiro caractere depois da crase ou do `}` de uma substituição.
  const readTemplateChunk = (): void => {
    let chunk = '';
    while (i < source.length) {
      const char = source.charAt(i);
      if (char === '\\') {
        chunk += source.slice(i, i + 2);
        i += 2;
      } else if (char === '`') {
        i += 1;
        found.push(chunk);
        regexAllowed = false;
        return;
      } else if (char === '$' && source.charAt(i + 1) === '{') {
        i += 2;
        found.push(chunk);
        open.push(0);
        regexAllowed = true;
        return;
      } else {
        chunk += char;
        i += 1;
      }
    }
    found.push(chunk);
  };

  const readQuoted = (quote: string): void => {
    let text = '';
    i += 1;
    while (i < source.length && source.charAt(i) !== quote) {
      if (source.charAt(i) === '\\') {
        text += source.slice(i, i + 2);
        i += 2;
      } else if (source.charAt(i) === '\n') {
        break;
      } else {
        text += source.charAt(i);
        i += 1;
      }
    }
    i += 1;
    found.push(text);
    regexAllowed = false;
  };

  // Pula uma expressão regular; sem a barra de fechamento na linha, era uma divisão e só avança um caractere.
  const skipRegex = (): void => {
    let at = i + 1;
    let inClass = false;
    while (at < source.length) {
      const char = source.charAt(at);
      if (char === '\n') break;
      if (char === '\\') at += 1;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        at += 1;
        while (/[a-z]/i.test(source.charAt(at))) at += 1;
        i = at;
        regexAllowed = false;
        return;
      }
      at += 1;
    }
    i += 1;
  };

  const skipTo = (end: string, fromAt: number): void => {
    const at = source.indexOf(end, fromAt);
    i = at === -1 ? source.length : at + end.length;
  };

  while (i < source.length) {
    const char = source.charAt(i);
    const next = source.charAt(i + 1);
    if (char === '/' && next === '/') skipTo('\n', i + 2);
    else if (char === '/' && next === '*') skipTo('*/', i + 2);
    else if (char === '#' && i === 0 && next === '!') skipTo('\n', i);
    else if (char === '"' || char === "'") readQuoted(char);
    else if (char === '`') {
      i += 1;
      readTemplateChunk();
    } else if (char === '}' && open.at(-1) === 0) {
      open.pop();
      i += 1;
      readTemplateChunk();
    } else if (char === '/' && regexAllowed) skipRegex();
    else if (/[A-Za-z_$]/.test(char)) {
      const word = /^[\w$]+/.exec(source.slice(i))?.[0] ?? char;
      i += word.length;
      regexAllowed = BEFORE_REGEX.has(word);
    } else if (/[0-9]/.test(char)) {
      i += /^[\w.]+/.exec(source.slice(i))?.[0].length ?? 1;
      regexAllowed = false;
    } else {
      if (char === '{' && open.length > 0)
        open[open.length - 1] = (open.at(-1) ?? 0) + 1;
      if (char === '}' && open.length > 0)
        open[open.length - 1] = (open.at(-1) ?? 1) - 1;
      if (!/\s/.test(char)) regexAllowed = ![')', ']'].includes(char);
      i += 1;
    }
  }
  return found;
}

// --- o que conta como citação ----------------------------------------------------------------------------------

const PATH_TOKEN = /[A-Za-z0-9_.@~*?/-]+/g;

// Os nomes de arquivo da lista (README.md, STATE.md...): o caminho inteiro termina num deles.
function fileNamesOf(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.split('/').at(-1) ?? path))];
}

// As partes de um literal que parecem um caminho e citam o nome de um arquivo da lista ou a pasta `.specs`.
function citationsIn(literal: string, names: string[]): string[] {
  return (literal.match(PATH_TOKEN) ?? [])
    .map((token) => token.replace(/\.+$/, ''))
    .filter(
      (token) =>
        names.some((name) => token.includes(name)) ||
        token.split('/').includes('.specs'),
    );
}

function findCitations(source: string, names: string[]): string[] {
  return [
    ...new Set(
      stringLiterals(source).flatMap((literal) => citationsIn(literal, names)),
    ),
  ].sort();
}

// --- a lista e os arquivos de código -----------------------------------------------------------------------------

// A lista do `env` do topo do ci.yml (um caminho por linha).
function docsOnlyPaths(): string[] {
  const value: unknown = (readCi() as { env?: Record<string, unknown> }).env?.[
    'DOCS_ONLY_PATHS'
  ];
  return typeof value === 'string'
    ? value
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
    : [];
}

// Os arquivos de código rastreados e os novos (ainda não adicionados), fora do node_modules e da própria guarda.
function codeFiles(): string[] {
  const result = runCommand(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split('\n')
    .filter(
      (file) =>
        /\.(?:ts|mjs|js|cjs)$/.test(file) &&
        !file.split('/').includes('node_modules') &&
        file !== SELF &&
        existsSync(join(repoRoot, file)),
    );
}

interface Citation {
  file: string;
  citation: string;
}

function scan(names: string[]): Citation[] {
  return codeFiles().flatMap((file) =>
    findCitations(readFileSync(join(repoRoot, file), 'utf8'), names).map(
      (citation) => ({ file, citation }),
    ),
  );
}

const key = ({ file, citation }: Citation): string => `${file} :: ${citation}`;

// --- as exceções ------------------------------------------------------------------------------------------------

interface Exception {
  file: string;
  citations: string[];
  reason: string;
}

// As citações sem exceção, e as exceções que já não casam com nenhuma citação (a lista não pode ter sobra).
function compare(
  found: Citation[],
  exceptions: Exception[],
): { unexplained: string[]; stale: string[] } {
  const allowed = exceptions.flatMap(({ file, citations }) =>
    citations.map((citation) => key({ file, citation })),
  );
  const seen = found.map(key);
  return {
    unexplained: seen.filter((pair) => !allowed.includes(pair)),
    stale: allowed.filter((pair) => !seen.includes(pair)),
  };
}

// Citações que não leem o arquivo da lista. Cada uma tem o motivo; a conferência exige que todas ainda casem.
const EXCEPTIONS: Exception[] = [
  {
    file: '.claude/hooks/path-guard.mjs',
    citations: ['.specs'],
    reason:
      'prefixo de caminho que a guarda de caminhos nega ao agente; ela compara texto e não lê o arquivo',
  },
  {
    file: '.claude/hooks/path-guard.test.ts',
    citations: [
      '.specs/',
      '.specs/features/casecellshop/spec.md',
      'src/deep/../../.specs/x.md',
    ],
    reason:
      'caminhos entregues como texto à guarda, que decide só pelo prefixo; nada é lido',
  },
  {
    file: '.claude/hooks/subagent-stop.test.ts',
    citations: ['.specs/features/casecellshop/spec.md', 'README.md'],
    reason: 'listas de mudanças falsas que o teste passa ao hook; nada é lido',
  },
  {
    file: 'scripts/check-instructions.test.ts',
    citations: [
      '.specs/',
      '.specs/README.md',
      '.specs/features/casecellshop/spec.md',
      '.specs/project/STATE.md',
    ],
    reason:
      'escreve cópias com esses nomes numa pasta temporária fora do repositório e roda a conferência nela',
  },
  {
    file: 'scripts/criteria-report.test.ts',
    citations: ['.specs'],
    reason: 'o relatório lê só o spec.md, que não está na lista',
  },
  {
    file: 'scripts/criteria-report.ts',
    citations: ['.specs'],
    reason: 'lê só o spec.md, que não está na lista',
  },
  {
    file: 'scripts/generate-telemetry-doc.test.ts',
    citations: ['../../project/STATE.md', 'STATE.md'],
    reason:
      'o texto de um link no cabeçalho esperado do Markdown gerado; nenhum STATE.md é lido',
  },
  {
    file: 'scripts/generate-telemetry-doc.ts',
    citations: [
      '../../project/STATE.md',
      '../.specs/features/casecellshop/telemetry.md',
      'STATE.md',
    ],
    reason:
      'escreve e compara só o telemetry.md, que não está na lista; STATE.md e seu caminho são o texto de um link no cabeçalho do Markdown gerado, e nada é lido',
  },
  {
    file: 'test/repo/ci-jobs.test.ts',
    citations: [
      '*README.md',
      '.specs/',
      '.specs/*',
      '.specs/**',
      '.specs/README.md',
      '.specs/codebase/CONVENTIONS.md',
      '.specs/features/casecellshop/design.md',
      '.specs/features/casecellshop/spec.md',
      '.specs/features/casecellshop/telemetry.md',
      '.specs/project/NOVO.md',
      '.specs/project/PROJECT.md',
      '.specs/project/ROADMAP.md',
      '.specs/project/STATE-ARCHIVE.md',
      '.specs/project/STATE.md',
      'CONVENTIONS.md',
      'README.md',
      'README.md*',
      'README.md.ts',
      'STATE.md',
      'docs/README.md',
    ],
    reason:
      'cria esses arquivos num repositório git temporário e monta o YAML de controle do ci.yml; o teste confere a lista e o comportamento do passo, e não lê nenhum deles do repositório',
  },
  {
    file: 'test/repo/formatter.test.ts',
    citations: ['.specs/features/casecellshop/spec.md', 'README.md'],
    reason:
      'o getFileInfo do Prettier lê só o .prettierignore, e não o arquivo',
  },
  {
    file: 'test/repo/readme-promql.test.ts',
    citations: ['.specs', 'README.md'],
    reason:
      'lê o README.md da raiz e o telemetry.md sob .specs, e nenhum dos dois está na lista; a guarda compara pelo nome, e o .specs/README.md da lista tem o mesmo nome do README.md da raiz',
  },
  {
    file: 'test/repo/rules-paths.test.ts',
    citations: ['.specs/**'],
    reason: 'o glob que a regra docs.md declara no frontmatter; nada é lido',
  },
  {
    file: 'test/repo/suppressions.test.ts',
    citations: ['migrations/README.md'],
    reason: 'outro arquivo (migrations/README.md), que não está na lista',
  },
  {
    file: 'test/repo/telemetry-doc.test.ts',
    citations: ['.specs'],
    reason: 'lê só o telemetry.md sob .specs, que não está na lista',
  },
];

describe('AI-53 a guarda de leitura enxerga o que procura (controle negativo)', () => {
  // Os nomes de arquivo que a guarda real deriva da lista do ci.yml, escritos aqui para os controles inventados.
  const names = [
    'README.md',
    'CONVENTIONS.md',
    'design.md',
    'PROJECT.md',
    'ROADMAP.md',
    'STATE.md',
    'STATE-ARCHIVE.md',
  ];

  it('AI-53 os nomes escritos aqui são os que a guarda real deriva da lista do ci.yml (os controles inventados provam a guarda com nomes que ainda estão nela)', () => {
    expect(fileNamesOf(docsOnlyPaths())).toEqual(names);
  });

  it('AI-53 o README.md da raiz e o spec.md ficam fora da lista, e o .specs/README.md continua nela, de modo que o nome README.md segue sendo vigiado', () => {
    const paths = docsOnlyPaths();

    expect(paths).not.toContain('README.md');
    expect(paths).not.toContain('.specs/features/casecellshop/spec.md');
    expect(paths).toContain('.specs/README.md');
    expect(fileNamesOf(paths)).toContain('README.md');
    expect(findCitations(`read(join(root, 'README.md'))`, names)).toEqual([
      'README.md',
    ]);
  });

  it('AI-53 um teste inventado que lê .specs/project/STATE.md, monta .specs/project/ROADMAP.md com join ou cita README.md é acusado', () => {
    const read = `import { readFileSync } from 'node:fs';
      const state = readFileSync('.specs/project/STATE.md', 'utf8');`;
    const joined = `const roadmap = join('.specs', 'project', 'ROADMAP.md');`;
    const named = `expect(files).toContain('README.md');`;

    expect(findCitations(read, names)).toEqual(['.specs/project/STATE.md']);
    expect(findCitations(joined, names)).toEqual(['.specs', 'ROADMAP.md']);
    expect(findCitations(named, names)).toEqual(['README.md']);
  });

  it('AI-53 aspas duplas e crases, com e sem substituição, também são acusadas', () => {
    expect(findCitations(`read(".specs/project/STATE.md")`, names)).toEqual([
      '.specs/project/STATE.md',
    ]);
    expect(findCitations('read(`docs/CONVENTIONS.md`)', names)).toEqual([
      'docs/CONVENTIONS.md',
    ]);
    expect(findCitations('read(`${dir}/design.md`)', names)).toEqual([
      '/design.md',
    ]);
    expect(
      findCitations('read(`${join("a", "STATE-ARCHIVE.md")}`)', names),
    ).toEqual(['STATE-ARCHIVE.md']);
    expect(findCitations(`read('README.md.ts')`, names)).toEqual([
      'README.md.ts',
    ]);
  });

  it('AI-53 o mesmo texto só num comentário // ou /* */ não é acusado', () => {
    const lineComment = `// lê .specs/project/STATE.md e README.md
      const x = 1; // join('.specs', 'project', 'ROADMAP.md')`;
    const blockComment = `/* o 'README.md' fica
       em .specs/project/STATE.md */ const y = 2;`;

    expect(findCitations(lineComment, names)).toEqual([]);
    expect(findCitations(blockComment, names)).toEqual([]);
  });

  it('AI-53 o texto fora de aspas e um literal que não cita nada não são acusados', () => {
    expect(
      findCitations(`const README = 1; foo(STATE, 'src/app.ts');`, names),
    ).toEqual([]);
    expect(
      findCitations(`const url = 'https://exemplo.com/spec.md';`, names),
    ).toEqual([]);
  });

  it('AI-53 uma aspa dentro de comentário, de expressão regular ou de outra aspa não esconde a citação seguinte', () => {
    const apostrophe = `// não é o 'fim
      const a = 'README.md';`;
    const regex = `const b = /['"]/.test(x) ? 'STATE.md' : 'src';`;
    const other = `const c = "it's"; const d = 'ROADMAP.md';`;
    const division = `const e = total / 2; const f = 'PROJECT.md'; const g = total / 4;`;

    expect(findCitations(apostrophe, names)).toEqual(['README.md']);
    expect(findCitations(regex, names)).toEqual(['STATE.md']);
    expect(findCitations(other, names)).toEqual(['ROADMAP.md']);
    expect(findCitations(division, names)).toEqual(['PROJECT.md']);
  });

  it('AI-53 uma citação sem exceção é acusada, e uma exceção que já não casa com nenhuma citação também reprova', () => {
    const exceptions: Exception[] = [
      { file: 'a.test.ts', citations: ['README.md'], reason: 'não lê' },
    ];

    expect(
      compare([{ file: 'a.test.ts', citation: 'README.md' }], exceptions),
    ).toEqual({ unexplained: [], stale: [] });
    expect(
      compare(
        [
          { file: 'a.test.ts', citation: 'README.md' },
          { file: 'b.test.ts', citation: '.specs/project/STATE.md' },
        ],
        exceptions,
      ),
    ).toEqual({
      unexplained: ['b.test.ts :: .specs/project/STATE.md'],
      stale: [],
    });
    expect(compare([], exceptions)).toEqual({
      unexplained: [],
      stale: ['a.test.ts :: README.md'],
    });
  });

  it('AI-53 uma citação dentro de um ${ } aninhado numa crase é acusada, e a crase depois dele continua lida', () => {
    const nested = 'const a = `x ${f(`.specs/${y}`)} y`; const b = `STATE.md`;';

    expect(findCitations(nested, names)).toEqual(['.specs/', 'STATE.md']);
  });
});

describe('AI-53 nenhum arquivo de código lê os arquivos que o job test deixa de rodar para o PR só de documentação', () => {
  it('AI-53 o ci.yml tem a lista DOCS_ONLY_PATHS no env do topo, e a varredura acha os arquivos de código do repositório', () => {
    expect(docsOnlyPaths().length).toBeGreaterThan(0);
    expect(codeFiles().length).toBeGreaterThan(100);
  });

  it('AI-53 nenhum texto entre aspas de um arquivo de código cita um arquivo da lista, o nome de um deles ou a pasta .specs, fora as exceções', () => {
    const paths = docsOnlyPaths();
    expect(paths.length).toBeGreaterThan(0);

    expect(compare(scan(fileNamesOf(paths)), EXCEPTIONS).unexplained).toEqual(
      [],
    );
  });

  it('AI-53 toda exceção ainda casa com uma citação de verdade (a lista não tem sobra) e tem motivo', () => {
    const paths = docsOnlyPaths();
    expect(paths.length).toBeGreaterThan(0);

    expect(compare(scan(fileNamesOf(paths)), EXCEPTIONS).stale).toEqual([]);
    expect(EXCEPTIONS.filter(({ reason }) => reason.trim() === '')).toEqual([]);
  });
});
