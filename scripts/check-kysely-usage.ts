// AI-19: reprova em src/ as formas do Kysely que deixam o tsc sem enxergar uma
// coluna, ou que montam SQL fora do builder (AD-017). Os testes ficam de fora: os
// controles negativos precisam das formas proibidas. Os tipos gerados também, e a
// lista de colunas vem deles (FND-09).
//
// A leitura é léxica: comentários e o texto de strings e templates saem antes das
// regras, para uma forma citada num comentário não reprovar; o texto fixo de cada
// sql`…` é guardado à parte, sem os valores interpolados.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SourceFile {
  // Caminho relativo à raiz do repositório, como src/erp/sim/index.ts.
  path: string;
  content: string;
}

interface Template {
  tagged: boolean;
  start: number;
  parts: string[];
}

interface Scan {
  // O conteúdo com comentários e textos de string e de template trocados por espaço,
  // nas mesmas posições, para a linha de cada ocorrência continuar certa.
  code: string;
  templates: Template[];
}

type Context = { kind: 'code'; depth: number } | { kind: 'template'; template: Template; partStart: number };

// Um `sql`, com ou sem o tipo genérico, logo antes da crase.
const SQL_TAG = /\bsql\s*(?:<[^`;]*>)?\s*$/;

function scan(content: string): Scan {
  // Por unidade UTF-16, como os índices da string: um emoji não desalinha as posições.
  const chars = content.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  const templates: Template[] = [];
  const stack: Context[] = [{ kind: 'code', depth: 0 }];
  let i = 0;

  while (i < content.length) {
    const top = stack.at(-1) as Context;
    const c = content[i];

    if (top.kind === 'template') {
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        top.template.parts.push(content.slice(top.partStart, i));
        blank(top.partStart, i);
        stack.pop();
        i++;
      } else if (c === '$' && content[i + 1] === '{') {
        top.template.parts.push(content.slice(top.partStart, i));
        blank(top.partStart, i);
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    const next = content[i + 1];
    if (c === '/' && next === '/') {
      const end = content.indexOf('\n', i);
      const stop = end < 0 ? content.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end < 0 ? content.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < content.length && content[j] !== c && content[j] !== '\n') j += content[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '`') {
      const before = chars.slice(Math.max(0, i - 200), i).join('');
      const template: Template = { tagged: SQL_TAG.test(before), start: i, parts: [] };
      templates.push(template);
      stack.push({ kind: 'template', template, partStart: i + 1 });
      i++;
    } else if (c === '{') {
      top.depth++;
      i++;
    } else if (c === '}') {
      // O fecho de um ${…} volta ao texto do template de onde ele saiu.
      if (top.depth === 0 && stack.length > 1) {
        stack.pop();
        const outer = stack.at(-1) as Context;
        if (outer.kind === 'template') outer.partStart = i + 1;
      } else {
        top.depth--;
      }
      i++;
    } else {
      i++;
    }
  }
  return { code: chars.join(''), templates };
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let k = 0; k < offset; k++) if (content[k] === '\n') line++;
  return line;
}

// Depois do `(`: a callback é `function`, `async`, `x =>` ou `(…) =>`.
function startsCallback(code: string, from: number): boolean {
  const rest = code.slice(from).trimStart();
  if (/^(?:async\b|function\b)/.test(rest)) return true;
  if (/^[A-Za-z_$][\w$]*\s*=>/.test(rest)) return true;
  if (!rest.startsWith('(')) return false;
  let depth = 0;
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '(') depth++;
    else if (rest[k] === ')' && --depth === 0) return /^\s*=>/.test(rest.slice(k + 1));
  }
  return false;
}

const FORBIDDEN_ANYWHERE: [RegExp, string][] = [
  [/\bsql\s*\.\s*(?:raw|lit|ref|id|table)\b/g, 'sql.raw, sql.lit, sql.ref, sql.id e sql.table põem texto cru no SQL'],
  [/\.\s*dynamic\b/g, 'o db.dynamic aceita nome de coluna em tempo de execução'],
  [/\bCompiledQuery\s*\.\s*raw\b/g, 'o CompiledQuery.raw executa SQL montado fora do builder'],
  [/\bexecuteQuery\s*\(/g, 'o executeQuery executa SQL montado fora do builder'],
  [/\bgetExecutor\s*\(/g, 'o getExecutor executa SQL montado fora do builder'],
];

// O acesso direto e as transações ficam no invólucro de src/db/ (FND-10).
const FORBIDDEN_OUTSIDE_DB: [RegExp, string][] = [
  [/\.\s*query\s*\(/g, 'o .query() do pg fica só em src/db/'],
  [/\.\s*transaction\s*\(/g, 'a transação abre só pelo runInTransaction de src/db/'],
  [/\bstartTransaction\s*\(/g, 'a transação abre só pelo runInTransaction de src/db/'],
];

const CALLBACK_METHODS = /\.\s*(set|values|doUpdateSet)\s*\(/g;
const WHOLE_COMMAND = /^\s*(?:select|insert|update|delete|with)\b/i;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

function violationsOf(file: SourceFile, columns: ReadonlySet<string>): string[] {
  const { code, templates } = scan(file.content);
  const found: { offset: number; reason: string }[] = [];

  for (const match of code.matchAll(CALLBACK_METHODS)) {
    if (startsCallback(code, match.index + match[0].length)) {
      found.push({
        offset: match.index,
        reason: `${match[1]} com callback deixa passar uma coluna desconhecida no tsc; use a forma de objeto`,
      });
    }
  }
  const rules = file.path.startsWith('src/db/') ? FORBIDDEN_ANYWHERE : [...FORBIDDEN_ANYWHERE, ...FORBIDDEN_OUTSIDE_DB];
  for (const [pattern, reason] of rules) {
    for (const match of code.matchAll(pattern)) found.push({ offset: match.index, reason });
  }
  for (const template of templates) {
    if (!template.tagged) continue;
    if (WHOLE_COMMAND.test(template.parts[0] ?? '')) {
      found.push({ offset: template.start, reason: 'comando inteiro dentro de sql`…`; escreva pelo builder' });
    }
    const cited = new Set<string>();
    for (const part of template.parts) {
      for (const [word] of part.matchAll(IDENTIFIER)) if (columns.has(word)) cited.add(word);
    }
    if (cited.size > 0) {
      found.push({
        offset: template.start,
        reason: `coluna dentro de sql\`…\` (${[...cited].join(', ')}), fora da conferência do tsc; use eb.ref`,
      });
    }
  }

  return found
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, reason }) => `${file.path}:${lineAt(file.content, offset)}: ${reason}`);
}

// As colunas de todas as tabelas dos arquivos gerados em typesDir (FND-09): as
// chaves de cada interface, fora a DB, que lista as tabelas.
export function readGeneratedColumns(typesDir: string): Set<string> {
  const columns = new Set<string>();
  for (const name of readdirSync(typesDir)) {
    if (!name.endsWith('.ts')) continue;
    const content = readFileSync(path.join(typesDir, name), 'utf8');
    for (const [, table, body] of content.matchAll(/export interface (\w+)\s*\{([^}]*)\}/g)) {
      if (table === 'DB' || body === undefined) continue;
      for (const [, , key] of body.matchAll(/^\s*(["']?)(\w+)\1\??\s*:/gm)) if (key) columns.add(key);
    }
  }
  return columns;
}

// Uma frase por ocorrência, com arquivo e linha; vazio quando não há violação.
export function findKyselyViolations(files: readonly SourceFile[], columns: ReadonlySet<string>): string[] {
  return files.filter((file) => !file.path.endsWith('.test.ts')).flatMap((file) => violationsOf(file, columns));
}

// Pelo caminho real: no macOS a pasta temporária é um link (/var → /private/var), e o
// import.meta.url já vem resolvido.
function isMain(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const srcDir = path.join(root, 'src');
  const files: SourceFile[] = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
    .map((relative) => relative.split(path.sep).join('/'))
    .filter((relative) => relative.endsWith('.ts') && !relative.startsWith('db/types/'))
    .map((relative) => ({ path: `src/${relative}`, content: readFileSync(path.join(srcDir, relative), 'utf8') }));
  const violations = findKyselyViolations(files, readGeneratedColumns(path.join(srcDir, 'db', 'types')));
  for (const violation of violations) console.error(violation);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
