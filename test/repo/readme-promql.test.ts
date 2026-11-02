import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parser } from '@prometheus-io/lezer-promql';
import GithubSlugger from 'github-slugger';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { prometheusName } from '../../scripts/generate-telemetry-doc.ts';
import { METRICS } from '../../scripts/telemetry-catalog.ts';
import { routes } from '../../src/contract/index.ts';
import type {
  AttributeSpec,
  AttributeValues,
  InstrumentKind,
  MetricSpec,
} from '../../src/shared/telemetry-catalog.ts';
import { repoRoot } from '../helpers/repo-root.ts';

// OBS-03: a seção "Operação" do README traz consultas PromQL (blocos `promql`) e regras de alerta (blocos `yaml` no
// formato de arquivo de regras do Prometheus, com a chave de topo `groups`). Cada consulta é lida pelo analisador
// oficial do PromQL, @prometheus-io/lezer-promql, em modo estrito (`strict: true` lança erro numa consulta inválida em
// vez de recuperar); nada é lido por expressão regular sobre o texto da consulta. A árvore diz o que é nome de métrica
// (`VectorSelector` com `Identifier`), rótulo de seletor (`LabelMatchers`) e valor (`StringLiteral`); os rótulos de
// `by`/`without`/`on`/`ignoring` e os nomes de função ficam em nós que o teste não visita.
//
// O README é lido pelo parser CommonMark do micromark (`fromMarkdown`, do mdast-util-from-markdown): a árvore mdast
// diz o que é cabeçalho (`heading`, com `depth`, ATX ou setext) e o que é bloco de código (`code`, com `lang` e
// `value`, cercado por ``` ou ~~~), dentro ou fora de lista e de citação. A âncora de cada cabeçalho vem do
// github-slugger, que recebe o texto simples do cabeçalho (o texto dos filhos do nó).
//
// O catálogo é o oráculo e vem da fonte tipada, não do telemetry.md: o METRICS (scripts/telemetry-catalog.ts) e o
// prometheusName (scripts/generate-telemetry-doc.ts) geram a coluna "No Prometheus" do telemetry.md, e o OBS-07 confere
// que o arquivo commitado é igual ao gerado. Os controles montam um catálogo de teste no mesmo formato da declaração.
//
// A única série aceita fora do catálogo é o `up` (o Prometheus o grava a cada coleta): só com `job` e `instance`, sem
// sufixo, e com cada `job` literal igual a um `job_name` de um bloco yaml da seção com a chave de topo `scrape_configs`
// (esse bloco não é arquivo de regras e não conta regra). O `instance` é lista aberta.
//
// Fontes consultadas:
// - Arquivo de regras do Prometheus (groups, rules, alert, expr, for, labels, annotations):
//   https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/
// - mdast-util-from-markdown 2.1.0 (`fromMarkdown(value)` devolve a árvore mdast; o parser segue o CommonMark) e o
//   mdast (`heading.depth`, `code.lang`, `code.value`, `position.start.line`, `text.value`, `inlineCode.value`,
//   `image.alt`, `children`).
// - github-slugger 2.0.0: "pass the plain text value of the heading"; `new GithubSlugger()` e `slug(texto)`, uma
//   instância por documento, repete a âncora com -1, -2... na ordem das chamadas.
// - Âncoras de cabeçalho do GitHub ("Section links"):
//   https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax

const README_NAME = 'README.md';
const README_FILE = join(repoRoot, README_NAME);

// O runbook_url de uma regra: o README deste repositório, na branch main, mais a âncora de um cabeçalho da seção.
const REPO_BLOB =
  'https://github.com/roneyrogerio/casecellshop-backend/blob/main';
const RUNBOOK_BASE = `${REPO_BLOB}/${README_NAME}#`;

const SECTION_TITLE = 'Operação';
const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];
const REGEX_OPS = new Set(['EqlRegex', 'NeqRegex']);
// Os metacaracteres de uma expressão regular, menos o `|`, que separa as alternativas. A chave não está aqui: o RE2 (a
// engine do Prometheus) lê `{orderId}` como texto, e só `{n}`, `{n,}` e `{n,m}` são repetição (REGEX_REPEAT).
const REGEX_METACHARS = /[.*+?()[\]^$\\]/;
const REGEX_REPEAT = /\{\d+(?:,\d*)?\}/;
// A duração do Prometheus, na gramática da documentação (`<duration>` em "Configuration"): as unidades em ordem
// (y, w, d, h, m, s, ms), cada uma no máximo uma vez, ou `0`. A expressão oficial aceita a string vazia (todas as
// unidades são opcionais), e um `for` vazio não é duração: a conferência de não vazio fica à parte (`filled`).
// https://prometheus.io/docs/prometheus/latest/configuration/configuration/
// https://prometheus.io/docs/prometheus/latest/querying/basics/#time-durations
const PROMETHEUS_DURATION =
  /^(?:(?:\d+y)?(?:\d+w)?(?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?(?:\d+ms)?|0)$/;

const isPrometheusDuration = (text: string): boolean =>
  text !== '' && PROMETHEUS_DURATION.test(text);

const strictParser = parser.configure({ strict: true });
type TreeNode = ReturnType<typeof strictParser.parse>['topNode'];

// --- leitura do Markdown ---------------------------------------------------------------------------------------------

type MdNode = ReturnType<typeof fromMarkdown>['children'][number];

interface Fence {
  info: string;
  content: string[];
  // Linha do bloco no README, a partir de 1 (a posição do nó `code`).
  line: number;
}

type Block =
  | { kind: 'heading'; depth: number; text: string; anchor: string }
  | { kind: 'fence'; fence: Fence }
  // Um nó `html` que traz a abertura de uma cerca de código: o bloco HTML (tipo 6 do CommonMark, como `<details>`)
  // só termina numa linha em branco, e sem ela a cerca vira texto do HTML e deixa de ser conferida. `line` é a linha
  // do README onde a cerca engolida abre.
  | { kind: 'swallowed'; line: number };

// A abertura de uma cerca de código: três ou mais crases ou ~~~, com recuo de até 3 espaços (com 4 já é bloco recuado).
// A regra lê uma linha do valor de um nó `html`, nunca o texto do README inteiro.
const FENCE_OPENING = /^ {0,3}(?:`{3,}|~{3,})/;

function childrenOf(node: MdNode): readonly MdNode[] {
  return 'children' in node ? node.children : [];
}

// O texto simples de um cabeçalho: o texto dos filhos. O texto de um link ou de um destaque fica, a marcação sai, o
// código em linha entra pelo valor, e a imagem entra pelo texto alternativo.
function plainText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  if (node.type === 'image' || node.type === 'imageReference')
    return node.alt ?? '';
  return childrenOf(node).map(plainText).join('');
}

// Os cabeçalhos e os blocos de código do documento inteiro, na ordem do documento, inclusive os que estão dentro de lista
// e de citação. Uma só instância do github-slugger por documento, chamada na ordem dos cabeçalhos, dá a âncora repetida
// com -1, -2... contando todos os cabeçalhos do arquivo, e não só os da seção.
function readBlocks(markdown: string): Block[] {
  const slugger = new GithubSlugger();
  const blocks: Block[] = [];
  const visit = (node: MdNode): void => {
    if (node.type === 'heading') {
      const text = plainText(node);
      blocks.push({
        kind: 'heading',
        depth: node.depth,
        text,
        anchor: slugger.slug(text),
      });
      return;
    }
    if (node.type === 'html') {
      const offset = node.value
        .split('\n')
        .findIndex((line) => FENCE_OPENING.test(line));
      if (offset >= 0)
        blocks.push({
          kind: 'swallowed',
          line: (node.position?.start.line ?? 0) + offset,
        });
      return;
    }
    if (node.type === 'code')
      blocks.push({
        kind: 'fence',
        fence: {
          info: node.lang ?? '',
          content: node.value.split('\n'),
          line: node.position?.start.line ?? 0,
        },
      });
    childrenOf(node).forEach(visit);
  };
  fromMarkdown(markdown).children.forEach(visit);
  return blocks;
}

interface Section {
  fences: Fence[];
  anchors: Set<string>;
  // Os `job_name` dos blocos yaml da seção com a chave de topo `scrape_configs`: os únicos `job` aceitos no `up`.
  jobs: Set<string>;
  // As linhas do README onde uma cerca de código foi engolida por um bloco HTML (ver o Block `swallowed`).
  swallowed: number[];
}

// Os `job_name` dos blocos yaml com `scrape_configs` na chave de topo, lidos pelo mesmo YAML da conferência das regras.
// Um bloco que não é YAML válido não dá nome nenhum (yamlBlockProblems já o acusa).
function scrapeJobNames(fences: readonly Fence[]): Set<string> {
  const jobs = new Set<string>();
  for (const fence of fences) {
    if (fence.info !== 'yaml') continue;
    let doc: unknown;
    try {
      doc = parseYaml(fence.content.join('\n'));
    } catch {
      continue;
    }
    const configs = field(doc, 'scrape_configs');
    if (!Array.isArray(configs)) continue;
    for (const config of configs) {
      const name = filled(field(config, 'job_name'));
      if (name !== undefined) jobs.add(name);
    }
  }
  return jobs;
}

// A seção vai do cabeçalho de profundidade 2 com o texto "Operação" até o próximo de profundidade 2 (ATX ou setext, e
// só fora de bloco de código, porque dentro dele não há nó `heading`); os de profundidade 3 e 4 ficam dentro. Devolve
// undefined quando o README não tem a seção.
function operationSection(readme: string): Section | undefined {
  const blocks = readBlocks(readme);
  const start = blocks.findIndex(
    (block) =>
      block.kind === 'heading' &&
      block.depth === 2 &&
      block.text.normalize('NFC') === SECTION_TITLE,
  );
  if (start < 0) return undefined;
  const next = blocks.findIndex(
    (block, index) =>
      index > start && block.kind === 'heading' && block.depth === 2,
  );
  const inside = blocks.slice(start, next < 0 ? undefined : next);
  const fences = inside.flatMap((block) =>
    block.kind === 'fence' ? [block.fence] : [],
  );
  return {
    fences,
    jobs: scrapeJobNames(fences),
    swallowed: inside.flatMap((block) =>
      block.kind === 'swallowed' ? [block.line] : [],
    ),
    // A âncora de um runbook_url é comparada em NFC: o navegador copia o acento composto.
    anchors: new Set(
      inside.flatMap((block) =>
        block.kind === 'heading' ? [block.anchor.normalize('NFC')] : [],
      ),
    ),
  };
}

// --- leitura do catálogo ---------------------------------------------------------------------------------------------

interface MetricEntry {
  series: string;
  instrument: InstrumentKind;
  histogram: boolean;
  // Rótulo do Prometheus -> valores da lista fechada, ou undefined quando a lista é aberta. A rota (`http_route`) é
  // lista fechada pelos `path` do contrato.
  attributes: Map<string, string[] | undefined>;
  // Os rótulos cuja lista fechada são as rotas do contrato, para a mensagem dizer isso.
  routeLabels: Set<string>;
  // As fronteiras declaradas do histograma, como o exportador as escreve no `le` (`String(n)`); vazio fora de histograma.
  bucketBounds: string[];
}

type Catalog = Map<string, MetricEntry>;

// O rótulo do Prometheus de um atributo OTel: o ponto vira sublinhado.
const prometheusLabel = (attribute: string): string =>
  attribute.replaceAll('.', '_');

// O `le` do último balde de todo histograma do Prometheus, além das fronteiras declaradas.
const INFINITE_BOUND = '+Inf';

// Os `path` das rotas do contrato (`routes`, de onde o OpenAPI é gerado): o oráculo dos valores de `http_route`.
const CONTRACT_PATHS: readonly string[] = routes.map((route) => route.path);

// O catálogo de uma declaração de métricas (o formato do METRICS): a série é a do prometheusName, o rótulo é o atributo
// OTel com `.` trocado por `_`, e a lista é fechada quando a declaração é `enum` (os valores) ou `http_route` (as
// rotas do contrato); o código de status HTTP é lista aberta. O `le` de um `_bucket` vem das fronteiras do histograma.
function buildCatalog(
  metrics: Readonly<Record<string, MetricSpec>>,
  routePaths: readonly string[] = CONTRACT_PATHS,
): Catalog {
  const catalog: Catalog = new Map();
  for (const [name, spec] of Object.entries(metrics)) {
    const series = prometheusName(name, spec.instrument);
    const attributeList = Object.entries(spec.attributes).map(
      ([attribute, { values }]) => ({
        label: prometheusLabel(attribute),
        allowed:
          values.kind === 'enum'
            ? [...values.values]
            : values.kind === 'http_route'
              ? [...routePaths]
              : undefined,
        route: values.kind === 'http_route',
      }),
    );
    catalog.set(series, {
      series,
      instrument: spec.instrument,
      histogram: spec.instrument === 'histogram',
      attributes: new Map(
        attributeList.map(({ label, allowed }) => [label, allowed]),
      ),
      routeLabels: new Set(
        attributeList.filter(({ route }) => route).map(({ label }) => label),
      ),
      bucketBounds: (spec.buckets ?? []).map(String),
    });
  }
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
  const { attributes, routeLabels, bucketBounds } = resolved.entry;
  let allowed: string[] | undefined;
  let rejection = `não está na lista fechada de ${label}`;
  if (label === 'le') {
    if (resolved.suffix !== '_bucket')
      return `o rótulo le só existe em _bucket, e a série é ${resolved.series}`;
    allowed = [...bucketBounds, INFINITE_BOUND];
    rejection = `não é uma fronteira declarada do histograma ${resolved.series.slice(0, -'_bucket'.length)}`;
  } else {
    if (!attributes.has(label))
      return `o rótulo ${label} não é atributo de ${resolved.series} (atributos: ${[...attributes.keys()].join(', ') || 'nenhum'})`;
    allowed = attributes.get(label);
    if (routeLabels.has(label))
      rejection = `de ${label} não é uma rota do contrato`;
  }
  if (allowed === undefined) return undefined;
  const regex = REGEX_OPS.has(op);
  for (const alternative of regex ? value.split('|') : [value]) {
    // O `.` de um valor da lista (0.2) é regex que casa consigo mesmo; o resto dos metacaracteres não.
    const literal = allowed.includes(alternative)
      ? alternative.replaceAll('.', '')
      : alternative;
    if (regex && (REGEX_METACHARS.test(literal) || REGEX_REPEAT.test(literal)))
      return `o valor "${value}" de ${label} tem metacaractere de regex (só alternativas literais separadas por |)`;
    if (!allowed.includes(alternative))
      return `o valor "${alternative}" ${rejection} (${allowed.length > 0 ? allowed.join(', ') : 'lista vazia: a seção não tem bloco yaml com scrape_configs e job_name'})`;
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

// A única série fora do catálogo: o `up`, que o próprio Prometheus grava a cada coleta, com os rótulos `job` e `instance`
// e sem sufixo (o nome é comparado inteiro, então `up_total` e `up_bucket` seguem como métrica desconhecida). O `job` é
// lista fechada pelos `job_name` dos blocos `scrape_configs` da seção; o `instance` é lista aberta. A conferência dos
// valores (inclusive as alternativas literais de um regex) é a mesma das outras listas fechadas, em labelProblem.
const UP_SERIES = 'up';

function upEntry(jobs: ReadonlySet<string>): MetricEntry {
  return {
    series: UP_SERIES,
    instrument: 'gauge',
    histogram: false,
    attributes: new Map<string, string[] | undefined>([
      ['job', [...jobs]],
      ['instance', undefined],
    ]),
    routeLabels: new Set(),
    bucketBounds: [],
  };
}

function selectorProblems(
  node: TreeNode,
  source: string,
  catalog: Catalog,
  jobs: ReadonlySet<string>,
): string[] {
  const selector = source.slice(node.from, node.to);
  const name = textOf(node.getChild('Identifier'), source);
  if (name === undefined) return [`seletor ${selector}: sem nome de métrica`];
  const resolved =
    name === UP_SERIES
      ? { series: UP_SERIES, entry: upEntry(jobs), suffix: '' }
      : resolveMetric(name, catalog);
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

// Sem bloco scrape_configs na seção não há `job_name` aceito.
const NO_JOBS: ReadonlySet<string> = new Set();

// Os problemas de uma consulta; vazio quando ela é válida e todo seletor bate com o catálogo.
function queryProblems(
  query: string,
  catalog: Catalog,
  jobs: ReadonlySet<string> = NO_JOBS,
): string[] {
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
        problems.push(...selectorProblems(ref.node, query, catalog, jobs));
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
  else problems.push(...queryProblems(expr, catalog, section.jobs));
  const duration = field(rule, 'for');
  if (filled(duration) === undefined) problems.push('falta o campo for');
  else if (!isPrometheusDuration(String(duration)))
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
  const where = `bloco yaml da linha ${String(fence.line)}`;
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
  // Uma cerca dentro de um bloco HTML não é nó `code`: sem este aviso, as consultas e as regras dela deixariam de ser
  // conferidas em silêncio, e o GitHub mostraria o bloco como texto quebrado.
  for (const line of section.swallowed)
    report.problems.push(
      `README linha ${String(line)}: bloco de código engolido por um bloco HTML (a cerca não é lida como código nem conferida): falta uma linha em branco depois do <summary> (ou antes do </details>)`,
    );
  for (const fence of section.fences) {
    if (fence.info === 'promql')
      for (const query of promqlQueries(fence.content)) {
        report.queries += 1;
        const where = `consulta (bloco promql da linha ${String(fence.line)}) ${oneLine(query)}`;
        report.problems.push(
          ...queryProblems(query, catalog, section.jobs).map(
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

// --- textos e catálogo montados para os controles --------------------------------------------------------------------

function fencedWith(marker: string, info: string, ...lines: string[]): string {
  return [`${marker}${info}`, ...lines, marker, ''].join('\n');
}

const FENCE = '`'.repeat(3);
const TILDE_FENCE = '~'.repeat(3);

function fenced(info: string, ...lines: string[]): string {
  return fencedWith(FENCE, info, ...lines);
}

// O prefixo em toda linha do texto: o recuo de um item de lista ou o `> ` de uma citação.
function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

const attribute = (values: AttributeValues): AttributeSpec => ({
  description: 'Atributo de teste.',
  requirement: 'required',
  values,
});

const closed = (...values: string[]): AttributeSpec =>
  attribute({ kind: 'enum', values });

// Um catálogo de teste no formato da declaração (o METRICS): um contador, um histograma com uma lista aberta de rota e
// de código de status, e um UpDownCounter sem atributos.
const TEST_METRICS: Readonly<Record<string, MetricSpec>> = {
  'app.requests': {
    instrument: 'counter',
    unit: '{request}',
    description: 'Pedidos.',
    attributes: { 'app.outcome': closed('ok', 'fail') },
  },
  'app.duration': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duração.',
    buckets: [1, 5],
    attributes: {
      'app.operation': closed('read', 'write'),
      'http.route': attribute({ kind: 'http_route' }),
      'http.response.status_code': attribute({ kind: 'http_status_code' }),
    },
  },
  'app.active': {
    instrument: 'up_down_counter',
    unit: '{operation}',
    description: 'Em andamento.',
    attributes: {},
  },
};

// Um contrato montado no teste: a main não tem todas as rotas que o README cita (o /products chega com o catálogo).
const TEST_ROUTES = ['/checkout', '/orders/{orderId}/status', '/products'];

const CATALOG = buildCatalog(TEST_METRICS, TEST_ROUTES);

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

const anchorsOfText = (text: string): string[] =>
  readBlocks(text).flatMap((block) =>
    block.kind === 'heading' ? [block.anchor] : [],
  );

// --- os testes -------------------------------------------------------------------------------------------------------

describe('OBS-03 as consultas e as regras da seção Operação do README batem com o catálogo de telemetria', () => {
  it('OBS-03 o README real: toda consulta e toda regra da seção Operação é válida e bate com o METRICS', () => {
    const report = checkOperation(
      readFileSync(README_FILE, 'utf8'),
      buildCatalog(METRICS),
    );

    expect(report.problems).toEqual([]);
  });
});

describe('OBS-03 o catálogo montado da declaração tipada (controles)', () => {
  it('OBS-03 o METRICS real vira catálogo: uma série por métrica, com o nome do prometheusName', () => {
    const catalog = buildCatalog(METRICS);
    const expected = Object.entries(METRICS).map(([name, spec]) =>
      prometheusName(name, spec.instrument),
    );

    expect(expected.length).toBeGreaterThan(0);
    expect([...catalog.keys()].sort()).toEqual([...expected].sort());
  });

  it('OBS-03 o METRICS real é lido: instrumento, listas fechadas, listas abertas e métrica sem atributos', () => {
    const catalog = buildCatalog(METRICS);
    const duration = catalog.get('http_server_request_duration');
    const checkout = catalog.get('casecellshop_checkout_requests_total');
    const active = catalog.get('casecellshop_erp_client_active_operations');

    expect(duration?.histogram).toBe(true);
    expect(duration?.instrument).toBe('histogram');
    expect(duration?.attributes.get('http_request_method')).toContain('_OTHER');
    expect(duration?.attributes.get('url_scheme')).toEqual(['http', 'https']);
    // A rota é lista fechada pelos `path` do contrato; o código de status HTTP é lista aberta (atributo sem valores).
    expect(duration?.attributes.get('http_route')).toEqual(CONTRACT_PATHS);
    expect(duration?.attributes.get('http_route')).toContain('/checkout');
    expect(duration?.attributes.get('http_route')).toContain(
      '/orders/{orderId}/status',
    );
    expect(duration?.routeLabels).toEqual(new Set(['http_route']));
    // As fronteiras do histograma são as declaradas, escritas como o exportador as escreve.
    expect(duration?.bucketBounds).toEqual(
      METRICS['http.server.request.duration']?.buckets?.map(String),
    );
    expect(duration?.bucketBounds).toContain('0.2');
    expect(duration?.attributes.has('http_response_status_code')).toBe(true);
    expect(
      duration?.attributes.get('http_response_status_code'),
    ).toBeUndefined();
    expect(checkout?.histogram).toBe(false);
    expect(checkout?.instrument).toBe('counter');
    expect(checkout?.attributes.get('casecellshop_checkout_outcome')).toEqual([
      'accepted',
      'replay',
      'out_of_stock',
      'price_changed',
      'invalid',
      'unavailable',
    ]);
    expect(active?.instrument).toBe('up_down_counter');
    expect(active?.attributes.size).toBe(0);
  });

  it('OBS-03 o catálogo de teste no formato da declaração é lido: contador ganha _total, o ponto do atributo OTel vira _ e a lista aberta fica sem valores', () => {
    expect([...CATALOG.keys()]).toEqual([
      'app_requests_total',
      'app_duration',
      'app_active',
    ]);
    expect(CATALOG.get('app_requests_total')?.instrument).toBe('counter');
    expect(CATALOG.get('app_duration')?.histogram).toBe(true);
    expect(CATALOG.get('app_active')?.instrument).toBe('up_down_counter');
    expect(
      CATALOG.get('app_duration')?.attributes.get('app_operation'),
    ).toEqual(['read', 'write']);
    expect(CATALOG.get('app_duration')?.attributes.get('http_route')).toEqual(
      TEST_ROUTES,
    );
    expect(CATALOG.get('app_duration')?.bucketBounds).toEqual(['1', '5']);
    expect(CATALOG.get('app_requests_total')?.bucketBounds).toEqual([]);
    expect(
      CATALOG.get('app_duration')?.attributes.get('http_response_status_code'),
    ).toBeUndefined();
    expect(CATALOG.get('app_active')?.attributes.size).toBe(0);
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
      'valor com chave entre aspas (rota do contrato)',
      'rate(app_duration_bucket{http_route="/orders/{orderId}/status"}[5m])',
    ],
    [
      'regex em lista aberta',
      'app_duration_count{http_response_status_code=~"5.."}',
    ],
    [
      'rota do contrato com chave, em =~, é texto no RE2',
      'app_duration_count{http_route=~"/checkout|/orders/{orderId}/status"}',
    ],
    ['rota do contrato com !=', 'app_duration_count{http_route!="/products"}'],
    [
      'rota do contrato com !~',
      'app_duration_count{http_route!~"/products|/checkout"}',
    ],
    ['le com fronteiras declaradas, com =~', 'app_duration_bucket{le=~"1|5"}'],
    ['le com +Inf', 'app_duration_bucket{le="+Inf"}'],
    ['le com != e fronteira declarada', 'app_duration_bucket{le!="5"}'],
    [
      'código de status HTTP (lista aberta)',
      'app_duration_count{http_response_status_code="503"}',
    ],
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
    [
      'le fora das fronteiras declaradas',
      'app_duration_bucket{le="3"}',
      'o valor "3" não é uma fronteira declarada do histograma app_duration',
    ],
    [
      'le que não é número',
      'app_duration_bucket{le="abc"}',
      'o valor "abc" não é uma fronteira declarada',
    ],
    [
      'le escrito diferente de String(n)',
      'app_duration_bucket{le="1.0"}',
      'o valor "1.0" não é uma fronteira declarada',
    ],
    [
      'le com +Inf em minúscula',
      'app_duration_bucket{le="+inf"}',
      'o valor "+inf" não é uma fronteira declarada',
    ],
    [
      'le fora das fronteiras com !=',
      'app_duration_bucket{le!="3"}',
      'o valor "3" não é uma fronteira declarada',
    ],
    [
      'le fora das fronteiras numa alternativa de =~',
      'app_duration_bucket{le=~"1|3|+Inf"}',
      'o valor "3" não é uma fronteira declarada',
    ],
    [
      'le com +Inf num =~ (o + é metacaractere)',
      'app_duration_bucket{le=~"1|+Inf"}',
      'metacaractere de regex',
    ],
    [
      'rota com erro de digitação',
      'app_duration_bucket{http_route="/checkuot"}',
      'o valor "/checkuot" de http_route não é uma rota do contrato',
    ],
    [
      'rota com erro de digitação numa alternativa de =~',
      'app_duration_count{http_route=~"/products|/checkuot"}',
      'o valor "/checkuot" de http_route não é uma rota do contrato',
    ],
    [
      'rota com barra final',
      'app_duration_count{http_route!="/checkout/"}',
      'o valor "/checkout/" de http_route não é uma rota do contrato',
    ],
    [
      'rota com !~ fora do contrato',
      'app_duration_count{http_route!~"/orders/{id}/status"}',
      'o valor "/orders/{id}/status" de http_route não é uma rota do contrato',
    ],
    [
      'rota com regex',
      'app_duration_count{http_route=~"/checkout.*"}',
      'metacaractere de regex',
    ],
    [
      'chave de repetição numa alternativa de =~',
      'app_requests_total{app_outcome=~"ok{2}"}',
      'metacaractere de regex',
    ],
    [
      'rótulo de status de outra métrica',
      'app_requests_total{http_response_status_code="200"}',
      'o rótulo http_response_status_code não é atributo de app_requests_total',
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

  it('OBS-03 as consultas do METRICS real: um nome com erro de digitação no prefixo e um valor fora da lista reprovam, os certos passam', () => {
    const catalog = buildCatalog(METRICS);
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
    expect(
      real(
        'sum(rate(http_server_request_duration_count{http_response_status_code="503"}[5m]))',
      ),
    ).toEqual([]);
    expect(
      real(
        'http_server_request_duration_bucket{http_route="/checkout", le="0.2"}',
      ),
    ).toEqual([]);
    expect(
      real('http_server_request_duration_bucket{le=~"0.2|0.5|+Inf"}'),
    ).toHaveLength(1);
    expect(real('http_server_request_duration_bucket{le=~"0.2|0.5"}')).toEqual(
      [],
    );
    expect(real('http_server_request_duration_bucket{le="+Inf"}')).toEqual([]);
    expect(real('http_server_request_duration_bucket{le="0.3"}')).toHaveLength(
      1,
    );
    expect(real('http_server_request_duration_bucket{le="abc"}')).toHaveLength(
      1,
    );
    expect(
      real('http_server_request_duration_count{http_route="/checkuot"}'),
    ).toHaveLength(1);
    expect(
      real(
        'http_server_request_duration_count{http_route=~"/checkout|/orders/{orderId}/status"}',
      ),
    ).toEqual([]);
    expect(
      real(
        'http_server_request_duration_count{http_route=~"/checkout|/checkuot"}',
      ),
    ).toHaveLength(1);
    expect(real('rate(casecellshp_checkout_requests_total[5m])')).toHaveLength(
      1,
    );
    expect(
      real(
        'casecellshop_checkout_requests_total{casecellshop_checkout_outcome="rejected"}',
      ),
    ).toHaveLength(1);
    expect(
      real('http_server_request_duration_bucket{http_request_method="BOGUS"}'),
    ).toHaveLength(1);
    expect(
      real(
        'casecellshop_erp_client_operation_duration_bucket{casecellshop_erp_outcome="timeout"}',
      ),
    ).toHaveLength(1);
  });
});

describe('OBS-03 a leitura do Markdown e das âncoras (controles)', () => {
  // [cabeçalho em Markdown, o texto simples que o github-slugger recebe, a âncora]
  const ANCHORS: [string, string, string][] = [
    ['## Operação', 'Operação', 'operação'],
    [
      '#### ERP falhando ou com erro de configuração',
      'ERP falhando ou com erro de configuração',
      'erp-falhando-ou-com-erro-de-configuração',
    ],
    [
      '#### Burn rate da vitrine ou do checkout',
      'Burn rate da vitrine ou do checkout',
      'burn-rate-da-vitrine-ou-do-checkout',
    ],
    [
      '### Comando `redrive` e `cancel`',
      'Comando redrive e cancel',
      'comando-redrive-e-cancel',
    ],
    [
      '### Fila (SQS): `redrive` & `cancel`',
      'Fila (SQS): redrive & cancel',
      'fila-sqs-redrive--cancel',
    ],
    ['### Pré-requisitos (M5)', 'Pré-requisitos (M5)', 'pré-requisitos-m5'],
    [
      '### ERP & fila: o que fazer?',
      'ERP & fila: o que fazer?',
      'erp--fila-o-que-fazer',
    ],
    ['### [Veja](http://x) o texto', 'Veja o texto', 'veja-o-texto'],
    ['### **Negrito** e _itálico_', 'Negrito e itálico', 'negrito-e-itálico'],
    [
      '###    Espaços   nas pontas   ',
      'Espaços   nas pontas',
      'espaços---nas-pontas',
    ],
    ['## Título fechado ##', 'Título fechado', 'título-fechado'],
    ['## Ação `Já` ok', 'Ação Já ok', 'ação-já-ok'],
  ];

  it.each(ANCHORS)(
    'OBS-03 a âncora do cabeçalho %s é a do github-slugger para o texto simples (%s): %s',
    (heading, plain, anchor) => {
      expect(anchorsOfText(heading)).toEqual([anchor]);
      expect(new GithubSlugger().slug(plain)).toBe(anchor);
    },
  );

  it('OBS-03 o cabeçalho repetido ganha -1, -2... contando o documento inteiro, na mesma conta do github-slugger', () => {
    const text = [
      '## Alertas',
      '',
      '### Alertas',
      '',
      '### `Alertas`',
      '',
      '### Outro',
      '',
      '### Ação',
      '',
      '#### Ação',
    ].join('\n');
    const slugger = new GithubSlugger();

    expect(anchorsOfText(text)).toEqual([
      'alertas',
      'alertas-1',
      'alertas-2',
      'outro',
      'ação',
      'ação-1',
    ]);
    expect(
      ['Alertas', 'Alertas', 'Alertas', 'Outro', 'Ação', 'Ação'].map((plain) =>
        slugger.slug(plain),
      ),
    ).toEqual(anchorsOfText(text));
  });

  it('OBS-03 um cabeçalho setext de nível 2 (sublinhado com ---) toma âncora como um ATX, na mesma contagem de repetidos', () => {
    const text = [
      'Alertas',
      '-------',
      '',
      '## Alertas',
      '',
      'Outro',
      '=',
    ].join('\n');

    expect(anchorsOfText(text)).toEqual(['alertas', 'alertas-1', 'outro']);
  });

  it('OBS-03 um # dentro de bloco de código (cercado por crases, por ~~~ ou recuado) não é cabeçalho e não toma âncora', () => {
    const text = [
      '## Alertas',
      '',
      fenced('bash', '# Alertas', '## Falso'),
      fencedWith(TILDE_FENCE, 'bash', '# Alertas'),
      '    # Alertas',
      '',
      '### Alertas',
    ].join('\n');

    expect(anchorsOfText(text)).toEqual(['alertas', 'alertas-1']);
  });

  it('OBS-03 um bloco promql dentro de uma lista ou de uma citação ainda é bloco, com a linha do bloco no README', () => {
    const inList = [
      '- Consulta do dashboard:',
      '',
      prefixLines(fenced('promql', 'app_requets_total'), '  '),
    ].join('\n');
    const inQuote = prefixLines(fenced('promql', 'foo bar'), '> ');
    const body = [goodBody(), inList, '', inQuote].join('\n');
    const { problems, queries } = check(readmeWith(body));

    expect(queries).toBe(4);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('app_requets_total não está na coluna');
    expect(problems[1]).toContain('consulta inválida');
    const line = readmeWith(body).split('\n').indexOf('  ```promql') + 1;
    expect(line).toBeGreaterThan(0);
    expect(problems[0]).toContain(`bloco promql da linha ${String(line)}`);
  });

  it('OBS-03 um bloco yaml com uma regra dentro de uma lista ainda é bloco: a regra com problema é acusada', () => {
    const body = [
      fenced('promql', 'app_active'),
      '- Regra:',
      '',
      prefixLines(fenced('yaml', ...ruleFile({ for: null }).split('\n')), '  '),
      ERP_SECTION,
    ].join('\n');
    const { problems, rules } = check(readmeWith(body));

    expect(rules).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('alerta ErroAlto');
    expect(problems[0]).toContain('falta o campo for');
  });

  it('OBS-03 uma cerca com ~~~ também conta: o promql e o yaml cercados por ~~~ são lidos', () => {
    const body = [
      fencedWith(TILDE_FENCE, 'promql', 'app_active', '', 'app_requets_total'),
      fencedWith(TILDE_FENCE, 'yaml', ...ruleFile({ for: null }).split('\n')),
      ERP_SECTION,
    ].join('\n');
    const { problems, queries, rules } = check(readmeWith(body));

    expect(queries).toBe(2);
    expect(rules).toBe(1);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('app_requets_total');
    expect(problems[1]).toContain('falta o campo for');
  });

  it('OBS-03 uma cerca longa guarda uma cerca curta: o promql dentro de um bloco de quatro crases não é lido', () => {
    const longFence = '`'.repeat(4);
    const body =
      goodBody() +
      '\n' +
      fencedWith(longFence, 'markdown', fenced('promql', 'app_requets_total'));
    const report = check(readmeWith(body));

    expect(report.problems).toEqual([]);
    expect(report.queries).toBe(2);
  });

  // Um bloco recolhível do GitHub: com a linha em branco depois do `<summary>`, a cerca é um nó `code` e é lida.
  const details = (summary: string, ...inner: string[]): string =>
    [
      '<details>',
      `<summary>${summary}</summary>`,
      '',
      ...inner,
      '</details>',
      '',
    ].join('\n');

  it('OBS-03 consultas e regras dentro de <details> com a linha em branco são lidas e contadas, e uma regra quebrada lá dentro é acusada', () => {
    const folded = (rule: string, ...queries: string[]): string =>
      [
        details('Consultas', fenced('promql', ...queries)),
        details('Regras', fenced('yaml', ...rule.split('\n'))),
        ERP_SECTION,
      ].join('\n');
    const good = check(readmeWith(folded(ruleFile(), ...GOOD_QUERIES)));
    const broken = check(
      readmeWith(
        folded(ruleFile({ for: null }), 'app_active', '', 'app_requets_total'),
      ),
    );

    expect(good.problems).toEqual([]);
    expect(good.queries).toBe(2);
    expect(good.rules).toBe(1);
    expect(broken.queries).toBe(2);
    expect(broken.rules).toBe(1);
    expect(broken.problems).toHaveLength(2);
    expect(broken.problems[0]).toContain(
      'app_requets_total não está na coluna',
    );
    expect(broken.problems[1]).toContain('alerta ErroAlto');
    expect(broken.problems[1]).toContain('falta o campo for');
  });

  // A cerca colada ao `<summary>`, sem linha em branco: o bloco HTML a engole, nas três formas de abrir uma cerca.
  it.each([
    ['crases', '```'],
    ['~~~', '~~~'],
    ['crases com recuo de 3 espaços', '   ```'],
  ])(
    'OBS-03 <details> sem a linha em branco depois do <summary> engole a cerca (%s): a conferência acusa o bloco e a linha do README',
    (_label, marker) => {
      const swallowed = [
        '<details>',
        '<summary>Consultas</summary>',
        `${marker}promql`,
        'app_requets_total',
        marker.trim(),
        '</details>',
        '',
      ].join('\n');
      const readme = readmeWith(goodBody() + '\n' + swallowed);
      const { problems, queries } = check(readme);
      const line = readme.split('\n').lastIndexOf(`${marker}promql`) + 1;

      expect(line).toBeGreaterThan(0);
      // A consulta engolida não é lida (o erro de digitação dela não aparece), e o aviso diz por quê.
      expect(queries).toBe(2);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`README linha ${String(line)}`);
      expect(problems[0]).toContain('engolido por um bloco HTML');
      expect(problems[0]).toContain('linha em branco depois do <summary>');
      expect(problems[0]).toContain('</details>');
    },
  );

  it('OBS-03 <details> só com texto (sem cerca de código, nem com ``` no meio da linha ou recuado em 4 espaços) não gera problema', () => {
    const textOnly = [
      '<details>',
      '<summary>Detalhes</summary>',
      '',
      'Texto do detalhe, com `promql` e ```promql no meio da linha.',
      '',
      '</details>',
      '',
      '<details>',
      '<summary>Sem a linha em branco, mas sem código</summary>',
      'Só texto.',
      '    ```promql',
      '</details>',
      '',
    ].join('\n');
    const report = check(readmeWith(goodBody() + '\n' + textOnly));

    expect(report.problems).toEqual([]);
    expect(report.queries).toBe(2);
    expect(report.rules).toBe(1);
  });

  it('OBS-03 a seção vai do cabeçalho Operação até o próximo de nível 2 fora de bloco de código, com os níveis 3 e 4 dentro', () => {
    const readme = readmeWith(
      [
        '### Dentro',
        '',
        fenced('bash', '## Não termina a seção', 'echo oi'),
        fencedWith(TILDE_FENCE, 'bash', '## Também não termina'),
        '    ## Nem este, recuado',
        '',
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
    // O bloco recuado (sem cerca) também é um nó `code`, sem linguagem.
    expect(section?.fences.map((fence) => fence.info)).toEqual([
      'bash',
      'bash',
      '',
      'promql',
    ]);
  });

  // O cabeçalho que abre e o que encerra a seção, cada um em ATX ou em setext; o bloco promql inválido depois do
  // encerramento fica fora da seção.
  it.each([
    ['abre', ['Operação', '--------'], ['## Limitações']],
    ['encerra', ['## Operação'], ['Limitações', '----------']],
  ])(
    'OBS-03 um cabeçalho setext de nível 2 %s a seção como um ATX',
    (_label, opening, closing) => {
      const readme = [
        '# Projeto',
        '',
        ...opening,
        '',
        goodBody(),
        ...closing,
        '',
        fenced('promql', 'fora_da_secao_invalida'),
      ].join('\n');
      const report = check(readme);

      expect(report.problems).toEqual([]);
      expect(report.queries).toBe(2);
      expect(report.rules).toBe(1);
    },
  );

  it('OBS-03 um cabeçalho setext de nível 2 de outro nome não abre a seção, e um Operação setext de nível 1 (===) também não', () => {
    const readme = [
      '# Projeto',
      '',
      'Outra',
      '-----',
      '',
      'Operação',
      '========',
      '',
      goodBody(),
    ].join('\n');
    const { problems } = check(readme);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('não tem a seção "Operação"');
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
    ['com for vazio', { for: '' }, 'falta o campo for'],
    [
      'com for de unidades fora de ordem (5m1h)',
      { for: '5m1h' },
      'o for 5m1h não é uma duração do Prometheus',
    ],
    [
      'com for de unidade repetida (1m1m)',
      { for: '1m1m' },
      'o for 1m1m não é uma duração do Prometheus',
    ],
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

  it('OBS-03 a âncora do runbook_url é a do github-slugger: crase, pontuação e acento do cabeçalho viram a âncora do GitHub', () => {
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

describe('OBS-03 a duração do for na gramática do Prometheus (controles)', () => {
  const VALID_DURATIONS = [
    '0',
    '0m',
    '0s',
    '5m',
    '30s',
    '1h30m',
    '2d',
    '1y2w3d4h5m6s7ms',
    '1s1ms',
    '100ms',
    '90m',
  ];
  const INVALID_DURATIONS = [
    '5m1h',
    '1m1m',
    '30s5m',
    '1ms1s',
    '',
    '5',
    'm',
    '5 m',
    '-5m',
    '1.5h',
    '5M',
    '1h 30m',
    '00x',
    'cinco minutos',
  ];

  it.each(VALID_DURATIONS)('OBS-03 a duração %s passa', (duration) => {
    expect(isPrometheusDuration(duration)).toBe(true);
    expect(
      check(readmeWith(goodBody(ruleFile({ for: duration })))).problems,
    ).toEqual([]);
  });

  it.each(INVALID_DURATIONS)(
    'OBS-03 a duração "%s" reprova: unidade fora de ordem, repetida, sem unidade ou vazia',
    (duration) => {
      expect(isPrometheusDuration(duration)).toBe(false);
      const { problems } = check(
        readmeWith(goodBody(ruleFile({ for: duration }))),
      );

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('alerta ErroAlto');
    },
  );
});

describe('OBS-03 a série up, a única fora do catálogo (controles)', () => {
  const API = 'casecellshop-api';
  const WORKER = 'casecellshop-worker';
  const JOBS: ReadonlySet<string> = new Set([API, WORKER]);
  const ACCEPTED = `(${API}, ${WORKER})`;
  const FORA_DA_LISTA = `não está na lista fechada de job ${ACCEPTED}`;
  const NO_BLOCK = 'a seção não tem bloco yaml com scrape_configs e job_name';
  // A regra de indisponibilidade da API: o `up` some quando o alvo cai, e o absent() cobre o alvo que nunca apareceu.
  const DOWN_EXPR = `max(up{job="${API}"}) == 0 or absent(up{job="${API}"})`;

  const upProblems = (
    query: string,
    jobs: ReadonlySet<string> = JOBS,
  ): string[] => queryProblems(query, CATALOG, jobs);

  // Um bloco de configuração de coleta do Prometheus com um alvo por job.
  const scrapeFile = (...jobs: string[]): string =>
    [
      'scrape_configs:',
      ...jobs.flatMap((job) => [
        `  - job_name: ${JSON.stringify(job)}`,
        '    static_configs:',
        '      - targets: ["app:3000"]',
      ]),
    ].join('\n');

  const scrapeBlock = (...jobs: string[]): string =>
    fenced('yaml', ...scrapeFile(...jobs).split('\n'));

  // Um README com uma regra de `expr` dado e, na seção, o bloco scrape_configs (`null` não põe bloco).
  const readmeUp = (
    expr: string,
    scrape: string | null = scrapeBlock(API, WORKER),
    before = '',
    after = '',
  ): string =>
    readmeWith(
      goodBody(ruleFile({ expr })) + (scrape === null ? '' : `\n${scrape}`),
      before,
      after,
    );

  const VALID_UP: [string, string][] = [
    ['job de um job_name', `up{job="${API}"}`],
    ['o outro job_name', `up{job="${WORKER}"}`],
    ['dentro de absent()', `absent(up{job="${API}"})`],
    ['dentro de max()', `max(up{job="${API}"})`],
    ['a regra de indisponibilidade da API', DOWN_EXPR],
    ['alternativas literais de job_name com =~', `up{job=~"${API}|${WORKER}"}`],
    ['job com !=', `up{job!="${WORKER}"}`],
    ['job com !~ e alternativas de job_name', `up{job!~"${WORKER}|${API}"}`],
    ['job entre aspas no rótulo', `up{"job"="${API}"}`],
    ['instance com valor qualquer (lista aberta)', 'up{instance="api:3000"}'],
    ['instance com regex (lista aberta)', 'up{instance=~"api:.*"}'],
    ['job e instance juntos', `up{job="${API}", instance="api:3000"}`],
    ['sem rótulos', 'up'],
    ['em agregação com by', 'sum by (job) (up)'],
    [
      'duas séries up na mesma consulta',
      `up{job="${API}"} + up{job="${WORKER}"}`,
    ],
    [
      'junto de uma métrica do catálogo',
      `app_active * on (instance) group_left up{job="${API}"}`,
    ],
  ];

  it.each(VALID_UP)('OBS-03 up passa: %s', (_label, query) => {
    expect(upProblems(query)).toEqual([]);
  });

  const INVALID_UP: [string, string, string][] = [
    [
      'job que não é job_name',
      'up{job="outro"}',
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    ['job vazio', 'up{job=""}', `o valor "" ${FORA_DA_LISTA}`],
    [
      'job que não é job_name dentro de absent()',
      'absent(up{job="outro"})',
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    [
      'job que não é job_name dentro de max()',
      'max(up{job="outro"}) == 0',
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    [
      'job com != fora da lista',
      'up{job!="outro"}',
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    [
      'job com !~ fora da lista',
      `up{job!~"${API}|outro"}`,
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    [
      'uma alternativa de =~ fora da lista',
      `up{job=~"${API}|outro"}`,
      `o valor "outro" ${FORA_DA_LISTA}`,
    ],
    [
      'job em maiúscula (a comparação é exata)',
      `up{job="${API.toUpperCase()}"}`,
      `o valor "${API.toUpperCase()}" ${FORA_DA_LISTA}`,
    ],
    ['regex em job (.*)', `up{job=~"${API}.*"}`, 'metacaractere de regex'],
    ['regex em job (.+ sozinha)', 'up{job=~".+"}', 'metacaractere de regex'],
    ['grupo de regex em job', `up{job=~"(${API})"}`, 'metacaractere de regex'],
    [
      'rótulo fora de job e instance',
      'up{foo="x"}',
      'o rótulo foo não é atributo de up (atributos: job, instance)',
    ],
    [
      'rótulo de outra métrica',
      'up{app_outcome="ok"}',
      'o rótulo app_outcome não é atributo de up',
    ],
    ['le num up', 'up{le="1"}', 'o rótulo le só existe em _bucket'],
    [
      'rótulo fora ao lado de job válido',
      `up{job="${API}", foo="x"}`,
      'o rótulo foo não é atributo de up',
    ],
    ['sufixo _total', 'up_total', 'up_total não está na coluna'],
    ['sufixo _bucket', 'up_bucket', 'up_bucket não está na coluna'],
    ['sufixo _count', 'rate(up_count[5m])', 'up_count não está na coluna'],
    ['sufixo _sum', 'up_sum', 'up_sum não está na coluna'],
    [
      'sufixo com job válido',
      `up_total{job="${API}"}`,
      'up_total não está na coluna',
    ],
    ['nome com outra caixa', 'UP', 'UP não está na coluna'],
    ['nome que só começa com up', 'upstream', 'upstream não está na coluna'],
  ];

  it.each(INVALID_UP)(
    'OBS-03 up reprova com a mensagem certa: %s',
    (_label, query, fragment) => {
      const problems = upProblems(query);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(fragment);
    },
  );

  // O controle negativo da exceção: só o `up` escapa do catálogo; qualquer outra série fora dele segue reprovando, com
  // ou sem rótulo de job válido.
  it.each([
    ['down', 'down'],
    ['down com job válido', `down{job="${API}"}`],
    ['process_cpu_seconds_total', 'process_cpu_seconds_total'],
    [
      'process_cpu_seconds_total com job válido',
      `rate(process_cpu_seconds_total{job="${API}"}[5m])`,
    ],
    ['scrape_duration_seconds', 'scrape_duration_seconds{instance="x"}'],
  ])(
    'OBS-03 série fora do catálogo que não é o up segue reprovando: %s',
    (_label, query) => {
      const problems = upProblems(query);

      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/não está na coluna "No Prometheus"/);
    },
  );

  it('OBS-03 up sem nenhum job_name conhecido: qualquer job literal reprova e a mensagem diz que falta o bloco scrape_configs', () => {
    for (const query of [
      `up{job="${API}"}`,
      `up{job=~"${API}|${WORKER}"}`,
      `absent(up{job="${API}"})`,
    ]) {
      const problems = upProblems(query, new Set());

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(NO_BLOCK);
    }
    // Sem job literal não há o que conferir: o instance (lista aberta) e o up sem rótulos passam.
    expect(upProblems('up{instance="api:3000"}', new Set())).toEqual([]);
    expect(upProblems('up', new Set())).toEqual([]);
  });

  it('OBS-03 up numa consulta com outro seletor inválido: cada seletor é acusado pelo seu texto', () => {
    const problems = upProblems(
      `up{job="outro"} == 0 and rate(app_requets_total[5m]) > 0`,
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('seletor up{job="outro"}');
    expect(problems[1]).toContain('seletor app_requets_total');
  });

  describe('a leitura dos job_name na seção do README', () => {
    it('OBS-03 a regra de indisponibilidade da API passa com o bloco scrape_configs na seção, e o bloco não conta como regra', () => {
      const report = check(readmeUp(DOWN_EXPR));

      expect(report.problems).toEqual([]);
      expect(report.rules).toBe(1);
      expect(report.queries).toBe(2);
    });

    it('OBS-03 os job_name vêm de todos os blocos scrape_configs da seção, um ou vários por bloco', () => {
      const readme = readmeUp(
        DOWN_EXPR,
        [scrapeBlock(API), scrapeBlock('outro-a', 'outro-b')].join('\n'),
      );

      expect(operationSection(readme)?.jobs).toEqual(
        new Set([API, 'outro-a', 'outro-b']),
      );
      expect(check(readme).problems).toEqual([]);
    });

    it('OBS-03 up{job=...} também passa num bloco promql da seção, e reprova com um job que não é job_name', () => {
      const body = [
        goodBody(),
        fenced('promql', `up{job="${API}"}`, '', 'up{job="outro"}'),
        scrapeBlock(API, WORKER),
      ].join('\n');
      const { problems, queries } = check(readmeWith(body));

      expect(queries).toBe(4);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('bloco promql');
      expect(problems[0]).toContain(`o valor "outro" ${FORA_DA_LISTA}`);
    });

    it('OBS-03 up{job="outro"} na regra reprova, e a mensagem cita os job_name aceitos e o alerta', () => {
      const { problems } = check(readmeUp('up{job="outro"} == 0'));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('alerta ErroAlto');
      expect(problems[0]).toContain(`o valor "outro" ${FORA_DA_LISTA}`);
    });

    it('OBS-03 sem bloco scrape_configs na seção, qualquer job literal reprova', () => {
      const { problems } = check(readmeUp(DOWN_EXPR, null));

      // O `job` aparece duas vezes na expressão: um problema por seletor.
      expect(problems).toHaveLength(2);
      for (const problem of problems) {
        expect(problem).toContain('alerta ErroAlto');
        expect(problem).toContain(NO_BLOCK);
      }
    });

    it('OBS-03 sem bloco scrape_configs, o up só com instance passa', () => {
      expect(
        check(readmeUp('up{instance="api:3000"} == 0', null)).problems,
      ).toEqual([]);
    });

    it('OBS-03 um bloco scrape_configs fora da seção Operação não conta, antes nem depois dela', () => {
      const outside = scrapeBlock(API, WORKER);
      const readme = readmeUp(DOWN_EXPR, null, outside, outside);

      expect(operationSection(readme)?.jobs).toEqual(new Set());
      const { problems } = check(readme);
      expect(problems).toHaveLength(2);
      expect(problems[0]).toContain(NO_BLOCK);
    });

    it('OBS-03 só conta o bloco yaml com scrape_configs na chave de topo: aninhado, em outra chave ou sem job_name não vale', () => {
      const blocks = [
        fenced(
          'yaml',
          'prometheus:',
          '  scrape_configs:',
          `    - job_name: ${API}`,
        ),
        fenced('yaml', 'targets:', `  - job_name: ${API}`),
        fenced('yaml', 'scrape_configs:', '  - static_configs: []'),
        fenced('yaml', 'scrape_configs: {}'),
        fenced('yaml', 'scrape_configs:', `  - job_name: ""`),
        fenced('bash', 'scrape_configs:', `  - job_name: ${API}`),
      ].join('\n');
      const readme = readmeUp(DOWN_EXPR, blocks);

      expect(operationSection(readme)?.jobs).toEqual(new Set());
      expect(check(readme).problems).toHaveLength(2);
    });

    it('OBS-03 o bloco scrape_configs numa lista ou numa cerca de ~~~ conta, pela mesma leitura de blocos', () => {
      const inList = [
        '- Coleta:',
        '',
        prefixLines(scrapeBlock(API), '  '),
      ].join('\n');
      const tilde = fencedWith(
        TILDE_FENCE,
        'yaml',
        ...scrapeFile(WORKER).split('\n'),
      );

      expect(check(readmeUp(`up{job="${API}"} == 0`, inList)).problems).toEqual(
        [],
      );
      expect(
        check(readmeUp(`up{job="${WORKER}"} == 0`, tilde)).problems,
      ).toEqual([]);
    });

    it('OBS-03 uma seção só com o bloco scrape_configs de regras não tem regra: o bloco não é arquivo de regras e não conta', () => {
      const body = fenced('promql', 'app_active') + '\n' + scrapeBlock(API);
      const report = check(readmeWith(body));

      expect(report.rules).toBe(0);
      expect(report.problems).toHaveLength(1);
      expect(report.problems[0]).toContain('não tem nenhuma regra');
    });

    it('OBS-03 o catálogo não ganha o up: série fora do catálogo que não é o up reprova na regra, com o bloco scrape_configs presente', () => {
      const { problems } = check(readmeUp(`down{job="${API}"} == 0`));

      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('down não está na coluna "No Prometheus"');
    });
  });
});
