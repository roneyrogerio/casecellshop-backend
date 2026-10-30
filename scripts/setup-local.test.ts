import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, git } from '../test/helpers/git-sandbox.ts';
import { isolatedEnv, localConfig, makeScriptsSandbox, runScript } from '../test/helpers/identity-sandbox.ts';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };
type Parsed = { identity: Identity } | { error: string };

const scriptPath = join(import.meta.dirname, 'setup-local.ts');

// Só executa ao ser rodado diretamente: sem essa guarda, importar mexeria na configuração do clone real.
function runsOnlyWhenDirect(): boolean {
  const source = readFileSync(scriptPath, 'utf8');
  return /process\.argv\[1\]/.test(source) || /import\.meta\.main/.test(source);
}

type Resolved = Parsed | { ask: true };
type Ask = (question: string) => Promise<string>;

let parseSetupArgs: (argv: string[]) => Parsed = () => ({ error: 'módulo não carregado' });
let resolveIdentity: (argv: string[], configured: Identity | undefined, interactive: boolean) => Resolved = () => ({
  error: 'módulo não carregado',
});
let promptIdentity: (ask: Ask) => Promise<Parsed> = () => Promise.resolve({ error: 'módulo não carregado' });

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
// Só importa se a guarda existir: o módulo antigo executava o setup inteiro no import.
beforeAll(async () => {
  if (!runsOnlyWhenDirect()) return;
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    parseSetupArgs: typeof parseSetupArgs;
    resolveIdentity?: typeof resolveIdentity;
    promptIdentity?: typeof promptIdentity;
  };
  parseSetupArgs = mod.parseSetupArgs;
  // Ausentes até a implementação existir: o teste falha na asserção, não na importação.
  if (mod.resolveIdentity) resolveIdentity = mod.resolveIdentity;
  if (mod.promptIdentity) promptIdentity = mod.promptIdentity;
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

const CONFIGURED_BOT: Identity = { mode: 'bot', login: 'conta-salva', keychainService: 'item-salvo' };

describe('AI-14 resolveIdentity, sem argumentos reaproveita a identidade configurada', () => {
  it('AI-14 sem argumentos e com identidade configurada devolve a configurada, mesmo sem terminal', () => {
    expect(resolveIdentity([], CONFIGURED_BOT, false)).toEqual({ identity: CONFIGURED_BOT });
    expect(resolveIdentity([], { mode: 'self' }, true)).toEqual({ identity: { mode: 'self' } });
  });

  it('AI-14 sem argumentos, sem identidade e com terminal interativo pede para perguntar', () => {
    expect(resolveIdentity([], undefined, true)).toEqual({ ask: true });
  });

  it('AI-14 sem argumentos, sem identidade e sem terminal interativo devolve erro com o uso', () => {
    const resolved = resolveIdentity([], undefined, false);

    const message = 'error' in resolved ? resolved.error : '';

    expect('error' in resolved).toBe(true);
    expect(message).toContain(USAGE_BOT);
    expect(message).toContain(USAGE_SELF);
  });

  it('AI-14 com argumentos vale o resultado do parseSetupArgs e a identidade configurada é ignorada', () => {
    const argv = ['--identity', 'bot', '--login', 'minha-conta'];

    expect(resolveIdentity(argv, CONFIGURED_BOT, true)).toEqual(parseSetupArgs(argv));
    expect(resolveIdentity(argv, CONFIGURED_BOT, true)).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' },
    });
    expect(resolveIdentity(['--identity', 'self'], CONFIGURED_BOT, false)).toEqual({ identity: { mode: 'self' } });
  });

  it('AI-14 com argumento inválido devolve o erro do parseSetupArgs, mesmo com identidade configurada', () => {
    const argv = ['--identity', 'admin'];

    const resolved = resolveIdentity(argv, CONFIGURED_BOT, true);

    expect('error' in resolved).toBe(true);
    expect(resolved).toEqual(parseSetupArgs(argv));
  });
});

// Pergunta falsa: devolve as respostas da lista, na ordem, e registra o texto de cada pergunta.
// Pergunta além da lista lança erro, para o teste pegar pergunta a mais.
function fakeAsk(answers: string[]): { ask: Ask; questions: string[] } {
  const questions: string[] = [];
  const ask: Ask = (question) => {
    questions.push(question);
    const answer = answers[questions.length - 1];
    if (answer === undefined) return Promise.reject(new Error(`pergunta inesperada: ${question}`));
    return Promise.resolve(answer);
  };
  return { ask, questions };
}

describe('AI-14 promptIdentity, o modo', () => {
  it.each(['', '1', 'bot', ' BOT ', 'Bot'])('AI-14 a resposta %j ao modo escolhe o modo bot', async (mode) => {
    const { ask, questions } = fakeAsk([mode, 'minha-conta', '']);

    const result = await promptIdentity(ask);

    expect(result).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' },
    });
    expect(questions).toHaveLength(3);
  });

  it.each(['2', 'self', ' SELF ', 'Self'])(
    'AI-14 a resposta %j ao modo escolhe o modo self, sem mais perguntas',
    async (mode) => {
      const { ask, questions } = fakeAsk([mode]);

      const result = await promptIdentity(ask);

      expect(result).toEqual({ identity: { mode: 'self' } });
      expect(questions).toHaveLength(1);
    },
  );

  it.each(['3', 'admin', 'bots'])('AI-14 a resposta %j ao modo devolve erro', async (mode) => {
    const { ask } = fakeAsk([mode, 'minha-conta', '']);

    const result = await promptIdentity(ask);

    expect('error' in result).toBe(true);
  });
});

describe('AI-14 promptIdentity, o login e o item do chaveiro', () => {
  it.each(['a', 'a-b', '1abc', 'a'.repeat(39)])(
    'AI-14 login %j válido segue para a pergunta do chaveiro',
    async (login) => {
      const { ask, questions } = fakeAsk(['bot', login, '']);

      const result = await promptIdentity(ask);

      expect(result).toEqual({
        identity: {
          mode: 'bot',
          login,
          keychainService: `casecellshop-${login}`,
        },
      });
      expect(questions).toHaveLength(3);
    },
  );

  it.each(['-x', 'x-', 'a--b', 'a b', 'a_b', 'a.b', 'a'.repeat(40), ''])(
    'AI-14 login %j inválido devolve erro, sem perguntar o chaveiro',
    async (login) => {
      const { ask, questions } = fakeAsk(['bot', login, '']);

      const result = await promptIdentity(ask);

      expect('error' in result).toBe(true);
      expect(questions).toHaveLength(2);
    },
  );

  it('AI-14 a pergunta do chaveiro sugere o item padrão casecellshop-<login>', async () => {
    const { ask, questions } = fakeAsk(['bot', 'minha-conta', '']);

    await promptIdentity(ask);

    expect(questions).toHaveLength(3);
    expect(questions[2]).toContain('casecellshop-minha-conta');
  });

  it('AI-14 resposta vazia ao chaveiro usa o item padrão', async () => {
    const { ask } = fakeAsk(['bot', 'minha-conta', '']);

    expect(await promptIdentity(ask)).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' },
    });
  });

  it('AI-14 outra resposta ao chaveiro usa esse item', async () => {
    const { ask } = fakeAsk(['bot', 'minha-conta', 'item-x']);

    expect(await promptIdentity(ask)).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'item-x' },
    });
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

  it('AI-14 sem argumentos reaproveita a identidade já configurada no clone e sai com 0', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    const result = runScript(dir, 'setup-local.ts', [], { env: isolatedEnv() });

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(USAGE_BOT);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBeUndefined();
  }, 30_000);
});
