import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parser } from '@prometheus-io/lezer-promql';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { repoRoot } from '../helpers/repo-root.ts';

// OBS-03: a seção "Operação" do README traz consultas PromQL (blocos `promql`) e regras de alerta (blocos `yaml` no
// formato de arquivo de regras do Prometheus, com a chave de topo `groups`). Cada consulta é lida pelo analisador
// oficial do PromQL, @prometheus-io/lezer-promql, em modo estrito (`strict: true` lança erro numa consulta inválida em
// vez de recuperar); nada é lido por expressão regular sobre o texto da consulta. A árvore diz o que é nome de métrica
// (`VectorSelector` com `Identifier`), rótulo de seletor (`LabelMatchers`) e valor (`StringLiteral`); os rótulos de
// `by`/`without`/`on`/`ignoring` e os nomes de função ficam em nós que o teste não visita.
//
// O catálogo (telemetry.md, gerado de src/) é o oráculo: a coluna "No Prometheus", o instrumento e, por métrica, a
// tabela de atributos. As funções que leem o README e o catálogo reais são as mesmas dos controles negativos, que
// montam o texto no próprio teste.
//
// Fontes consultadas:
// - Arquivo de regras do Prometheus (groups, rules, alert, expr, for, labels, annotations):
//   https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
// - Âncoras de cabeçalho do GitHub ("Section links"):
//   https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax
//   A âncora tem as letras em minúscula, o espaço vira hífen, qualquer outra pontuação ou espaço em branco sai, o
//   espaço das pontas sai, a marcação (crases, por exemplo) sai, e uma âncora repetida ganha -1, -2... A página não diz
//   o que acontece com `-` e `_`, e o GitHub os mantém (como o github-slugger); os acentos ficam, porque são letras.

const README_NAME = 'README.md';
const README_FILE = join(repoRoot, README_NAME);
const TELEMETRY_FILE = join(
  repoRoot,
  '.specs',
  'features',
  'casecellshop',
  'telemetry.md',
);

// O runbook_url de uma regra: o README deste repositório, na branch main, mais a âncora de um cabeçalho da seção.
const REPO_BLOB =
  'https://github.com/roneyrogerio/casecellshop-backend/blob/main';
const RUNBOOK_BASE = `${REPO_BLOB}/${README_NAME}#`;

const SECTION_TITLE = 'Operação';
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];
const REGEX_OPS = new Set(['EqlRegex', 'NeqRegex']);
// Os metacaracteres de uma expressão regular, menos o `|`, que separa as alternativas.
const REGEX_METACHARS = /[.*+?()[\]{}^$\\]/;
const PROMETHEUS_DURATION = /^(?:\d+(?:ms|s|m|h|d|w|y))+$/;

const strictParser = parser.configure({ strict: true });
type TreeNode = ReturnType<typeof strictParser.parse>['topNode'];

// --- leitura do Markdown ---------------------------------------------------------------------------------------------

interface Heading {
  level: number;
  text: string;
  line: number;
}

interface Fence {
  info: string;
  content: string[];
  line: number;
}

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

// Os cabeçalhos ATX e os blocos de código cercados (``` ou ~~~) do texto, na ordem; um `#` dentro de um bloco de código
// não é cabeçalho. O conteúdo de um bloco perde o recuo da cerca que o abre. Cabeçalho setext (sublinhado) não existe
// no README e não é lido.
function scanMarkdown(text: string): { headings: Heading[]; fences: Fence[] } {
  const headings: Heading[] = [];
  const fences: Fence[] = [];
  let open:
    { char: string; size: number; indent: number; fence: Fence } | undefined;
  for (const [line, content] of text.split('\n').entries()) {
    if (open !== undefined) {
      const close = FENCE_CLOSE.exec(content)?.[1];
      if (close?.startsWith(open.char) && close.length >= open.size) {
        open = undefined;
      } else {
        const lead = /^\s*/.exec(content)?.[0].length ?? 0;
        open.fence.content.push(content.slice(Math.min(open.indent, lead)));
      }
      continue;
    }
    const opening = FENCE_OPEN.exec(content);
    if (opening !== null) {
      const fence: Fence = { info: opening[3] ?? '', content: [], line };
      fences.push(fence);
      open = {
        char: (opening[2] ?? '`').charAt(0),
        size: opening[2]?.length ?? 3,
        indent: opening[1]?.length ?? 0,
        fence,
      };
      continue;
    }
    const heading = ATX_HEADING.exec(content);
    if (heading !== null)
      headings.push({
        level: heading[1]?.length ?? 0,
        text: (heading[2] ?? '').trim(),
        line,
      });
  }
  return { headings, fences };
}

// O texto visível de um cabeçalho: de um link `[texto](url)` fica o texto. Crases e asteriscos saem na regra de
// pontuação da âncora.
function visibleText(markdown: string): string {
  return markdown.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function slugBase(heading: string): string {
  return visibleText(heading)
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
    .replaceAll(' ', '-');
}

// A âncora de cada cabeçalho do documento inteiro, na ordem: a repetida ganha -1, -2... contando todos os cabeçalhos
// do arquivo, e não só os da seção (a mesma conta do github-slugger).
function anchorsOf(headings: Heading[]): string[] {
  const seen = new Map<string, number>();
  return headings.map(({ text }) => {
    const base = slugBase(text);
    let slug = base;
    while (seen.has(slug)) {
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      slug = `${base}-${String(count)}`;
    }
    seen.set(slug, 0);
    return slug;
  });
}

interface Section {
  fences: Fence[];
  anchors: Set<string>;
}

// A seção vai do `## Operação` até o próximo cabeçalho de nível 2 fora de bloco de código; os `###` e `####` ficam
// dentro. Devolve undefined quando o README não tem a seção.
function operationSection(readme: string): Section | undefined {
  const { headings, fences } = scanMarkdown(readme);
  const start = headings.find(
    ({ level, text }) => level === 2 && text.normalize('NFC') === SECTION_TITLE,
  );
  if (start === undefined) return undefined;
  const end =
    headings.find(({ level, line }) => level === 2 && line > start.line)
      ?.line ?? Number.POSITIVE_INFINITY;
  const inside = ({ line }: { line: number }): boolean =>
    line >= start.line && line < end;
  const anchors = anchorsOf(headings);
  return {
    fences: fences.filter(inside),
    anchors: new Set(
      anchors.filter((_, index) => inside(headings[index] ?? start)),
    ),
  };
}

// --- leitura do catálogo ---------------------------------------------------------------------------------------------

interface MetricEntry {
  series: string;
  instrument: string;
  histogram: boolean;
  // Rótulo do Prometheus -> valores da lista fechada, ou undefined quando a lista é aberta.
  attributes: Map<string, string[] | undefined>;
}

type Catalog = Map<string, MetricEntry>;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

// A primeira tabela do trecho: cada linha vira um mapa coluna -> célula.
function readTable(body: string[]): Record<string, string>[] {
  const start = body.findIndex((line) => line.trimStart().startsWith('|'));
  if (start < 0) return [];
  const header = cells(body[start] ?? '');
  const rows: Record<string, string>[] = [];
  for (const line of body.slice(start + 2)) {
    if (!line.trimStart().startsWith('|')) break;
    const values = cells(line);
    rows.push(
      Object.fromEntries(
        header.map((name, index) => [name, values[index] ?? '']),
      ),
    );
  }
  return rows;
}

function column(row: Record<string, string>, name: string): string {
  const value = row[name];
  if (value === undefined)
    throw new Error(`o catálogo não tem a coluna "${name}"`);
  return value;
}

const unticked = (cell: string): string => cell.replace(/^`|`$/g, '');

// Lista fechada: só valores entre crases separados por vírgula. Qualquer outro texto ("template da rota") é lista aberta.
function closedValues(cell: string): string[] | undefined {
  if (!/^`[^`]+`(?:, `[^`]+`)*$/.test(cell)) return undefined;
  return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
}

const prometheusLabel = (attribute: string): string =>
  attribute.replaceAll('.', '_');

function describeMetric(entry: MetricEntry, body: string[]): void {
  if (body.some((line) => line.trim() === 'Sem atributos.')) return;
  const rows = readTable(body);
  if (rows.length === 0)
    throw new Error(
      `a métrica ${entry.series} não tem tabela de atributos nem "Sem atributos."`,
    );
  for (const row of rows)
    entry.attributes.set(
      prometheusLabel(unticked(column(row, 'Atributo'))),
      closedValues(column(row, 'Valores')),
    );
}

// Lê o telemetry.md: a tabela "## Métricas" (Nome, No Prometheus, Instrumento) e, em cada subseção "### `nome OTel`", a
// tabela de atributos ("Atributo" e "Valores") ou "Sem atributos.". Um catálogo malformado lança erro.
function parseCatalog(markdown: string): Catalog {
  const lines = markdown.split('\n');
  const { headings } = scanMarkdown(markdown);
  const bodyOf = (index: number): string[] =>
    lines.slice(
      (headings[index]?.line ?? 0) + 1,
      headings[index + 1]?.line ?? lines.length,
    );
  const metricsAt = headings.findIndex(
    ({ level, text }) => level === 2 && text === 'Métricas',
  );
  if (metricsAt < 0) throw new Error('o catálogo não tem a seção "Métricas"');

  const byOtelName = new Map<string, MetricEntry>();
  const catalog: Catalog = new Map();
  for (const row of readTable(bodyOf(metricsAt))) {
    const series = unticked(column(row, 'No Prometheus'));
    const instrument = column(row, 'Instrumento');
    const entry: MetricEntry = {
      series,
      instrument,
      histogram: instrument === 'histograma',
      attributes: new Map(),
    };
    byOtelName.set(unticked(column(row, 'Nome')), entry);
    catalog.set(series, entry);
  }

  const described = new Set<MetricEntry>();
  for (const [index, heading] of headings.entries()) {
    if (index <= metricsAt) continue;
    if (heading.level <= 2) break;
    const otelName = /^`(.+)`$/.exec(heading.text)?.[1];
    if (heading.level !== 3 || otelName === undefined) continue;
    const entry = byOtelName.get(otelName);
    if (entry === undefined)
      throw new Error(`a subseção ${otelName} não está na tabela de métricas`);
    describeMetric(entry, bodyOf(index));
    described.add(entry);
  }
  for (const entry of catalog.values())
    if (!described.has(entry))
      throw new Error(
        `a métrica ${entry.series} não tem subseção de atributos`,
      );
  return catalog;
}

// --- conferência de uma consulta -------------------------------------------------------------------------------------

type Resolution =
  { series: string; entry: MetricEntry; suffix: string } | { problem: string };

// O nome de uma série na coluna "No Prometheus", com _bucket/_sum/_count só para histograma. A série de um histograma
// só existe com um dos sufixos; o nome sem sufixo não tem dado no /metrics.
function resolveMetric(name: string, catalog: Catalog): Resolution {
  const direct = catalog.get(name);
  if (direct !== undefined)
    return direct.histogram
      ? {
          problem: `${name} é um histograma: a série existe só com ${HISTOGRAM_SUFFIXES.join(', ')}`,
        }
      : { series: name, entry: direct, suffix: '' };
  for (const suffix of HISTOGRAM_SUFFIXES) {
    const base = name.endsWith(suffix)
      ? catalog.get(name.slice(0, -suffix.length))
      : undefined;
    if (base === undefined) continue;
    return base.histogram
      ? { series: name, entry: base, suffix }
      : {
          problem: `o sufixo ${suffix} só vale em histograma, e ${base.series} é ${base.instrument}`,
        };
  }
  return {
    problem: `${name} não está na coluna "No Prometheus" do catálogo`,
  };
}

// O texto de um literal do PromQL, sem as aspas. Aspas duplas e simples aceitam \\, \" e \'; qualquer outro escape fica
// com a barra, que o valor não terá na lista. Crase é texto cru. Um literal sem a aspa final (a gramática o aceita) é ilegível.
function decodeString(literal: string): string | undefined {
  const quote = literal.charAt(0);
  if (literal.length < 2 || !literal.endsWith(quote)) return undefined;
  const body = literal.slice(1, -1);
  return quote === '`' ? body : body.replace(/\\(["'\\])/g, '$1');
}

function textOf(node: TreeNode | null, source: string): string | undefined {
  return node === null ? undefined : source.slice(node.from, node.to);
}

function labelOf(matcher: TreeNode, source: string): string | undefined {
  const plain = textOf(matcher.getChild('LabelName'), source);
  if (plain !== undefined) return plain;
  const quoted = textOf(matcher.getChild('QuotedLabelName'), source);
  return quoted === undefined ? undefined : decodeString(quoted);
}

function labelProblem(
  resolved: { series: string; entry: MetricEntry; suffix: string },
  label: string,
  op: string,
  value: string,
): string | undefined {
  if (label === 'le')
    return resolved.suffix === '_bucket'
      ? undefined
      : `o rótulo le só existe em _bucket, e a série é ${resolved.series}`;
  const { attributes } = resolved.entry;
  if (!attributes.has(label))
    return `o rótulo ${label} não é atributo de ${resolved.series} (atributos: ${[...attributes.keys()].join(', ') || 'nenhum'})`;
  const allowed = attributes.get(label);
  if (allowed === undefined) return undefined;
  const regex = REGEX_OPS.has(op);
  for (const alternative of regex ? value.split('|') : [value]) {
    if (regex && REGEX_METACHARS.test(alternative))
      return `o valor "${value}" de ${label} tem metacaractere de regex (só alternativas literais separadas por |)`;
    if (!allowed.includes(alternative))
      return `o valor "${alternative}" não está na lista fechada de ${label} (${allowed.join(', ')})`;
  }
  return undefined;
}

function matcherProblem(
  matcher: TreeNode,
  source: string,
  resolved: { series: string; entry: MetricEntry; suffix: string },
): string | undefined {
  if (matcher.name === 'QuotedLabelName')
    return 'nome de métrica entre aspas dentro das chaves não é aceito';
  const label = labelOf(matcher, source);
  const op = matcher.getChild('MatchOp')?.firstChild?.name;
  const literal = textOf(matcher.getChild('StringLiteral'), source);
  const value = literal === undefined ? undefined : decodeString(literal);
  if (label === undefined || op === undefined || value === undefined)
    return `comparação ilegível: ${source.slice(matcher.from, matcher.to)}`;
  return labelProblem(resolved, label, op, value);
}

function selectorProblems(
  node: TreeNode,
  source: string,
  catalog: Catalog,
): string[] {
  const selector = source.slice(node.from, node.to);
  const name = textOf(node.getChild('Identifier'), source);
  if (name === undefined) return [`seletor ${selector}: sem nome de métrica`];
  const resolved = resolveMetric(name, catalog);
  if ('problem' in resolved)
    return [`seletor ${selector}: ${resolved.problem}`];
  const problems: string[] = [];
  let matcher = node.getChild('LabelMatchers')?.firstChild ?? null;
  for (; matcher !== null; matcher = matcher.nextSibling) {
    const problem = matcherProblem(matcher, source, resolved);
    if (problem !== undefined) problems.push(`seletor ${selector}: ${problem}`);
  }
  return problems;
}

// Os problemas de uma consulta; vazio quando ela é válida e todo seletor bate com o catálogo.
function queryProblems(query: string, catalog: Catalog): string[] {
  let tree;
  try {
    tree = strictParser.parse(query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido';
    return [`consulta inválida para o analisador do PromQL (${reason})`];
  }
  const problems: string[] = [];
  tree.iterate({
    enter(ref) {
      if (ref.name === 'VectorSelector')
        problems.push(...selectorProblems(ref.node, query, catalog));
    },
  });
  return problems;
}

// --- conferência da seção do README ----------------------------------------------------------------------------------

interface Report {
  problems: string[];
  queries: number;
  rules: number;
}

const oneLine = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, 140);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function filled(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// As consultas de um bloco promql: separadas por uma ou mais linhas em branco; um trecho só de comentários não conta.
function promqlQueries(content: string[]): string[] {
  const chunks: string[][] = [[]];
  for (const line of content) {
    if (line.trim() === '') chunks.push([]);
    else chunks.at(-1)?.push(line);
  }
  return chunks
    .filter((chunk) => chunk.some((line) => !line.trim().startsWith('#')))
    .map((chunk) => chunk.join('\n'));
}

function runbookProblem(
  url: unknown,
  anchors: Set<string>,
): string | undefined {
  const text = filled(url);
  if (text === undefined) return 'falta annotations.runbook_url';
  if (!text.startsWith(RUNBOOK_BASE))
    return `runbook_url ${text} não aponta para o README.md deste repositório (esperado ${RUNBOOK_BASE}<âncora>)`;
  let anchor = text.slice(RUNBOOK_BASE.length);
  try {
    anchor = decodeURIComponent(anchor);
  } catch {
    return `runbook_url ${text} tem uma âncora com % inválido`;
  }
  return anchors.has(anchor.normalize('NFC'))
    ? undefined
    : `runbook_url ${text}: a âncora ${anchor} não é de um cabeçalho da seção (âncoras: ${[...anchors].join(', ')})`;
}

// Os problemas de uma regra do arquivo de regras do Prometheus.
function ruleProblems(
  rule: unknown,
  label: string,
  section: Section,
  catalog: Catalog,
): string[] {
  const problems: string[] = [];
  if (filled(field(rule, 'alert')) === undefined)
    problems.push('falta o campo alert');
  const expr = field(rule, 'expr');
  if (typeof expr !== 'string' || expr.trim() === '')
    problems.push('falta o campo expr');
  else problems.push(...queryProblems(expr, catalog));
  const duration = field(rule, 'for');
  if (filled(duration) === undefined) problems.push('falta o campo for');
  else if (!PROMETHEUS_DURATION.test(String(duration)))
    problems.push(`o for ${String(duration)} não é uma duração do Prometheus`);
  if (filled(field(field(rule, 'labels'), 'severity')) === undefined)
    problems.push('falta labels.severity');
  const annotations = field(rule, 'annotations');
  if (filled(field(annotations, 'summary')) === undefined)
    problems.push('falta annotations.summary');
  const runbook = runbookProblem(
    field(annotations, 'runbook_url'),
    section.anchors,
  );
  if (runbook !== undefined) problems.push(runbook);
  return problems.map((problem) => `${label}: ${problem}`);
}

function ruleFileProblems(
  doc: Record<string, unknown>,
  where: string,
  section: Section,
  catalog: Catalog,
  report: Report,
): void {
  const groups = doc['groups'];
  if (!Array.isArray(groups)) {
    report.problems.push(`${where}: groups não é uma lista`);
    return;
  }
  for (const [groupIndex, group] of groups.entries()) {
    const name = filled(field(group, 'name'));
    const groupLabel = `${where}, grupo ${name ?? String(groupIndex + 1)}`;
    if (name === undefined)
      report.problems.push(`${groupLabel}: falta o campo name`);
    const rules: unknown = field(group, 'rules');
    if (!Array.isArray(rules)) {
      report.problems.push(`${groupLabel}: rules não é uma lista`);
      continue;
    }
    for (const [ruleIndex, rule] of rules.entries()) {
      report.rules += 1;
      const alert = filled(field(rule, 'alert'));
      const label = `${groupLabel}, ${alert === undefined ? `regra ${String(ruleIndex + 1)}` : `alerta ${alert}`}`;
      report.problems.push(...ruleProblems(rule, label, section, catalog));
    }
  }
}

function yamlBlockProblems(
  fence: Fence,
  section: Section,
  catalog: Catalog,
  report: Report,
): void {
  const where = `bloco yaml da linha ${String(fence.line + 1)}`;
  let doc: unknown;
  try {
    doc = parseYaml(fence.content.join('\n'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'erro desconhecido';
    report.problems.push(`${where}: não é YAML válido (${reason})`);
    return;
  }
  // Sem a chave de topo `groups` o bloco não é um arquivo de regras (a configuração do Agent do Datadog, por exemplo).
  if (isRecord(doc) && Object.hasOwn(doc, 'groups'))
    ruleFileProblems(doc, where, section, catalog, report);
}

function checkOperation(readme: string, catalog: Catalog): Report {
  const report: Report = { problems: [], queries: 0, rules: 0 };
  const section = operationSection(readme);
  if (section === undefined) {
    report.problems.push(
      `o README não tem a seção "${SECTION_TITLE}" (cabeçalho de nível 2)`,
    );
    return report;
  }
  for (const fence of section.fences) {
    if (fence.info === 'promql')
      for (const query of promqlQueries(fence.content)) {
        report.queries += 1;
        const where = `consulta (bloco promql da linha ${String(fence.line + 1)}) ${oneLine(query)}`;
        report.problems.push(
          ...queryProblems(query, catalog).map(
            (problem) => `${where}: ${problem}`,
          ),
        );
      }
    else if (fence.info === 'yaml')
      yamlBlockProblems(fence, section, catalog, report);
  }
  if (report.queries === 0)
    report.problems.push(
      `a seção "${SECTION_TITLE}" não tem nenhuma consulta nos blocos promql`,
    );
  if (report.rules === 0)
    report.problems.push(
      `a seção "${SECTION_TITLE}" não tem nenhuma regra de alerta nos blocos yaml`,
    );
  return report;
}

// --- textos montados para os controles -------------------------------------------------------------------------------

const FENCE = '`'.repeat(3);

function fenced(info: string, ...lines: string[]): string {
  return [`${FENCE}${info}`, ...lines, FENCE, ''].join('\n');
}

const CATALOG_TEXT = [
  '# Catálogo de telemetria',
  '',
  '## Métricas',
  '',
  '| Nome | No Prometheus | Instrumento | Unidade | Descrição |',
  '| --- | --- | --- | --- | --- |',
  '| `app.requests` | `app_requests_total` | contador | `{request}` | Pedidos. |',
  '| `app.duration` | `app_duration` | histograma | `s` | Duração. |',
  '| `app.active` | `app_active` | UpDownCounter | `{operation}` | Em andamento. |',
  '',
  '### `app.requests`',
  '',
  '| Atributo | Exigência | Valores | Descrição |',
  '| --- | --- | --- | --- |',
  '| `app.outcome` | obrigatório | `ok`, `fail` | Desfecho. |',
  '',
  '### `app.duration`',
  '',
  'Fronteiras: 1, 5',
  '',
  '| Atributo | Exigência | Valores | Descrição |',
  '| --- | --- | --- | --- |',
  '| `app.operation` | obrigatório | `read`, `write` | Operação. |',
  '| `http.route` | condicional | template da rota | Rota. |',
  '',
  '### `app.active`',
  '',
  'Sem atributos.',
  '',
  '## Eventos de log',
  '',
  '| Nome | Níveis | Campos | Descrição |',
  '| --- | --- | --- | --- |',
  '| `app.started` | `info` | — | Começou. |',
  '',
].join('\n');

const CATALOG = parseCatalog(CATALOG_TEXT);

type RuleField = 'alert' | 'expr' | 'for' | 'severity' | 'summary' | 'runbook';

const RUNBOOK_OK = `${RUNBOOK_BASE}erp-falhando-ou-com-erro-de-configuração`;

const RULE_DEFAULTS: Record<RuleField, string | null> = {
  alert: 'ErroAlto',
  expr: 'sum(rate(app_requests_total{app_outcome="fail"}[5m])) > 0',
  for: '5m',
  severity: 'page',
  summary: 'Erros demais',
  runbook: RUNBOOK_OK,
};

const yamlLine = (
  indent: number,
  key: string,
  value: string | null,
): string[] =>
  value === null
    ? []
    : [`${' '.repeat(indent)}${key}: ${JSON.stringify(value)}`];

// Um arquivo de regras com uma regra; `null` tira o campo.
function ruleFile(
  overrides: Partial<Record<RuleField, string | null>> = {},
): string {
  const f = { ...RULE_DEFAULTS, ...overrides };
  const ruleLines = [
    ...yamlLine(8, 'alert', f.alert),
    ...yamlLine(8, 'expr', f.expr),
    ...yamlLine(8, 'for', f.for),
    ...(f.severity === null
      ? []
      : ['        labels:', ...yamlLine(10, 'severity', f.severity)]),
    ...(f.summary === null && f.runbook === null
      ? []
      : [
          '        annotations:',
          ...yamlLine(10, 'summary', f.summary),
          ...yamlLine(10, 'runbook_url', f.runbook),
        ]),
  ];
  const first = ruleLines[0]?.trimStart() ?? '';
  return [
    'groups:',
    '  - name: grupo',
    '    rules:',
    `      - ${first}`,
    ...ruleLines.slice(1),
  ].join('\n');
}

const HEADING_ERP = '#### ERP falhando ou com erro de configuração';
// O destino do RUNBOOK_OK: a seção precisa ter o cabeçalho para a regra padrão apontar para algo.
const ERP_SECTION = [HEADING_ERP, '', 'Texto do runbook.', ''].join('\n');

const GOOD_QUERIES = [
  '# disponibilidade',
  'sum(rate(app_requests_total{app_outcome=~"ok|fail"}[5m])) by (app_outcome)',
  '',
  'histogram_quantile(0.99, sum by (le, app_operation) (rate(app_duration_bucket{http_route="/orders/{orderId}/status", app_operation!="read"}[5m])))',
];

// Um README com a seção "Operação" no meio; `before` e `after` ficam fora dela.
function readmeWith(body: string, before = '', after = ''): string {
  return [
    '# Projeto',
    '',
    '## Visão',
    '',
    before,
    '## Operação',
    '',
    body,
    '## Limitações',
    '',
    after,
  ].join('\n');
}

function goodBody(rule: string = ruleFile()): string {
  return [
    '### Dashboard',
    '',
    fenced('promql', ...GOOD_QUERIES),
    '### Alertas',
    '',
    fenced('yaml', ...rule.split('\n')),
    HEADING_ERP,
    '',
    'Texto do runbook.',
    '',
    fenced(
      'yaml',
      'init_config:',
      'instances:',
      '  - openmetrics_endpoint: http://x',
    ),
  ].join('\n');
}

const GOOD_README = readmeWith(goodBody());

const check = (readme: string, catalog: Catalog = CATALOG): Report =>
  checkOperation(readme, catalog);

// --- os testes -------------------------------------------------------------------------------------------------------

describe('OBS-03 as consultas e as regras da seção Operação do README batem com o catálogo de telemetria', () => {
  it('OBS-03 o README real: toda consulta e toda regra da seção Operação é válida e bate com o telemetry.md', () => {
    const report = checkOperation(
      readFileSync(README_FILE, 'utf8'),
      parseCatalog(readFileSync(TELEMETRY_FILE, 'utf8')),
    );

    expect(report.problems).toEqual([]);
  });
});

describe('OBS-03 o leitor do catálogo (controles)', () => {
  it('OBS-03 o telemetry.md real é lido: nomes, instrumentos, listas fechadas e abertas, sem atributos', () => {
    const catalog = parseCatalog(readFileSync(TELEMETRY_FILE, 'utf8'));
    const duration = catalog.get('http_server_request_duration');
    const checkout = catalog.get('casecellshop_checkout_requests_total');

    expect(duration?.histogram).toBe(true);
    expect(duration?.attributes.get('http_request_method')).toContain('_OTHER');
    expect(duration?.attributes.has('http_route')).toBe(true);
    expect(duration?.attributes.get('http_route')).toBeUndefined();
    expect(checkout?.histogram).toBe(false);
    expect(checkout?.attributes.get('casecellshop_checkout_outcome')).toEqual([
      'accepted',
      'replay',
      'out_of_stock',
      'price_changed',
      'invalid',
      'unavailable',
    ]);
    expect(
      catalog.get('casecellshop_erp_client_active_operations')?.instrument,
    ).toBe('UpDownCounter');
    expect(
      catalog.get('casecellshop_erp_client_active_operations')?.attributes.size,
    ).toBe(0);
  });

  it('OBS-03 o catálogo montado no teste é lido: o ponto do atributo OTel vira _ e a lista aberta fica sem valores', () => {
    expect([...CATALOG.keys()]).toEqual([
      'app_requests_total',
      'app_duration',
      'app_active',
    ]);
    expect(
      CATALOG.get('app_duration')?.attributes.get('app_operation'),
    ).toEqual(['read', 'write']);
    expect(
      CATALOG.get('app_duration')?.attributes.get('http_route'),
    ).toBeUndefined();
  });

  it('OBS-03 um catálogo com uma métrica sem subseção, ou com subseção sem tabela, reprova na leitura', () => {
    const withoutSection = CATALOG_TEXT.replace(
      '### `app.active`\n\nSem atributos.\n',
      '',
    );
    const withoutTable = CATALOG_TEXT.replace('Sem atributos.', 'Nada.');

    expect(() => parseCatalog(withoutSection)).toThrow('app_active');
    expect(() => parseCatalog(withoutTable)).toThrow('app_active');
    expect(() => parseCatalog('# vazio\n')).toThrow('Métricas');
  });
});

describe('OBS-03 a conferência de uma consulta (controles)', () => {
  const VALID: [string, string][] = [
    [
      'contador com rótulo de lista fechada',
      'rate(app_requests_total{app_outcome="ok"}[5m])',
    ],
    [
      'alternativas literais com =~',
      'app_requests_total{app_outcome=~"ok|fail"}',
    ],
    [
      '!~ com alternativas da lista',
      'app_requests_total{app_outcome!~"fail|ok"}',
    ],
    ['!= com valor da lista', 'app_requests_total{app_outcome!="ok"}'],
    [
      'rótulo entre aspas com valor da lista',
      'app_requests_total{"app_outcome"="ok"}',
    ],
    ['valor entre crases', 'app_requests_total{app_outcome=`ok`}'],
    [
      'valor com chave entre aspas (lista aberta)',
      'rate(app_duration_bucket{http_route="/orders/{orderId}/status"}[5m])',
    ],
    ['regex em lista aberta', 'app_duration_count{http_route=~"/orders/.*"}'],
    ['le em _bucket', 'app_duration_bucket{le="1", app_operation="read"}'],
    ['_sum e _count de histograma', 'app_duration_sum / app_duration_count'],
    ['UpDownCounter sem atributos', 'app_active'],
    [
      'rótulos de by e without, e on',
      'sum by (le, instance, "job") (rate(app_duration_bucket[5m])) / on (instance) group_left sum without (pod) (app_active)',
    ],
    [
      'nomes de função e de agregação',
      'histogram_quantile(0.99, sum(rate(app_duration_bucket[5m])) by (le))',
    ],
    ['comentário no fim e no começo', '# nota\napp_active # fim'],
    ['offset, subconsulta e @', 'max_over_time(app_active[1h:1m] offset 5m)'],
  ];

  it.each(VALID)('OBS-03 consulta válida passa: %s', (_label, query) => {
    expect(queryProblems(query, CATALOG)).toEqual([]);
  });

  const INVALID: [string, string, string][] = [
    [
      'parêntese aberto',
      'sum(rate(app_requests_total[5m])',
      'consulta inválida',
    ],
    ['duas expressões seguidas', 'app_active app_active', 'consulta inválida'],
    ['vazia', '', 'consulta inválida'],
    [
      'chave sem fechar',
      'app_requests_total{app_outcome="ok"',
      'consulta inválida',
    ],
    [
      'nome desconhecido',
      'rate(app_requets_total[5m])',
      'app_requets_total não está na coluna',
    ],
    [
      'erro de digitação no prefixo',
      'apps_requests_total',
      'apps_requests_total não está na coluna',
    ],
    ['contador sem _total', 'app_requests', 'app_requests não está na coluna'],
    [
      'sufixo _bucket num contador',
      'app_requests_total_bucket',
      'o sufixo _bucket só vale em histograma',
    ],
    [
      'sufixo _count num contador',
      'app_requests_total_count',
      'o sufixo _count só vale em histograma',
    ],
    [
      'sufixo _sum num UpDownCounter',
      'app_active_sum',
      'o sufixo _sum só vale em histograma',
    ],
    ['histograma sem sufixo', 'app_duration', 'app_duration é um histograma'],
    [
      'sufixo inventado num histograma',
      'app_duration_total',
      'app_duration_total não está na coluna',
    ],
    ['seletor sem nome', '{app_outcome="ok"}', 'sem nome de métrica'],
    [
      'seletor com __name__',
      '{__name__="app_requests_total"}',
      'sem nome de métrica',
    ],
    [
      'rótulo de outra métrica',
      'app_requests_total{app_operation="read"}',
      'o rótulo app_operation não é atributo de app_requests_total',
    ],
    [
      'rótulo inexistente',
      'app_active{instance="x"}',
      'o rótulo instance não é atributo de app_active',
    ],
    [
      'rótulo entre aspas de outra métrica',
      'app_requests_total{"app_operation"="read"}',
      'o rótulo app_operation não é atributo',
    ],
    [
      'le fora de _bucket (_sum)',
      'app_duration_sum{le="1"}',
      'o rótulo le só existe em _bucket',
    ],
    [
      'le num contador',
      'app_requests_total{le="1"}',
      'o rótulo le só existe em _bucket',
    ],
    [
      'valor fora da lista com =',
      'app_requests_total{app_outcome="boom"}',
      'o valor "boom" não está na lista fechada de app_outcome',
    ],
    [
      'valor fora da lista com !=',
      'app_requests_total{app_outcome!="boom"}',
      'o valor "boom" não está na lista fechada',
    ],
    [
      'valor fora da lista numa alternativa de =~',
      'app_requests_total{app_outcome=~"ok|boom"}',
      'o valor "boom" não está na lista fechada',
    ],
    [
      'valor fora da lista numa alternativa de !~',
      'app_requests_total{app_outcome!~"boom|fail"}',
      'o valor "boom" não está na lista fechada',
    ],
    [
      'valor entre aspas simples fora da lista',
      "app_requests_total{app_outcome='boom'}",
      'o valor "boom" não está na lista fechada',
    ],
    [
      'valor do rótulo entre aspas fora da lista',
      'app_requests_total{"app_outcome"="boom"}',
      'o valor "boom" não está na lista fechada',
    ],
    [
      'alternativa vazia',
      'app_requests_total{app_outcome=~"ok|"}',
      'o valor "" não está na lista fechada',
    ],
    [
      'valor vazio com =',
      'app_requests_total{app_outcome=""}',
      'o valor "" não está na lista fechada',
    ],
    [
      '| num valor de =',
      'app_requests_total{app_outcome="ok|fail"}',
      'o valor "ok|fail" não está na lista fechada',
    ],
    [
      'metacaractere .* numa alternativa',
      'app_requests_total{app_outcome=~"ok|f.*"}',
      'metacaractere de regex',
    ],
    [
      'regex .+ sozinha',
      'app_requests_total{app_outcome=~".+"}',
      'metacaractere de regex',
    ],
    [
      'grupo de regex',
      'app_requests_total{app_outcome=~"(ok|fail)"}',
      'metacaractere de regex',
    ],
    [
      'classe de regex com !~',
      'app_requests_total{app_outcome!~"[a-z]+"}',
      'metacaractere de regex',
    ],
    [
      'barra invertida',
      'app_requests_total{app_outcome=~"o\\\\k"}',
      'metacaractere de regex',
    ],
    [
      'nome entre aspas dentro das chaves',
      'app_requests_total{"app_outcome"}',
      'nome de métrica entre aspas',
    ],
  ];

  it.each(INVALID)(
    'OBS-03 consulta reprova com a mensagem certa: %s',
    (_label, query, fragment) => {
      const problems = queryProblems(query, CATALOG);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(fragment);
    },
  );

  it('OBS-03 cada seletor de uma consulta é conferido, e a mensagem diz qual', () => {
    const problems = queryProblems(
      'sum(rate(app_requets_total[5m])) / sum(rate(app_requests_total{app_outcome="boom"}[5m]))',
      CATALOG,
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('seletor app_requets_total');
    expect(problems[1]).toContain(
      'seletor app_requests_total{app_outcome="boom"}',
    );
  });

  it('OBS-03 os rótulos de by/without e os nomes de função não são tratados como métrica nem como rótulo de seletor', () => {
    const query =
      'sum without (nao_e_atributo) (rate(app_requests_total[5m])) / on (tambem_nao) group_left (outro) sum by (le, nada) (app_requests_total)';

    expect(queryProblems(query, CATALOG)).toEqual([]);
  });

  it('OBS-03 o valor com chave entre aspas é lido inteiro: a chave de /orders/{orderId}/status não fecha o seletor', () => {
    const ok =
      'app_duration_bucket{http_route="/orders/{orderId}/status", app_operation="read"}';
    const bad =
      'app_duration_bucket{http_route="/orders/{orderId}/status", app_operation="boom"}';

    expect(queryProblems(ok, CATALOG)).toEqual([]);
    expect(queryProblems(bad, CATALOG)).toHaveLength(1);
    expect(queryProblems(bad, CATALOG)[0]).toContain('"boom"');
  });

  it('OBS-03 as consultas do catálogo real: um nome com erro de digitação no prefixo e um valor fora da lista reprovam, os certos passam', () => {
    const catalog = parseCatalog(readFileSync(TELEMETRY_FILE, 'utf8'));
    const real = (query: string): string[] => queryProblems(query, catalog);

    expect(
      real(
        'sum(rate(casecellshop_checkout_requests_total{casecellshop_checkout_outcome="accepted"}[5m]))',
      ),
    ).toEqual([]);
    expect(
      real(
        'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_bucket{http_route="/orders/{orderId}/status"}[5m])))',
      ),
    ).toEqual([]);
    expect(real('rate(casecellshp_checkout_requests_total[5m])')).toHaveLength(
      1,
    );
    expect(
      real(
        'casecellshop_checkout_requests_total{casecellshop_checkout_outcome="rejected"}',
      ),
    ).toHaveLength(1);
    expect(
      real(
        'casecellshop_erp_client_operation_duration_bucket{casecellshop_erp_outcome="timeout"}',
      ),
    ).toHaveLength(1);
  });
});

describe('OBS-03 a leitura das âncoras dos cabeçalhos (controles)', () => {
  const anchorsOfText = (text: string): string[] =>
    anchorsOf(scanMarkdown(text).headings);

  it.each([
    ['## Operação', 'operação'],
    [
      '#### ERP falhando ou com erro de configuração',
      'erp-falhando-ou-com-erro-de-configuração',
    ],
    [
      '#### Burn rate da vitrine ou do checkout',
      'burn-rate-da-vitrine-ou-do-checkout',
    ],
    ['### Comando `redrive` e `cancel`', 'comando-redrive-e-cancel'],
    ['### Pré-requisitos (M5)', 'pré-requisitos-m5'],
    ['### ERP & fila: o que fazer?', 'erp--fila-o-que-fazer'],
    ['### [Veja](http://x) o texto', 'veja-o-texto'],
    ['### **Negrito** e _itálico_', 'negrito-e-_itálico_'],
    ['###    Espaços   nas pontas   ', 'espaços---nas-pontas'],
    ['## Título fechado ##', 'título-fechado'],
  ])('OBS-03 a âncora do cabeçalho %s é %s', (heading, anchor) => {
    expect(anchorsOfText(heading)).toEqual([anchor]);
  });

  it('OBS-03 o cabeçalho repetido ganha -1, -2... contando o documento inteiro', () => {
    const text = [
      '## Alertas',
      '',
      '### Alertas',
      '',
      '### Alertas',
      '',
      '### Outro',
    ].join('\n');

    expect(anchorsOfText(text)).toEqual([
      'alertas',
      'alertas-1',
      'alertas-2',
      'outro',
    ]);
  });

  it('OBS-03 um # dentro de bloco de código não é cabeçalho e não toma âncora', () => {
    const text = [
      '## Alertas',
      '',
      fenced('bash', '# Alertas', '## Falso'),
      '### Alertas',
    ].join('\n');

    expect(anchorsOfText(text)).toEqual(['alertas', 'alertas-1']);
  });

  it('OBS-03 a seção vai do cabeçalho Operação até o próximo de nível 2 fora de bloco de código, com os níveis 3 e 4 dentro', () => {
    const readme = readmeWith(
      [
        '### Dentro',
        '',
        fenced('bash', '## Não termina a seção', 'echo oi'),
        '#### Mais fundo',
        '',
        fenced('promql', 'app_requets_total'),
      ].join('\n'),
      '',
      fenced('promql', 'outra_coisa_invalida'),
    );
    const section = operationSection(readme);

    expect(section?.anchors).toEqual(
      new Set(['operação', 'dentro', 'mais-fundo']),
    );
    expect(section?.fences.map((fence) => fence.info)).toEqual([
      'bash',
      'promql',
    ]);
  });
});

describe('OBS-03 a conferência da seção Operação (controles)', () => {
  it('OBS-03 um README montado, correto, passa e conta as consultas e a regra que leu', () => {
    const report = check(GOOD_README);

    expect(report.problems).toEqual([]);
    expect(report.queries).toBe(2);
    expect(report.rules).toBe(1);
  });

  it('OBS-03 bloco yaml sem a chave groups é ignorado, mesmo com campos que seriam inválidos como regra', () => {
    const body =
      goodBody() +
      '\n' +
      fenced('yaml', 'instances:', '  - expr: "{{{"', '    alert: ""');
    const report = check(readmeWith(body));

    expect(report.problems).toEqual([]);
    expect(report.rules).toBe(1);
  });

  it('OBS-03 bloco promql fora da seção é ignorado, antes e depois dela', () => {
    const outside = fenced('promql', 'app_requets_total', '', 'foo bar');
    const report = check(readmeWith(goodBody(), outside, outside));

    expect(report.problems).toEqual([]);
    expect(report.queries).toBe(2);
  });

  it('OBS-03 bloco promql de outra linguagem na seção (bash) não é lido como consulta', () => {
    const report = check(
      readmeWith(goodBody() + '\n' + fenced('bash', 'foo bar')),
    );

    expect(report.problems).toEqual([]);
  });

  it('OBS-03 um trecho só de comentários num bloco promql é ignorado, e as consultas separadas por linha em branco são lidas uma a uma', () => {
    const body = [
      fenced(
        'promql',
        '# só comentário',
        '# outro',
        '',
        'app_active',
        '',
        '# comentário',
        'app_requets_total',
      ),
      fenced('yaml', ...ruleFile().split('\n')),
      ERP_SECTION,
    ].join('\n');
    const report = check(readmeWith(body));

    expect(report.queries).toBe(2);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('app_requets_total');
  });

  it('OBS-03 uma consulta inválida e uma regra inválida são listadas, cada uma com a consulta ou o alerta onde aparece', () => {
    const body = [
      fenced(
        'promql',
        'app_active',
        '',
        'sum(rate(app_requets_total[5m]))',
        '',
        'foo bar',
      ),
      fenced(
        'yaml',
        ...ruleFile({ alert: 'AlertaRuim', for: null }).split('\n'),
      ),
      ERP_SECTION,
    ].join('\n');
    const { problems } = check(readmeWith(body));

    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('sum(rate(app_requets_total[5m]))');
    expect(problems[0]).toContain('app_requets_total não está na coluna');
    expect(problems[1]).toContain('foo bar');
    expect(problems[1]).toContain('consulta inválida');
    expect(problems[2]).toContain('alerta AlertaRuim');
    expect(problems[2]).toContain('falta o campo for');
  });

  it('OBS-03 uma seção sem nenhuma consulta promql reprova', () => {
    const report = check(
      readmeWith(
        fenced('yaml', ...ruleFile().split('\n')) + '\n' + ERP_SECTION,
      ),
    );

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('não tem nenhuma consulta');
  });

  it('OBS-03 uma seção sem nenhuma regra de alerta reprova', () => {
    const report = check(readmeWith(fenced('promql', 'app_active')));

    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain('não tem nenhuma regra');
  });

  it('OBS-03 uma seção só com comentários no promql e só com um yaml sem groups reprova nos dois', () => {
    const body = fenced('promql', '# nada') + fenced('yaml', 'instances: []');
    const { problems } = check(readmeWith(body));

    expect(problems).toHaveLength(2);
  });

  it('OBS-03 um README sem a seção Operação, ou com ela só em nível 3, reprova', () => {
    const missing = check('# Projeto\n\n## Outra\n\ntexto\n');
    const nested = check(
      '# Projeto\n\n### Operação\n\n' + fenced('promql', 'app_active'),
    );

    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toContain('não tem a seção "Operação"');
    expect(nested.problems).toHaveLength(1);
    expect(nested.problems[0]).toContain('não tem a seção "Operação"');
  });

  it('OBS-03 um bloco yaml com groups que não é YAML válido reprova', () => {
    const body = goodBody() + '\n' + fenced('yaml', 'groups: [', '  - name: x');
    const { problems } = check(readmeWith(body));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('não é YAML válido');
  });

  it('OBS-03 um arquivo de regras sem lista de grupos, sem name ou sem lista de rules reprova', () => {
    const noList = check(
      readmeWith(goodBody() + '\n' + fenced('yaml', 'groups: {}')),
    );
    const noName = check(
      readmeWith(
        goodBody() + '\n' + fenced('yaml', 'groups:', '  - rules: []'),
      ),
    );
    const noRules = check(
      readmeWith(goodBody() + '\n' + fenced('yaml', 'groups:', '  - name: g')),
    );

    expect(noList.problems).toEqual([
      expect.stringContaining('groups não é uma lista'),
    ]);
    expect(noName.problems).toEqual([
      expect.stringContaining('falta o campo name'),
    ]);
    expect(noRules.problems).toEqual([
      expect.stringContaining('rules não é uma lista'),
    ]);
  });

  const RULE_CASES: [
    string,
    Partial<Record<RuleField, string | null>>,
    string,
  ][] = [
    ['sem alert', { alert: null }, 'falta o campo alert'],
    ['sem expr', { expr: null }, 'falta o campo expr'],
    ['sem for', { for: null }, 'falta o campo for'],
    [
      'com for que não é duração',
      { for: 'cinco minutos' },
      'não é uma duração do Prometheus',
    ],
    ['sem labels.severity', { severity: null }, 'falta labels.severity'],
    ['sem annotations.summary', { summary: null }, 'falta annotations.summary'],
    [
      'sem annotations.runbook_url',
      { runbook: null },
      'falta annotations.runbook_url',
    ],
    [
      'com expr inválida',
      { expr: 'sum(rate(app_requests_total[5m])' },
      'consulta inválida',
    ],
    [
      'com expr de métrica desconhecida',
      { expr: 'rate(app_requets_total[5m]) > 0' },
      'app_requets_total não está na coluna',
    ],
    [
      'com expr de valor fora da lista',
      { expr: 'app_requests_total{app_outcome="boom"} > 0' },
      'o valor "boom" não está na lista fechada',
    ],
    [
      'com runbook_url para âncora inexistente',
      { runbook: `${RUNBOOK_BASE}nao-existe` },
      'a âncora nao-existe não é de um cabeçalho da seção',
    ],
    [
      'com runbook_url para outro arquivo',
      {
        runbook: `${REPO_BLOB}/ARCHITECTURE.md#erp-falhando-ou-com-erro-de-configuração`,
      },
      'não aponta para o README.md deste repositório',
    ],
    [
      'com runbook_url para outro repositório',
      {
        runbook: `https://github.com/outro/casecellshop-backend/blob/main/${README_NAME}#erp-falhando-ou-com-erro-de-configuração`,
      },
      'não aponta para o README.md deste repositório',
    ],
    [
      'com runbook_url de outra branch',
      {
        runbook: `https://github.com/roneyrogerio/casecellshop-backend/blob/dev/${README_NAME}#erp-falhando-ou-com-erro-de-configuração`,
      },
      'não aponta para o README.md deste repositório',
    ],
    [
      'com runbook_url sem âncora',
      { runbook: RUNBOOK_BASE.slice(0, -1) },
      'não aponta para o README.md deste repositório',
    ],
    [
      'com runbook_url de âncora vazia',
      { runbook: RUNBOOK_BASE },
      'a âncora  não é de um cabeçalho da seção',
    ],
    [
      'com runbook_url sem acento na âncora',
      { runbook: `${RUNBOOK_BASE}erp-falhando-ou-com-erro-de-configuracao` },
      'não é de um cabeçalho da seção',
    ],
    [
      'com runbook_url com a âncora de um cabeçalho de fora da seção',
      { runbook: `${RUNBOOK_BASE}visão` },
      'não é de um cabeçalho da seção',
    ],
  ];

  it.each(RULE_CASES)(
    'OBS-03 regra %s reprova, e o problema nomeia o alerta',
    (_label, overrides, fragment) => {
      const { problems } = check(readmeWith(goodBody(ruleFile(overrides))));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(fragment);
      expect(problems[0]).toContain(
        overrides.alert === null ? 'regra 1' : 'alerta ErroAlto',
      );
    },
  );

  it('OBS-03 o runbook_url com a âncora codificada com % (a forma que o navegador copia) aponta para o mesmo cabeçalho', () => {
    const encoded = `${RUNBOOK_BASE}${encodeURIComponent('erp-falhando-ou-com-erro-de-configuração')}`;

    expect(encoded).toContain('%C3%A7');
    expect(
      check(readmeWith(goodBody(ruleFile({ runbook: encoded })))).problems,
    ).toEqual([]);
    expect(
      check(
        readmeWith(goodBody(ruleFile({ runbook: `${RUNBOOK_BASE}%E0%A4%A` }))),
      ).problems,
    ).toHaveLength(1);
  });

  it('OBS-03 a âncora do runbook_url é a calculada do cabeçalho: crase, pontuação e acento do cabeçalho viram a âncora do GitHub', () => {
    const headings = [
      '#### ERP falhando ou com erro de configuração',
      '#### Burn rate da vitrine ou do checkout',
      '### Fila (SQS): `redrive` & `cancel`',
    ];
    const anchors = [
      'erp-falhando-ou-com-erro-de-configuração',
      'burn-rate-da-vitrine-ou-do-checkout',
      'fila-sqs-redrive--cancel',
    ];
    const rules = anchors.map((anchor, index) =>
      ruleFile({
        alert: `Alerta${String(index)}`,
        runbook: `${RUNBOOK_BASE}${anchor}`,
      }),
    );
    const body = [
      fenced('promql', 'app_active'),
      ...headings.flatMap((heading) => [heading, '', 'Texto.', '']),
      ...rules.map((rule) => fenced('yaml', ...rule.split('\n'))),
    ].join('\n');

    expect(check(readmeWith(body)).problems).toEqual([]);
  });

  it('OBS-03 o cabeçalho repetido tem a âncora com -1: a sem sufixo aponta para o primeiro (fora da seção, reprova) e a com -1 para o da seção', () => {
    const body = (anchor: string): string =>
      [
        fenced('promql', 'app_active'),
        '### Alertas',
        '',
        fenced(
          'yaml',
          ...ruleFile({ runbook: `${RUNBOOK_BASE}${anchor}` }).split('\n'),
        ),
      ].join('\n');
    const before = '### Alertas\n';

    expect(check(readmeWith(body('alertas-1'), before)).problems).toEqual([]);
    const plain = check(readmeWith(body('alertas'), before));
    expect(plain.problems).toHaveLength(1);
    expect(plain.problems[0]).toContain(
      'a âncora alertas não é de um cabeçalho da seção',
    );
  });

  it('OBS-03 dois cabeçalhos iguais dentro da seção: a segunda âncora ganha -1', () => {
    const body = [
      fenced('promql', 'app_active'),
      '### Alertas',
      '',
      '### Alertas',
      '',
      fenced(
        'yaml',
        ...ruleFile({ runbook: `${RUNBOOK_BASE}alertas-1` }).split('\n'),
      ),
    ].join('\n');

    expect(check(readmeWith(body)).problems).toEqual([]);
  });

  it('OBS-03 um cabeçalho dentro de bloco de código não vale como destino do runbook_url', () => {
    const body = [
      fenced('promql', 'app_active'),
      fenced('bash', '#### Falso destino'),
      fenced(
        'yaml',
        ...ruleFile({ runbook: `${RUNBOOK_BASE}falso-destino` }).split('\n'),
      ),
    ].join('\n');
    const { problems } = check(readmeWith(body));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      'a âncora falso-destino não é de um cabeçalho da seção',
    );
  });

  it('OBS-03 duas regras com problemas são listadas as duas, cada uma pelo seu alerta', () => {
    const second = ruleFile({ alert: 'Segundo', severity: null })
      .split('\n')
      .slice(3);
    const file = [
      ...ruleFile({ alert: 'Primeiro', for: null }).split('\n'),
      ...second,
    ];
    const { problems, rules } = check(readmeWith(goodBody(file.join('\n'))));

    expect(rules).toBe(2);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('alerta Primeiro');
    expect(problems[1]).toContain('alerta Segundo');
  });
});
