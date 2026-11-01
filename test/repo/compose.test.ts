import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot as root } from '../helpers/repo-root.ts';

interface ComposeService {
  image?: string;
  healthcheck?: { test?: unknown };
  environment?: Record<string, unknown> | string[];
  depends_on?: Record<string, unknown> | string[];
  volumes?: unknown[];
  profiles?: unknown;
  command?: unknown;
  ports?: unknown;
}

interface ComposeFile {
  services?: Record<string, ComposeService>;
  volumes?: Record<string, unknown>;
}

// Endereços que obrigam o pg_isready a usar TCP. Um caminho (começa por `/`) escolhe o socket Unix.
const TCP_HOSTS = new Set(['localhost', '127.0.0.1']);

// Na primeira subida a imagem oficial roda um servidor temporário com `listen_addresses=''`, que só
// escuta no socket Unix. Sem `-h`, o pg_isready testa o socket e marca o banco saudável antes de a
// porta TCP abrir. A lista vazia é o que o healthcheck deve devolver.
export function pgIsReadyViolations(healthcheckCommand: string): string[] {
  const tokens = healthcheckCommand
    .split(/\s+/)
    .filter((token) => token !== '');
  const start = tokens.findIndex((token) => token === 'pg_isready');
  if (start === -1) {
    return ['o healthcheck não chama o pg_isready'];
  }

  let host: string | undefined;
  for (let i = start + 1; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (token === '-h' || token === '--host') {
      host = tokens[i + 1];
    } else if (token.startsWith('--host=')) {
      host = token.slice('--host='.length);
    } else if (token.startsWith('-h') && token.length > 2) {
      host = token.slice(2);
    }
  }

  if (host === undefined) {
    return [
      'o pg_isready não passa -h: testa o socket Unix, e não a porta TCP',
    ];
  }
  if (host.startsWith('/')) {
    return [`o pg_isready aponta -h para o socket Unix ${host}`];
  }
  if (!TCP_HOSTS.has(host)) {
    return [
      `o pg_isready aponta -h para ${host}, e não para localhost ou 127.0.0.1`,
    ];
  }
  return [];
}

// O healthcheck pode vir como lista (`["CMD-SHELL", "..."]`) ou como texto; a conferência olha o comando.
function commandOf(test: unknown): string {
  if (typeof test === 'string') {
    return test;
  }
  if (Array.isArray(test)) {
    return test
      .slice(1)
      .map((part) => String(part))
      .join(' ');
  }
  return '';
}

describe('FND-01 healthcheck do PostgreSQL no compose', () => {
  it('FND-01 o healthcheck do postgres no compose.yaml testa por TCP, com o pg_isready --host apontando para 127.0.0.1 ou localhost', () => {
    const compose = parse(
      readFileSync(join(root, 'compose.yaml'), 'utf8'),
    ) as ComposeFile;
    const test = compose.services?.['postgres']?.healthcheck?.test;

    expect(pgIsReadyViolations(commandOf(test))).toEqual([]);
  });

  it.each([
    [
      'o healthcheck antigo, sem -h',
      'pg_isready -U casecellshop -d casecellshop',
    ],
    [
      '-h apontando para o socket Unix',
      'pg_isready -h /var/run/postgresql -U casecellshop -d casecellshop',
    ],
    [
      '--host apontando para o socket Unix',
      'pg_isready --host=/var/run/postgresql -U casecellshop',
    ],
  ])(
    'FND-01 controle negativo: %s reprova a conferência',
    (_label, command) => {
      expect(pgIsReadyViolations(command)).not.toEqual([]);
    },
  );

  it.each([
    ['-h localhost', 'pg_isready -h localhost -U casecellshop -d casecellshop'],
    ['-h 127.0.0.1', 'pg_isready -U casecellshop -h 127.0.0.1 -d casecellshop'],
    ['--host localhost', 'pg_isready --host localhost -U casecellshop'],
  ])('FND-01 controle positivo: %s passa a conferência', (_label, command) => {
    expect(pgIsReadyViolations(command)).toEqual([]);
  });
});

// O `environment` do compose pode ser um mapa ou uma lista de `NOME=valor`.
function environmentOf(
  service: ComposeService | undefined,
): Record<string, string> {
  const raw = service?.environment;
  if (Array.isArray(raw)) {
    return Object.fromEntries(
      raw.map((entry) => {
        const separator = entry.indexOf('=');
        return separator === -1
          ? [entry, '']
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(raw ?? {}).map(([name, value]) => [name, String(value)]),
  );
}

function dependsOn(service: ComposeService | undefined): string[] {
  const raw = service?.depends_on;
  return Array.isArray(raw) ? raw : Object.keys(raw ?? {});
}

describe('FND-01 ElasticMQ no compose (M3, AD-021)', () => {
  const compose = parse(
    readFileSync(join(root, 'compose.yaml'), 'utf8'),
  ) as ComposeFile;
  const elasticmq = compose.services?.['elasticmq'];
  const worker = compose.services?.['worker'];

  // A versão mora só no compose.yaml (os testes de integração a leem de lá, em test/helpers/compose-image.ts): aqui se
  // confere a imagem nativa e a versão fixada, sem repetir o número.
  it('FND-01 o serviço elasticmq usa a imagem nativa softwaremill/elasticmq-native fixada em versão X.Y.Z, nunca latest', () => {
    expect(elasticmq?.image).toMatch(
      /^softwaremill\/elasticmq-native:\d+\.\d+\.\d+$/,
    );
  });

  it('FND-01 as mensagens do elasticmq ficam num volume nomeado declarado no compose, para sobreviver ao reinício', () => {
    const mounts = (elasticmq?.volumes ?? []).filter(
      (volume): volume is string => typeof volume === 'string',
    );
    const named = mounts
      .map((mount) => mount.split(':')[0] ?? '')
      .filter(
        (source) =>
          source !== '' && !source.startsWith('.') && !source.startsWith('/'),
      );

    expect(named.length).toBeGreaterThan(0);
    for (const name of named)
      expect(
        Object.keys(compose.volumes ?? {}),
        `volume ${name} sem declaração`,
      ).toContain(name);
  });

  it('FND-01 o elasticmq.conf fica em docker/elasticmq/, define as duas filas e o compose o monta no elasticmq', () => {
    const configPath = join(root, 'docker', 'elasticmq', 'elasticmq.conf');
    expect(existsSync(configPath)).toBe(true);
    // O caminho antigo, na raiz, deixa de existir: dois arquivos de configuração divergiriam.
    expect(existsSync(join(root, 'elasticmq.conf'))).toBe(false);
    const config = readFileSync(configPath, 'utf8');
    expect(config).toContain('billing-dlq');
    expect(config).toMatch(/\bbilling\b/);

    const mounts = (elasticmq?.volumes ?? []).filter(
      (volume): volume is string => typeof volume === 'string',
    );
    expect(
      mounts.some((mount) =>
        mount.startsWith('./docker/elasticmq/elasticmq.conf:'),
      ),
    ).toBe(true);
    expect(mounts.some((mount) => mount.startsWith('./elasticmq.conf:'))).toBe(
      false,
    );
  });

  it('FND-01 o worker depende do elasticmq', () => {
    expect(dependsOn(worker)).toContain('elasticmq');
  });

  it('FND-01 o worker recebe SQS_ENDPOINT, AWS_REGION, as URLs das duas filas e credenciais fixas sem segredo', () => {
    const environment = environmentOf(worker);

    expect(environment['SQS_ENDPOINT']).toMatch(/^http:\/\/elasticmq:9324\/?$/);
    expect(environment['AWS_REGION']).toBeTruthy();
    expect(
      new URL(environment['BILLING_QUEUE_URL'] ?? '').pathname.endsWith(
        '/billing',
      ),
    ).toBe(true);
    expect(
      new URL(environment['BILLING_DLQ_URL'] ?? '').pathname.endsWith(
        '/billing-dlq',
      ),
    ).toBe(true);
    // O SDK exige alguma credencial na cadeia padrão; o ElasticMQ a ignora.
    expect(environment['AWS_ACCESS_KEY_ID']).toBeTruthy();
    expect(environment['AWS_SECRET_ACCESS_KEY']).toBeTruthy();
  });
});

// --- FND-16: o serviço schemathesis (fuzzing guiado pelo contrato) ----------------------------------------------------

const FUZZ_CHECKS = [
  'not_a_server_error',
  'status_code_conformance',
  'content_type_conformance',
  'response_headers_conformance',
  'response_schema_conformance',
  'negative_data_rejection',
];
const FUZZ_IMAGE =
  /^ghcr\.io\/schemathesis\/schemathesis:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;
const SCHEMA_MOUNT = './openapi.yaml:/schema/openapi.yaml:ro';
const REPORT_MOUNT = './schemathesis-report:/reports';

// Uma opção da linha de comando, na forma `--opcao valor` ou `--opcao=valor`.
function optionValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at !== -1) return args[at + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function fuzzCommandViolations(command: unknown): string[] {
  if (!Array.isArray(command) || command.some((c) => typeof c !== 'string'))
    return ['o command não é uma lista de textos'];
  const args = command as string[];
  const violations: string[] = [];
  if (args[0] !== 'run') violations.push('o command não começa por run');
  if (args[1] !== '/schema/openapi.yaml')
    violations.push('o segundo argumento não é /schema/openapi.yaml');
  const expected: [string, string][] = [
    ['--url', 'http://api:3000'],
    ['--seed', '${FUZZ_SEED:-20261101}'],
    ['--max-examples', '${FUZZ_MAX_EXAMPLES:-50}'],
    ['--report', 'junit'],
    ['--report-dir', '/reports'],
  ];
  for (const [name, value] of expected)
    if (optionValue(args, name) !== value)
      violations.push(
        `${name} é ${String(optionValue(args, name))}, esperado ${value}`,
      );
  const checks = (optionValue(args, '--checks') ?? '').split(',');
  if (
    JSON.stringify([...checks].sort()) !==
    JSON.stringify([...FUZZ_CHECKS].sort())
  )
    violations.push(
      `--checks é ${checks.join(',')}, esperado as seis checagens`,
    );
  return violations;
}

function fuzzServiceViolations(compose: ComposeFile): string[] {
  const service = compose.services?.['schemathesis'];
  if (service === undefined) return ['falta o serviço schemathesis'];
  const violations: string[] = [];
  if (JSON.stringify(service.profiles) !== '["fuzz"]')
    violations.push('profiles não é só [fuzz]');
  if (!FUZZ_IMAGE.test(service.image ?? ''))
    violations.push(
      `image ${String(service.image)} não é a oficial fixada por versão X.Y.Z e digest sha256`,
    );
  const depends = service.depends_on;
  const api =
    depends !== undefined && !Array.isArray(depends)
      ? (depends['api'] as { condition?: unknown } | undefined)
      : undefined;
  if (api?.condition !== 'service_healthy')
    violations.push('não espera a api com condition: service_healthy');
  const volumes = service.volumes ?? [];
  if (!volumes.includes(SCHEMA_MOUNT))
    violations.push(`falta o volume ${SCHEMA_MOUNT} (só leitura)`);
  if (!volumes.includes(REPORT_MOUNT))
    violations.push(`falta o volume ${REPORT_MOUNT}`);
  if (service.ports !== undefined)
    violations.push('publica portas: deve falar pela rede do compose');
  return [...violations, ...fuzzCommandViolations(service.command)];
}

// Fora do perfil `fuzz` o `docker compose up` deve subir tudo menos o schemathesis: nenhum outro serviço tem perfil.
function profiledOthers(compose: ComposeFile): string[] {
  return Object.entries(compose.services ?? {})
    .filter(
      ([name, svc]) => name !== 'schemathesis' && svc.profiles !== undefined,
    )
    .map(([name]) => name);
}

function goodFuzzCompose(): ComposeFile {
  return {
    services: {
      api: { image: 'api:1' },
      schemathesis: {
        profiles: ['fuzz'],
        image: `ghcr.io/schemathesis/schemathesis:4.2.0@sha256:${'a'.repeat(64)}`,
        depends_on: { api: { condition: 'service_healthy' } },
        volumes: [SCHEMA_MOUNT, REPORT_MOUNT],
        command: [
          'run',
          '/schema/openapi.yaml',
          '--url',
          'http://api:3000',
          '--checks',
          FUZZ_CHECKS.join(','),
          '--seed',
          '${FUZZ_SEED:-20261101}',
          '--max-examples',
          '${FUZZ_MAX_EXAMPLES:-50}',
          '--report',
          'junit',
          '--report-dir',
          '/reports',
        ],
      },
    },
  };
}

function fuzzed(change: (service: ComposeService) => void): ComposeFile {
  const compose = goodFuzzCompose();
  const service = compose.services?.['schemathesis'];
  if (service === undefined) throw new Error('linha de base sem o serviço');
  change(service);
  return compose;
}

function swapArg(service: ComposeService, from: string, to: string): void {
  const command = service.command as string[];
  const at = command.indexOf(from);
  expect(at, `a linha de base não tem o argumento ${from}`).toBeGreaterThan(-1);
  command[at] = to;
}

describe('FND-16 as conferências do serviço schemathesis enxergam o que procuram (controle negativo)', () => {
  it('FND-16 o serviço correto passa (controle positivo)', () => {
    const compose = goodFuzzCompose();

    expect(fuzzServiceViolations(compose)).toEqual([]);
    expect(profiledOthers(compose)).toEqual([]);
  });

  it('FND-16 sem o serviço, reprova', () => {
    expect(fuzzServiceViolations({ services: {} })).toEqual([
      'falta o serviço schemathesis',
    ]);
  });

  it.each<[string, (service: ComposeService) => void]>([
    [
      'sem o perfil fuzz',
      (s) => {
        delete s.profiles;
      },
    ],
    [
      'em outro perfil',
      (s) => {
        s.profiles = ['dev'];
      },
    ],
    [
      'em dois perfis',
      (s) => {
        s.profiles = ['fuzz', 'dev'];
      },
    ],
    [
      'com a imagem só por tag',
      (s) => {
        s.image = 'ghcr.io/schemathesis/schemathesis:4.2.0';
      },
    ],
    [
      'com a imagem latest',
      (s) => {
        s.image = 'ghcr.io/schemathesis/schemathesis:latest';
      },
    ],
    [
      'com latest e digest',
      (s) => {
        s.image = `ghcr.io/schemathesis/schemathesis:latest@sha256:${'a'.repeat(64)}`;
      },
    ],
    [
      'com a imagem sem tag, só o digest',
      (s) => {
        s.image = `ghcr.io/schemathesis/schemathesis@sha256:${'a'.repeat(64)}`;
      },
    ],
    [
      'com o digest curto',
      (s) => {
        s.image = `ghcr.io/schemathesis/schemathesis:4.2.0@sha256:${'a'.repeat(63)}`;
      },
    ],
    [
      'com a imagem de outro registro',
      (s) => {
        s.image = `docker.io/schemathesis/schemathesis:4.2.0@sha256:${'a'.repeat(64)}`;
      },
    ],
    [
      'sem depends_on',
      (s) => {
        delete s.depends_on;
      },
    ],
    [
      'com depends_on em lista, sem a condição',
      (s) => {
        s.depends_on = ['api'];
      },
    ],
    [
      'esperando a api só iniciar',
      (s) => {
        s.depends_on = { api: { condition: 'service_started' } };
      },
    ],
    [
      'esperando outro serviço',
      (s) => {
        s.depends_on = { migrate: { condition: 'service_healthy' } };
      },
    ],
    [
      'com o contrato montado sem :ro',
      (s) => {
        s.volumes = ['./openapi.yaml:/schema/openapi.yaml', REPORT_MOUNT];
      },
    ],
    [
      'sem o volume do contrato',
      (s) => {
        s.volumes = [REPORT_MOUNT];
      },
    ],
    [
      'sem o volume do relatório',
      (s) => {
        s.volumes = [SCHEMA_MOUNT];
      },
    ],
    [
      'com o relatório em outro diretório do host',
      (s) => {
        s.volumes = [SCHEMA_MOUNT, './report:/reports'];
      },
    ],
    [
      'publicando uma porta no host',
      (s) => {
        s.ports = ['3000:3000'];
      },
    ],
    [
      'com a URL publicada no host',
      (s) => {
        swapArg(s, 'http://api:3000', 'http://localhost:3000');
      },
    ],
    [
      'com a URL da API sem a porta',
      (s) => {
        swapArg(s, 'http://api:3000', 'http://api');
      },
    ],
    [
      'com uma checagem a menos',
      (s) => {
        swapArg(s, FUZZ_CHECKS.join(','), FUZZ_CHECKS.slice(1).join(','));
      },
    ],
    [
      'sem a negative_data_rejection',
      (s) => {
        swapArg(s, FUZZ_CHECKS.join(','), FUZZ_CHECKS.slice(0, 5).join(','));
      },
    ],
    [
      'com uma checagem a mais',
      (s) => {
        swapArg(
          s,
          FUZZ_CHECKS.join(','),
          [...FUZZ_CHECKS, 'ignored_auth'].join(','),
        );
      },
    ],
    [
      'com --checks all',
      (s) => {
        swapArg(s, FUZZ_CHECKS.join(','), 'all');
      },
    ],
    [
      'com a semente fixa, sem vir do ambiente',
      (s) => {
        swapArg(s, '${FUZZ_SEED:-20261101}', '20261101');
      },
    ],
    [
      'com outro padrão de semente',
      (s) => {
        swapArg(s, '${FUZZ_SEED:-20261101}', '${FUZZ_SEED:-1}');
      },
    ],
    [
      'com o número de exemplos fixo',
      (s) => {
        swapArg(s, '${FUZZ_MAX_EXAMPLES:-50}', '50');
      },
    ],
    [
      'com outro padrão de exemplos',
      (s) => {
        swapArg(s, '${FUZZ_MAX_EXAMPLES:-50}', '${FUZZ_MAX_EXAMPLES:-5}');
      },
    ],
    [
      'sem o relatório junit',
      (s) => {
        swapArg(s, 'junit', 'cassettes');
      },
    ],
    [
      'com o relatório fora de /reports',
      (s) => {
        swapArg(s, '/reports', '/tmp/reports');
      },
    ],
    [
      'sem o subcomando run',
      (s) => {
        swapArg(s, 'run', 'test');
      },
    ],
    [
      'lendo outro arquivo de contrato',
      (s) => {
        swapArg(s, '/schema/openapi.yaml', '/openapi.yaml');
      },
    ],
    [
      'com o command em texto',
      (s) => {
        s.command = 'run /schema/openapi.yaml --url http://api:3000';
      },
    ],
  ])('FND-16 o serviço %s reprova', (_label, change) => {
    expect(fuzzServiceViolations(fuzzed(change))).not.toEqual([]);
  });

  it('FND-16 outro serviço com perfil também reprova: o docker compose up deixaria de subir tudo', () => {
    const compose = goodFuzzCompose();
    const api = compose.services?.['api'];
    if (api !== undefined) api.profiles = ['fuzz'];

    expect(profiledOthers(compose)).toEqual(['api']);
  });
});

describe('FND-16 o serviço schemathesis do compose.yaml', () => {
  const compose = parse(
    readFileSync(join(root, 'compose.yaml'), 'utf8'),
  ) as ComposeFile;

  it('FND-16 usa o perfil fuzz, a imagem oficial por versão e digest, a API saudável, o contrato só para leitura e a rede do compose', () => {
    expect(fuzzServiceViolations(compose)).toEqual([]);
  });

  it('FND-16 só o schemathesis tem perfil: o docker compose up sem perfil sobe os demais serviços e deixa o fuzzing de fora', () => {
    expect(compose.services?.['schemathesis']?.profiles).toEqual(['fuzz']);
    expect(profiledOthers(compose)).toEqual([]);
  });
});
