import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface ComposeFile {
  services?: Record<string, { healthcheck?: { test?: unknown } }>;
}

const root = join(import.meta.dirname, '..', '..');

// Endereços que obrigam o pg_isready a usar TCP. Um caminho (começa por `/`) escolhe o socket Unix.
const TCP_HOSTS = new Set(['localhost', '127.0.0.1']);

// Na primeira subida a imagem oficial roda um servidor temporário com `listen_addresses=''`, que só
// escuta no socket Unix. Sem `-h`, o pg_isready testa o socket e marca o banco saudável antes de a
// porta TCP abrir. A lista vazia é o que o healthcheck deve devolver.
export function pgIsReadyViolations(healthcheckCommand: string): string[] {
  const tokens = healthcheckCommand.split(/\s+/).filter((token) => token !== '');
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
    return ['o pg_isready não passa -h: testa o socket Unix, e não a porta TCP'];
  }
  if (host.startsWith('/')) {
    return [`o pg_isready aponta -h para o socket Unix ${host}`];
  }
  if (!TCP_HOSTS.has(host)) {
    return [`o pg_isready aponta -h para ${host}, e não para localhost ou 127.0.0.1`];
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
    const compose = parse(readFileSync(join(root, 'compose.yaml'), 'utf8')) as ComposeFile;
    const test = compose.services?.['postgres']?.healthcheck?.test;

    expect(pgIsReadyViolations(commandOf(test))).toEqual([]);
  });

  it.each([
    ['o healthcheck antigo, sem -h', 'pg_isready -U casecellshop -d casecellshop'],
    ['-h apontando para o socket Unix', 'pg_isready -h /var/run/postgresql -U casecellshop -d casecellshop'],
    ['--host apontando para o socket Unix', 'pg_isready --host=/var/run/postgresql -U casecellshop'],
  ])('FND-01 controle negativo: %s reprova a conferência', (_label, command) => {
    expect(pgIsReadyViolations(command)).not.toEqual([]);
  });

  it.each([
    ['-h localhost', 'pg_isready -h localhost -U casecellshop -d casecellshop'],
    ['-h 127.0.0.1', 'pg_isready -U casecellshop -h 127.0.0.1 -d casecellshop'],
    ['--host localhost', 'pg_isready --host localhost -U casecellshop'],
  ])('FND-01 controle positivo: %s passa a conferência', (_label, command) => {
    expect(pgIsReadyViolations(command)).toEqual([]);
  });
});
