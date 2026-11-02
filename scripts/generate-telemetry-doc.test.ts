import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, makeTempDir } from '../test/helpers/git-sandbox.ts';
import { runTelemetryDoc } from '../test/helpers/telemetry-doc-cli.ts';
import type {
  InstrumentKind,
  LogEventSpec,
  MetricSpec,
} from '../src/shared/telemetry-catalog.ts';
import {
  prometheusName,
  renderTelemetryDoc,
} from './generate-telemetry-doc.ts';
import { LOG_EVENTS, METRICS } from './telemetry-catalog.ts';

// OBS-07 (AD-029), itens "Prometheus" e "Documentação": o gerador do telemetry.md. O catálogo pequeno é montado
// aqui, sem tocar nas declarações de src/, para o formato do arquivo ficar fixado por inteiro.

afterAll(cleanupTempDirs);

// Declarado fora da ordem de nome de propósito: o gerador é quem ordena.
const METRICS_SAMPLE: Record<string, MetricSpec> = {
  'casecellshop.zeta.latency': {
    instrument: 'histogram',
    unit: 's',
    description: 'Duração da operação.',
    buckets: [0.005, 0.1, 1, 2.5],
    attributes: {
      'casecellshop.zeta.outcome': {
        description: 'Desfecho da operação.',
        requirement: 'required',
        values: { kind: 'enum', values: ['ok', 'failed'] },
      },
      'error.type': {
        description: 'Só quando houve erro.',
        requirement: 'conditionally_required',
        values: { kind: 'enum', values: ['timeout', 'refused'] },
      },
      'http.response.status_code': {
        description: 'Código de status da resposta.',
        requirement: 'required',
        values: { kind: 'http_status_code' },
      },
      'http.route': {
        description: 'Template da rota casada.',
        requirement: 'conditionally_required',
        values: { kind: 'http_route' },
      },
    },
  },
  'casecellshop.mid.active': {
    instrument: 'up_down_counter',
    unit: '{operation}',
    description: 'Operações em andamento.',
    attributes: {},
  },
  'casecellshop.alpha.events': {
    instrument: 'counter',
    unit: '{event}',
    description: 'Eventos contados.',
    attributes: {},
  },
};

const EVENTS_SAMPLE: Record<string, LogEventSpec> = {
  'casecellshop.zeta.failed': {
    levels: ['info', 'error'],
    description: 'Falha da operação.',
    fields: ['orderId', 'attempt'],
  },
  'casecellshop.alpha.started': {
    levels: ['info'],
    description: 'Início da rodada.',
    fields: [],
  },
};

const EXPECTED_SAMPLE = [
  '# Catálogo de telemetria',
  '',
  '<!-- Gerado por `npm run telemetry-doc` a partir dos `telemetry.ts` de cada pasta de `src/`. Não edite à mão. -->',
  '',
  'As regras de nome, de unidade e de tipo estão no `OBS-07` ([`spec.md`](spec.md)) e na `AD-029` ([`STATE.md`](../../project/STATE.md)).',
  '',
  '## Métricas',
  '',
  '| Nome | No Prometheus | Instrumento | Unidade | Descrição |',
  '| --- | --- | --- | --- | --- |',
  '| `casecellshop.alpha.events` | `casecellshop_alpha_events_total` | contador | `{event}` | Eventos contados. |',
  '| `casecellshop.mid.active` | `casecellshop_mid_active` | UpDownCounter | `{operation}` | Operações em andamento. |',
  '| `casecellshop.zeta.latency` | `casecellshop_zeta_latency` | histograma | `s` | Duração da operação. |',
  '',
  '### `casecellshop.alpha.events`',
  '',
  'Sem atributos.',
  '',
  '### `casecellshop.mid.active`',
  '',
  'Sem atributos.',
  '',
  '### `casecellshop.zeta.latency`',
  '',
  'Fronteiras: 0.005, 0.1, 1, 2.5',
  '',
  '| Atributo | Exigência | Valores | Descrição |',
  '| --- | --- | --- | --- |',
  '| `casecellshop.zeta.outcome` | obrigatório | `ok`, `failed` | Desfecho da operação. |',
  '| `error.type` | condicional | `timeout`, `refused` | Só quando houve erro. |',
  '| `http.response.status_code` | obrigatório | código de status HTTP | Código de status da resposta. |',
  '| `http.route` | condicional | template da rota | Template da rota casada. |',
  '',
  '## Eventos de log',
  '',
  '| Nome | Níveis | Campos | Descrição |',
  '| --- | --- | --- | --- |',
  '| `casecellshop.alpha.started` | `info` | — | Início da rodada. |',
  '| `casecellshop.zeta.failed` | `info`, `error` | `orderId`, `attempt` | Falha da operação. |',
  '',
].join('\n');

function counter(description = 'Contagem.'): MetricSpec {
  return { instrument: 'counter', unit: '{x}', description, attributes: {} };
}

function event(description = 'Evento.'): LogEventSpec {
  return { levels: ['info'], description, fields: [] };
}

describe('OBS-07 prometheusName traduz o nome como o exportador do Prometheus', () => {
  it.each<[string, InstrumentKind, string]>([
    [
      'casecellshop.outbox.attempts',
      'counter',
      'casecellshop_outbox_attempts_total',
    ],
    [
      'casecellshop.erp.out_of_stock.rejections',
      'counter',
      'casecellshop_erp_out_of_stock_rejections_total',
    ],
    [
      'http.server.request.duration',
      'histogram',
      'http_server_request_duration',
    ],
    [
      'casecellshop.erp.client.operation.duration',
      'histogram',
      'casecellshop_erp_client_operation_duration',
    ],
    [
      'casecellshop.erp.client.active_operations',
      'up_down_counter',
      'casecellshop_erp_client_active_operations',
    ],
  ])(
    'OBS-07 %s como %s sai como %s no Prometheus',
    (name, instrument, expected) => {
      expect(prometheusName(name, instrument)).toBe(expected);
    },
  );

  it('OBS-07 só o contador ganha o sufixo _total', () => {
    const name = 'casecellshop.x.y';

    expect(prometheusName(name, 'counter')).toBe('casecellshop_x_y_total');
    expect(prometheusName(name, 'histogram')).toBe('casecellshop_x_y');
    expect(prometheusName(name, 'up_down_counter')).toBe('casecellshop_x_y');
  });
});

describe('OBS-07 renderTelemetryDoc escreve o catálogo em Markdown', () => {
  it('OBS-07 o Markdown completo do catálogo pequeno sai no formato fixado', () => {
    expect(renderTelemetryDoc(METRICS_SAMPLE, EVENTS_SAMPLE)).toBe(
      EXPECTED_SAMPLE,
    );
  });

  it('OBS-07 o resultado não depende da ordem em que o catálogo foi declarado', () => {
    const reversedMetrics = Object.fromEntries(
      Object.entries(METRICS_SAMPLE).reverse(),
    );
    const reversedEvents = Object.fromEntries(
      Object.entries(EVENTS_SAMPLE).reverse(),
    );

    expect(renderTelemetryDoc(reversedMetrics, reversedEvents)).toBe(
      renderTelemetryDoc(METRICS_SAMPLE, EVENTS_SAMPLE),
    );
  });

  it('OBS-07 a ordem por nome é a do texto simples, e não a da localidade', () => {
    // Em texto simples `1` (49) vem antes de `_` (95); numa comparação de localidade a pontuação vem antes do dígito.
    const metrics = {
      'casecellshop.a_b.count': counter(),
      'casecellshop.a1.count': counter(),
    };
    const events = {
      'casecellshop.a_b.done': event(),
      'casecellshop.a1.done': event(),
    };

    const doc = renderTelemetryDoc(metrics, events);

    const sections = ['casecellshop.a1.count', 'casecellshop.a_b.count'].map(
      (name) => doc.indexOf(`### \`${name}\``),
    );
    expect(sections[0]).toBeGreaterThan(-1);
    expect(sections[0]).toBeLessThan(sections[1]!);
    const rows = ['casecellshop.a1.done', 'casecellshop.a_b.done'].map((name) =>
      doc.indexOf(`| \`${name}\` |`),
    );
    expect(rows[0]).toBeGreaterThan(-1);
    expect(rows[0]).toBeLessThan(rows[1]!);
  });

  it('OBS-07 o | dentro de uma descrição sai escapado em todas as tabelas', () => {
    const metrics: Record<string, MetricSpec> = {
      'casecellshop.a.b': {
        instrument: 'counter',
        unit: '{x}',
        description: 'cara | coroa',
        attributes: {
          'casecellshop.a.kind': {
            description: 'um | outro',
            requirement: 'required',
            values: { kind: 'enum', values: ['a'] },
          },
        },
      },
    };
    const events = { 'casecellshop.a.done': event('feito | ou não') };

    const doc = renderTelemetryDoc(metrics, events);

    expect(doc).toContain('| contador | `{x}` | cara \\| coroa |');
    expect(doc).toContain('| `a` | um \\| outro |');
    expect(doc).toContain('| feito \\| ou não |');
    expect(doc).not.toMatch(/cara \| coroa/);
  });

  it('OBS-07 um histograma sem atributos traz as fronteiras e depois "Sem atributos."', () => {
    const metrics: Record<string, MetricSpec> = {
      'casecellshop.a.duration': {
        instrument: 'histogram',
        unit: 's',
        description: 'Duração.',
        buckets: [1, 2],
        attributes: {},
      },
    };

    const doc = renderTelemetryDoc(metrics, { 'casecellshop.a.done': event() });

    expect(doc).toContain(
      '### `casecellshop.a.duration`\n\nFronteiras: 1, 2\n\nSem atributos.\n\n## Eventos de log\n',
    );
  });

  it('OBS-07 o arquivo termina com uma quebra de linha só e sem linhas em branco repetidas', () => {
    const doc = renderTelemetryDoc(METRICS_SAMPLE, EVENTS_SAMPLE);

    expect(doc.endsWith('|\n')).toBe(true);
    expect(doc.endsWith('\n\n')).toBe(false);
    expect(doc).not.toContain('\n\n\n');
  });

  it('OBS-07 o catálogo real gera uma linha de métrica e uma seção por métrica, e uma linha por evento', () => {
    const doc = renderTelemetryDoc(METRICS, LOG_EVENTS);

    for (const name of Object.keys(METRICS)) {
      expect(doc, name).toContain(`| \`${name}\` |`);
      expect(doc, name).toContain(`### \`${name}\`\n`);
    }
    for (const name of Object.keys(LOG_EVENTS))
      expect(doc, name).toContain(`| \`${name}\` |`);
  });
});

describe('OBS-07 o CLI scripts/generate-telemetry-doc.ts', () => {
  function copy(content: string): string {
    const file = join(makeTempDir('telemetry-doc-'), 'telemetry.md');
    writeFileSync(file, content);
    return file;
  }

  it('OBS-07 o --check com --file sai com 0 para um arquivo igual ao gerado do catálogo real', () => {
    const file = copy(renderTelemetryDoc(METRICS, LOG_EVENTS));

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status, result.stderr).toBe(0);
  });

  it('OBS-07 o --check sai com 1 e manda rodar npm run telemetry-doc para um arquivo diferente', () => {
    const file = copy(
      `${renderTelemetryDoc(METRICS, LOG_EVENTS)}outra linha\n`,
    );

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run telemetry-doc');
  });

  it('OBS-07 o --check sai com 1 e manda rodar npm run telemetry-doc quando o arquivo não existe', () => {
    const file = join(makeTempDir('telemetry-doc-'), 'inexistente.md');

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run telemetry-doc');
  });

  it('OBS-07 o --check não reescreve o arquivo comparado', () => {
    const file = copy('# defasado\n');

    const result = runTelemetryDoc('--check', '--file', file);

    expect(result.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('# defasado\n');
  });

  it('OBS-07 sem o --check, o --file recebe o catálogo real gerado', () => {
    const file = copy('');

    const result = runTelemetryDoc('--file', file);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(
      renderTelemetryDoc(METRICS, LOG_EVENTS),
    );
  });

  it('OBS-07 sem o --check, o --file sobrescreve um arquivo defasado', () => {
    const file = copy('# defasado\n');

    runTelemetryDoc('--file', file);

    expect(readFileSync(file, 'utf8')).toBe(
      renderTelemetryDoc(METRICS, LOG_EVENTS),
    );
  });
});
