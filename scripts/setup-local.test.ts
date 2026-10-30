import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../test/helpers/git-sandbox.ts';
import { isolatedEnv, localConfig, makeScriptsSandbox, runScript } from '../test/helpers/identity-sandbox.ts';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };
type Parsed = { identity: Identity } | { error: string };

const scriptPath = join(import.meta.dirname, 'setup-local.ts');

// Só executa ao ser rodado diretamente: sem essa guarda, importar mexeria na configuração do clone real.
function runsOnlyWhenDirect(): boolean {
  const source = readFileSync(scriptPath, 'utf8');
  return /process\.argv\[1\]/.test(source) || /import\.meta\.main/.test(source);
}

let parseSetupArgs: (argv: string[]) => Parsed = () => ({ error: 'módulo não carregado' });

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
// Só importa se a guarda existir: o módulo antigo executava o setup inteiro no import.
beforeAll(async () => {
  if (!runsOnlyWhenDirect()) return;
  const mod = (await import(pathToFileURL(scriptPath).href)) as { parseSetupArgs: typeof parseSetupArgs };
  parseSetupArgs = mod.parseSetupArgs;
});

afterEach(() => {
  cleanupTempDirs();
});

const USAGE_BOT = 'npm run setup:local -- --identity bot --login';
const USAGE_SELF = '--identity self';

function expectUsageError(argv: string[]): void {
  const parsed = parseSetupArgs(argv);

  const message = 'error' in parsed ? parsed.error : '';

  expect('error' in parsed).toBe(true);
  expect(message).toContain(USAGE_BOT);
  expect(message).toContain(USAGE_SELF);
}

describe('AI-14 setup:local só executa ao ser rodado diretamente', () => {
  it('AI-14 setup-local.ts tem a guarda de execução direta (importar não roda nada)', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
  });
});

describe('AI-14 parseSetupArgs, modo bot', () => {
  it('AI-14 --identity bot --login usa o item padrão do chaveiro', () => {
    expect(parseSetupArgs(['--identity', 'bot', '--login', 'minha-conta'])).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' },
    });
  });

  it('AI-14 --keychain troca o item do chaveiro', () => {
    expect(parseSetupArgs(['--identity', 'bot', '--login', 'minha-conta', '--keychain', 'item-x'])).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'item-x' },
    });
  });

  it('AI-14 a forma --login=conta também vale, em qualquer ordem', () => {
    expect(parseSetupArgs(['--login=minha-conta', '--identity=bot'])).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' },
    });
    expect(parseSetupArgs(['--identity', 'bot', '--login=minha-conta', '--keychain=item-x'])).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'item-x' },
    });
  });

  it.each(['a', 'abc', 'a-b', 'a1-b2-c3', '1abc', 'a'.repeat(39)])('AI-14 login válido %j é aceito', (login) => {
    const parsed = parseSetupArgs(['--identity', 'bot', '--login', login]);

    expect('identity' in parsed).toBe(true);
  });

  it.each(['-x', 'x-', 'a--b', 'a b', 'a_b', 'a.b', 'a'.repeat(40), ''])(
    'AI-14 login inválido %j devolve erro com o uso',
    (login) => {
      expectUsageError(['--identity', 'bot', '--login', login]);
    },
  );

  it('AI-14 bot sem --login devolve erro com o uso', () => {
    expectUsageError(['--identity', 'bot']);
    expectUsageError(['--identity', 'bot', '--keychain', 'item-x']);
  });
});

describe('AI-14 parseSetupArgs, modo self', () => {
  it('AI-14 --identity self devolve só o modo', () => {
    expect(parseSetupArgs(['--identity', 'self'])).toEqual({ identity: { mode: 'self' } });
  });

  it('AI-14 self com --login devolve erro', () => {
    expectUsageError(['--identity', 'self', '--login', 'minha-conta']);
  });

  it('AI-14 self com --keychain devolve erro', () => {
    expectUsageError(['--identity', 'self', '--keychain', 'item-x']);
  });
});

describe('AI-14 parseSetupArgs, argumentos inválidos', () => {
  it('AI-14 sem argumentos devolve erro com o uso', () => {
    expectUsageError([]);
  });

  it('AI-14 --identity desconhecido devolve erro com o uso', () => {
    expectUsageError(['--identity', 'admin']);
    expectUsageError(['--identity', 'admin', '--login', 'minha-conta']);
  });

  it('AI-14 --identity sem valor devolve erro com o uso', () => {
    expectUsageError(['--identity']);
  });
});

// O CLI de verdade, numa cópia dos scripts em um repositório temporário: nunca no clone real.
describe('AI-14 o CLI do setup:local', () => {
  it('AI-14 sem argumentos mostra o uso e sai com código diferente de 0', () => {
    // A guarda vem primeiro: sem ela, rodar o script antigo faria o setup inteiro.
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'setup-local.ts', []);

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(`${result.stdout}${result.stderr}`).toContain(USAGE_BOT);
    expect(localConfig(dir, 'casecellshop.identity')).toBeUndefined();
  }, 30_000);

  it('AI-14 --identity self grava o modo no git config local do clone', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'setup-local.ts', ['--identity', 'self'], { env: isolatedEnv() });

    expect(result.status).toBe(0);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBeUndefined();
  }, 30_000);
});
