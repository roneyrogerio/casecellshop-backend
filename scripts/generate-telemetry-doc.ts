// OBS-07 (AD-029): gera o .specs/features/casecellshop/telemetry.md a partir das declarações de cada pasta (o
// agregado de scripts/telemetry-catalog.ts), como o openapi.yaml sai do contrato. Com --check, só compara com o
// arquivo commitado e falha se divergir; o --file troca o arquivo comparado, para o teste provar a detecção.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AttributeSpec,
  InstrumentKind,
  LogEventSpec,
  MetricSpec,
} from '../src/shared/telemetry-catalog.ts';

const HEADER = [
  '# Catálogo de telemetria',
  '',
  '<!-- Gerado por `npm run telemetry-doc` a partir dos `telemetry.ts` de cada pasta de `src/`. Não edite à mão. -->',
  '',
  'As regras de nome, de unidade e de tipo estão no `OBS-07` ([`spec.md`](spec.md)) e na `AD-029` ([`STATE.md`](../../project/STATE.md)).',
];

const INSTRUMENT_LABEL: Record<InstrumentKind, string> = {
  counter: 'contador',
  histogram: 'histograma',
  up_down_counter: 'UpDownCounter',
  observable_gauge: 'gauge observável',
};

const REQUIREMENT_LABEL: Record<AttributeSpec['requirement'], string> = {
  required: 'obrigatório',
  conditionally_required: 'condicional',
};

// O nome que o exportador Prometheus do OpenTelemetry dá à métrica: ponto vira sublinhado, e o contador ganha
// `_total` (o UpDownCounter e o gauge observável saem como gauge, sem sufixo; o histograma ganha `_bucket`, `_sum` e `_count` na
// exposição, e o nome base fica sem sufixo).
export function prometheusName(
  name: string,
  instrument: InstrumentKind,
): string {
  const base = name.replaceAll('.', '_');
  return instrument === 'counter' ? `${base}_total` : base;
}

const code = (text: string) => `\`${text}\``;
// O `|` fecharia a célula da tabela.
const cell = (text: string) => text.replaceAll('|', '\\|');
const row = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
const codeList = (items: readonly string[]) => items.map(code).join(', ');

// Ordem de texto simples, a mesma em qualquer máquina, sem depender da localidade.
function byName<T>(entries: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(entries).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

function valuesOf(spec: AttributeSpec): string {
  switch (spec.values.kind) {
    case 'enum':
      return codeList(spec.values.values);
    case 'http_status_code':
      return 'código de status HTTP';
    case 'http_route':
      return 'template da rota';
  }
}

function metricSection(name: string, spec: MetricSpec): string[] {
  const attributes = Object.entries(spec.attributes);
  return [
    `### ${code(name)}`,
    ...(spec.buckets ? ['', `Fronteiras: ${spec.buckets.join(', ')}`] : []),
    '',
    ...(attributes.length === 0
      ? ['Sem atributos.']
      : [
          row(['Atributo', 'Exigência', 'Valores', 'Descrição']),
          row(['---', '---', '---', '---']),
          ...attributes.map(([attribute, attributeSpec]) =>
            row([
              code(attribute),
              REQUIREMENT_LABEL[attributeSpec.requirement],
              valuesOf(attributeSpec),
              cell(attributeSpec.description),
            ]),
          ),
        ]),
  ];
}

function metricsPart(metrics: Readonly<Record<string, MetricSpec>>): string[] {
  const sorted = byName(metrics);
  return [
    '## Métricas',
    '',
    row(['Nome', 'No Prometheus', 'Instrumento', 'Unidade', 'Descrição']),
    row(['---', '---', '---', '---', '---']),
    ...sorted.map(([name, spec]) =>
      row([
        code(name),
        code(prometheusName(name, spec.instrument)),
        INSTRUMENT_LABEL[spec.instrument],
        code(spec.unit),
        cell(spec.description),
      ]),
    ),
    ...sorted.flatMap(([name, spec]) => ['', ...metricSection(name, spec)]),
  ];
}

function eventsPart(events: Readonly<Record<string, LogEventSpec>>): string[] {
  return [
    '## Eventos de log',
    '',
    row(['Nome', 'Níveis', 'Campos', 'Descrição']),
    row(['---', '---', '---', '---']),
    ...byName(events).map(([name, spec]) =>
      row([
        code(name),
        codeList(spec.levels),
        spec.fields.length === 0 ? '—' : codeList(spec.fields),
        cell(spec.description),
      ]),
    ),
  ];
}

// O Markdown do catálogo: as métricas e os eventos de log em ordem de nome, com o cabeçalho de arquivo gerado.
export function renderTelemetryDoc(
  metrics: Readonly<Record<string, MetricSpec>>,
  events: Readonly<Record<string, LogEventSpec>>,
): string {
  return `${[...HEADER, '', ...metricsPart(metrics), '', ...eventsPart(events)].join('\n')}\n`;
}

// O agregado só carrega quando o script roda, para os testes importarem as funções sem carregar as declarações.
async function main(argv: readonly string[]): Promise<void> {
  const { METRICS, LOG_EVENTS } = await import('./telemetry-catalog.ts');
  const fileIndex = argv.indexOf('--file');
  const target =
    fileIndex === -1
      ? new URL('../.specs/features/casecellshop/telemetry.md', import.meta.url)
      : resolve(argv[fileIndex + 1] ?? '');
  const generated = renderTelemetryDoc(METRICS, LOG_EVENTS);
  if (!argv.includes('--check')) {
    writeFileSync(target, generated);
    return;
  }
  let committed = '';
  try {
    committed = readFileSync(target, 'utf8');
  } catch {
    // Sem arquivo, a comparação abaixo já falha com a mensagem certa.
  }
  if (committed !== generated) {
    process.stderr.write(
      'telemetry.md diverge das declarações de telemetria. Rode `npm run telemetry-doc` e commite.\n',
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main(process.argv.slice(2));
