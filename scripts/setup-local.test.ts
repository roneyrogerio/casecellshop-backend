import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDirs, git } from '../test/helpers/git-sandbox.ts';
import { isolatedEnv, localConfig, makeRepo, makeScriptsSandbox, runScript } from '../test/helpers/identity-sandbox.ts';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };
type Parsed = { identity: Identity; tokenStore?: 'system' | 'file' } | { error: string };

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
let keychainHelp: (status: 'missing-tool' | 'no-service') => string = () => '';

type BotIdentity = Extract<Identity, { mode: 'bot' }>;
type TokenCheck =
  | { result: 'missing' }
  | { result: 'valid'; login: string }
  | { result: 'refused' }
  | { result: 'unreachable' };
interface SetupBotDeps {
  readToken: () => string | undefined;
  checkToken: (token: string | undefined) => Promise<TokenCheck>;
  keychainStatus: () => 'ok' | 'missing-tool' | 'no-service';
  storeToken: (mode: 'update' | 'replace') => Promise<boolean>;
  confirm: (message: string) => Promise<boolean>;
  interactive: boolean;
  installHelper: () => void;
  log: (message: string) => void;
}
// Sentinela: sem a função exportada, o teste falha na asserção do retorno, não na importação.
let setupBot: (
  root: string,
  identity: BotIdentity,
  store: 'system' | 'file',
  deps: SetupBotDeps,
) => Promise<boolean> = () => Promise.resolve(undefined as unknown as boolean);
let configureIdentity: (
  root: string,
  identity: Identity,
  store: 'system' | 'file',
  deps: { setupBot: () => Promise<boolean> },
) => Promise<boolean> = () => Promise.resolve(undefined as unknown as boolean);

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
// Só importa se a guarda existir: o módulo antigo executava o setup inteiro no import.
beforeAll(async () => {
  if (!runsOnlyWhenDirect()) return;
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    parseSetupArgs: typeof parseSetupArgs;
    resolveIdentity?: typeof resolveIdentity;
    promptIdentity?: typeof promptIdentity;
    keychainHelp?: typeof keychainHelp;
    setupBot?: typeof setupBot;
    configureIdentity?: typeof configureIdentity;
  };
  parseSetupArgs = mod.parseSetupArgs;
  // Ausentes até a implementação existir: o teste falha na asserção, não na importação.
  if (mod.resolveIdentity) resolveIdentity = mod.resolveIdentity;
  if (mod.promptIdentity) promptIdentity = mod.promptIdentity;
  if (mod.keychainHelp) keychainHelp = mod.keychainHelp;
  if (mod.setupBot) setupBot = mod.setupBot;
  if (mod.configureIdentity) configureIdentity = mod.configureIdentity;
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

// Na sessão do Claude Code na nuvem a identidade é a conta do ambiente: o setup não se aplica e não grava nada.
describe('AI-14 o CLI do setup:local na nuvem (CLAUDE_CODE_REMOTE=true)', () => {
  const cloudEnv = (): Record<string, string> => isolatedEnv({ CLAUDE_CODE_REMOTE: 'true' });

  function savedKeys(dir: string): string {
    const result = spawnSync('git', ['config', '--local', '--get-regexp', '^casecellshop\\.'], {
      cwd: dir,
      encoding: 'utf8',
      env: isolatedEnv(),
    });
    return result.status === 0 ? result.stdout.trim() : '';
  }

  it.each([
    ['sem argumentos', []],
    ['com --identity self', ['--identity', 'self']],
    ['com --identity bot --login', ['--identity', 'bot', '--login', 'minha-conta']],
  ] as [string, string[]][])(
    'AI-14 na nuvem, %s, diz que a identidade vem da conta do ambiente, sai com 0 e não grava nenhuma chave casecellshop.*',
    (_label, args) => {
      expect(runsOnlyWhenDirect()).toBe(true);
      const dir = makeScriptsSandbox();

      const result = runScript(dir, 'setup-local.ts', args, { env: cloudEnv() });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(0);
      expect(output).toMatch(/nuvem/i);
      expect(output).toMatch(/\/web-setup|GitHub App/);
      expect(output).not.toContain(USAGE_BOT);
      expect(savedKeys(dir)).toBe('');
      expect(localConfig(dir, 'casecellshop.identity')).toBeUndefined();
      expect(localConfig(dir, 'casecellshop.botLogin')).toBeUndefined();
    },
    30_000,
  );

  it('AI-14 controle: sem a variável, --identity self continua gravando o modo no clone', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'setup-local.ts', ['--identity', 'self'], { env: isolatedEnv() });

    expect(result.status).toBe(0);
    expect(savedKeys(dir)).toContain('casecellshop.identity self');
  }, 30_000);
});

const USAGE_TOKEN_STORE = '--token-store file';

describe('AI-14 parseSetupArgs, --token-store', () => {
  const BOT_ARGS = ['--identity', 'bot', '--login', 'minha-conta'];
  const BOT_IDENTITY: Identity = {
    mode: 'bot',
    login: 'minha-conta',
    keychainService: 'casecellshop-minha-conta',
  };

  it('AI-14 --token-store file no modo bot devolve tokenStore file', () => {
    expect(parseSetupArgs([...BOT_ARGS, '--token-store', 'file'])).toEqual({
      identity: BOT_IDENTITY,
      tokenStore: 'file',
    });
  });

  it('AI-14 --token-store system no modo bot devolve tokenStore system', () => {
    expect(parseSetupArgs([...BOT_ARGS, '--token-store', 'system'])).toEqual({
      identity: BOT_IDENTITY,
      tokenStore: 'system',
    });
  });

  it('AI-14 a forma --token-store=file também vale, em qualquer ordem', () => {
    expect(parseSetupArgs(['--token-store=file', ...BOT_ARGS, '--keychain=item-x'])).toEqual({
      identity: { mode: 'bot', login: 'minha-conta', keychainService: 'item-x' },
      tokenStore: 'file',
    });
  });

  // Controle: sem o argumento o resultado não ganha a chave, para não mudar o que já valia.
  it('AI-14 sem --token-store o resultado é exatamente { identity }', () => {
    const parsed = parseSetupArgs(BOT_ARGS);

    expect(parsed).toEqual({ identity: BOT_IDENTITY });
    expect('tokenStore' in parsed).toBe(false);
  });

  it('AI-14 --token-store no modo self devolve erro com o uso', () => {
    expectUsageError(['--identity', 'self', '--token-store', 'file']);
    expectUsageError(['--identity', 'self', '--token-store', 'system']);
  });

  it('AI-14 --token-store com outro valor ou sem valor devolve erro com o uso', () => {
    expectUsageError([...BOT_ARGS, '--token-store', 'arquivo']);
    expectUsageError([...BOT_ARGS, '--token-store', '']);
    expectUsageError([...BOT_ARGS, '--token-store']);
  });

  it('AI-14 o texto de uso cita --token-store file', () => {
    const parsed = parseSetupArgs([]);

    expect('error' in parsed ? parsed.error : '').toContain(USAGE_TOKEN_STORE);
  });

  it('AI-14 resolveIdentity repassa o --token-store do parseSetupArgs', () => {
    const argv = [...BOT_ARGS, '--token-store', 'file'];

    expect(resolveIdentity(argv, undefined, false)).toEqual({ identity: BOT_IDENTITY, tokenStore: 'file' });
    expect(resolveIdentity(argv, undefined, false)).toEqual(parseSetupArgs(argv));
  });

  it('AI-14 o CLI com --identity self e --token-store file mostra o uso, sai com código diferente de 0 e não grava nada', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();

    const result = runScript(dir, 'setup-local.ts', ['--identity', 'self', '--token-store', 'file']);

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
    expect(`${result.stdout}${result.stderr}`).toContain(USAGE_TOKEN_STORE);
    expect(localConfig(dir, 'casecellshop.identity')).toBeUndefined();
    expect(localConfig(dir, 'casecellshop.tokenStore')).toBeUndefined();
  }, 30_000);
});

describe('AI-14 keychainHelp', () => {
  it('AI-14 missing-tool cita o pacote libsecret-tools (Debian e Ubuntu)', () => {
    const help = keychainHelp('missing-tool');

    expect(help).toContain('libsecret-tools');
    expect(help).toMatch(/Debian/);
    expect(help).toMatch(/Ubuntu/);
  });

  it('AI-14 no-service cita o modo self e o arquivo, e avisa que o arquivo não é cifrado', () => {
    const help = keychainHelp('no-service');

    expect(help).toContain('--identity self');
    expect(help).toContain('--token-store file');
    expect(help).toMatch(/não (é|fica|está) cifrad/i);
  });

  it('AI-14 no-service não manda instalar o pacote (controle: as duas ajudas são diferentes)', () => {
    expect(keychainHelp('no-service')).not.toBe(keychainHelp('missing-tool'));
    expect(keychainHelp('missing-tool')).not.toContain('--token-store file');
  });
});

// O setup do modo bot, com todas as dependências injetadas: nada aqui toca o chaveiro, a rede ou o terminal.
// Os quatro casos da conferência do token (AI-14): válido da conta, ausente ou recusado, de outra conta, sem conferência.
const BOT_SETUP: BotIdentity = { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' };
const VALID_OWN: TokenCheck = { result: 'valid', login: 'minha-conta' };
const VALID_OTHER: TokenCheck = { result: 'valid', login: 'outra-conta' };
const MISSING: TokenCheck = { result: 'missing' };
const REFUSED: TokenCheck = { result: 'refused' };
const UNREACHABLE: TokenCheck = { result: 'unreachable' };

interface BotRun {
  deps: SetupBotDeps;
  checkToken: ReturnType<typeof vi.fn<SetupBotDeps['checkToken']>>;
  storeToken: ReturnType<typeof vi.fn<SetupBotDeps['storeToken']>>;
  confirm: ReturnType<typeof vi.fn<SetupBotDeps['confirm']>>;
  installHelper: ReturnType<typeof vi.fn<SetupBotDeps['installHelper']>>;
  keychainStatus: ReturnType<typeof vi.fn<SetupBotDeps['keychainStatus']>>;
  order: string[];
  output: () => string;
}

// checks: respostas da conferência, na ordem (a primeira é a conferência inicial, a segunda é a reconferência).
// Antes do storeToken, o token guardado é `stored`; depois, vale 'token-novo', para provar que a reconferência relê o token.
function botSetup(
  checks: TokenCheck[],
  options: {
    stored?: string;
    storeResult?: boolean;
    confirmResult?: boolean;
    interactive?: boolean;
    keychain?: 'ok' | 'missing-tool' | 'no-service';
  } = {},
): BotRun {
  const order: string[] = [];
  const logs: string[] = [];
  const queue = [...checks];
  let replaced = false;
  const checkToken = vi.fn<SetupBotDeps['checkToken']>(() => {
    const next = queue.shift();
    return next ? Promise.resolve(next) : Promise.reject(new Error('conferência inesperada'));
  });
  const storeToken = vi.fn<SetupBotDeps['storeToken']>((mode) => {
    order.push(`storeToken:${mode}`);
    replaced = options.storeResult ?? true;
    return Promise.resolve(options.storeResult ?? true);
  });
  const confirm = vi.fn<SetupBotDeps['confirm']>(() => Promise.resolve(options.confirmResult ?? false));
  const installHelper = vi.fn<SetupBotDeps['installHelper']>(() => {
    order.push('installHelper');
  });
  const keychainStatus = vi.fn<SetupBotDeps['keychainStatus']>(() => options.keychain ?? 'ok');
  const deps: SetupBotDeps = {
    readToken: () => (replaced ? 'token-novo' : options.stored),
    checkToken,
    keychainStatus,
    storeToken,
    confirm,
    interactive: options.interactive ?? true,
    installHelper,
    log: (message) => logs.push(message),
  };
  return { deps, checkToken, storeToken, confirm, installHelper, keychainStatus, order, output: () => logs.join('\n') };
}

describe('AI-14 setupBot, token válido da conta configurada', () => {
  it('AI-14 token válido da conta configurada instala o helper sem tocar no token', async () => {
    const run = botSetup([VALID_OWN], { stored: 'token-bom' });

    const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

    expect(ok).toBe(true);
    expect(run.checkToken).toHaveBeenCalledWith('token-bom');
    expect(run.storeToken).not.toHaveBeenCalled();
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.installHelper).toHaveBeenCalledTimes(1);
  });
});

describe('AI-14 setupBot, token ausente ou recusado', () => {
  it.each([
    ['ausente', MISSING, undefined],
    ['recusado (401)', REFUSED, 'token-vencido'],
  ] as [string, TokenCheck, string | undefined][])(
    'AI-14 token %s: atualiza no lugar (update), reconfere com o token novo e só então instala o helper',
    async (_label, first, stored) => {
      const run = botSetup([first, VALID_OWN], { stored });

      const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

      expect(ok).toBe(true);
      expect(run.storeToken).toHaveBeenCalledTimes(1);
      expect(run.storeToken).toHaveBeenCalledWith('update');
      expect(run.confirm).not.toHaveBeenCalled();
      expect(run.checkToken).toHaveBeenCalledTimes(2);
      expect(run.checkToken).toHaveBeenNthCalledWith(1, stored);
      expect(run.checkToken).toHaveBeenNthCalledWith(2, 'token-novo');
      expect(run.installHelper).toHaveBeenCalledTimes(1);
      expect(run.order).toEqual(['storeToken:update', 'installHelper']);
    },
  );

  it.each([
    ['ausente', MISSING],
    ['recusado (401)', REFUSED],
  ] as [string, TokenCheck][])(
    'AI-14 token %s: se o storeToken falha (prompt cancelado), devolve false e não instala o helper',
    async (_label, first) => {
      const run = botSetup([first], { storeResult: false });

      const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

      expect(ok).toBe(false);
      expect(run.storeToken).toHaveBeenCalledWith('update');
      expect(run.installHelper).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['ausente', 'recusada (401)', MISSING, REFUSED],
    ['recusado (401)', 'recusada (401)', REFUSED, REFUSED],
    ['ausente', 'ausente', MISSING, MISSING],
    ['recusado (401)', 'sem conferência', REFUSED, UNREACHABLE],
    ['ausente', 'de outra conta', MISSING, VALID_OTHER],
  ] as [string, string, TokenCheck, TokenCheck][])(
    'AI-14 token %s: se a reconferência dá %s, devolve false e não instala o helper',
    async (_label, _secondLabel, first, second) => {
      const run = botSetup([first, second]);

      const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

      expect(ok).toBe(false);
      expect(run.storeToken).toHaveBeenCalledWith('update');
      expect(run.checkToken).toHaveBeenCalledTimes(2);
      expect(run.installHelper).not.toHaveBeenCalled();
    },
  );

  it('AI-14 token recusado: a mensagem diz que o token foi recusado', async () => {
    const run = botSetup([REFUSED, VALID_OWN], { stored: 'token-vencido' });

    await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

    expect(run.output()).toMatch(/recusad/i);
  });
});

describe('AI-14 setupBot, token de outra conta', () => {
  it('AI-14 token de outra conta com terminal: pergunta citando as duas contas e, se a resposta é não, sai sem trocar nada', async () => {
    const run = botSetup([VALID_OTHER], { stored: 'token-de-outra', interactive: true, confirmResult: false });

    const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

    expect(ok).toBe(false);
    expect(run.confirm).toHaveBeenCalledTimes(1);
    const question = run.confirm.mock.calls[0]?.[0] ?? '';
    expect(question).toContain('outra-conta');
    expect(question).toContain('minha-conta');
    expect(run.storeToken).not.toHaveBeenCalled();
    expect(run.installHelper).not.toHaveBeenCalled();
  });

  it('AI-14 token de outra conta com terminal: se a resposta é sim, troca (replace), reconfere e só então instala o helper', async () => {
    const run = botSetup([VALID_OTHER, VALID_OWN], {
      stored: 'token-de-outra',
      interactive: true,
      confirmResult: true,
    });

    const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

    expect(ok).toBe(true);
    expect(run.confirm).toHaveBeenCalledTimes(1);
    expect(run.storeToken).toHaveBeenCalledTimes(1);
    expect(run.storeToken).toHaveBeenCalledWith('replace');
    expect(run.checkToken).toHaveBeenNthCalledWith(2, 'token-novo');
    expect(run.order).toEqual(['storeToken:replace', 'installHelper']);
  });

  it('AI-14 token de outra conta, confirmado: se o storeToken falha ou a reconferência não é da conta, devolve false sem instalar o helper', async () => {
    const storeFails = botSetup([VALID_OTHER], { interactive: true, confirmResult: true, storeResult: false });
    const stillOther = botSetup([VALID_OTHER, VALID_OTHER], { interactive: true, confirmResult: true });

    expect(await setupBot('/nao/usado', BOT_SETUP, 'system', storeFails.deps)).toBe(false);
    expect(await setupBot('/nao/usado', BOT_SETUP, 'system', stillOther.deps)).toBe(false);

    expect(storeFails.storeToken).toHaveBeenCalledWith('replace');
    expect(storeFails.installHelper).not.toHaveBeenCalled();
    expect(stillOther.installHelper).not.toHaveBeenCalled();
  });

  it('AI-14 token de outra conta sem terminal: devolve false sem perguntar nem trocar, e a mensagem sugere --keychain', async () => {
    const run = botSetup([VALID_OTHER], { stored: 'token-de-outra', interactive: false, confirmResult: true });

    const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

    expect(ok).toBe(false);
    expect(run.confirm).not.toHaveBeenCalled();
    expect(run.storeToken).not.toHaveBeenCalled();
    expect(run.installHelper).not.toHaveBeenCalled();
    expect(run.output()).toContain('--keychain');
  });
});

describe('AI-14 setupBot, sem conferência possível', () => {
  it.each([true, false])(
    'AI-14 sem rede ou com erro da API (interactive=%s): não mexe no chaveiro, não instala o helper e diz que não deu para conferir',
    async (interactive) => {
      const run = botSetup([UNREACHABLE], { stored: 'token-talvez-bom', interactive, confirmResult: true });

      const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

      expect(ok).toBe(false);
      expect(run.storeToken).not.toHaveBeenCalled();
      expect(run.confirm).not.toHaveBeenCalled();
      expect(run.installHelper).not.toHaveBeenCalled();
      expect(run.checkToken).toHaveBeenCalledTimes(1);
      expect(run.output()).toContain('conferir');
    },
  );
});

describe('AI-14 setupBot, chaveiro do sistema', () => {
  it.each([
    ['missing-tool', 'libsecret-tools'],
    ['no-service', '--token-store file'],
  ] as ['missing-tool' | 'no-service', string][])(
    'AI-14 armazenamento do sistema com o chaveiro %s e token ausente: devolve false sem pedir o token e mostra a ajuda',
    async (keychain, expected) => {
      const run = botSetup([MISSING], { keychain });

      const ok = await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps);

      expect(ok).toBe(false);
      expect(run.keychainStatus).toHaveBeenCalled();
      expect(run.storeToken).not.toHaveBeenCalled();
      expect(run.installHelper).not.toHaveBeenCalled();
      expect(run.output()).toContain(expected);
    },
  );

  it('AI-14 armazenamento em arquivo nem consulta o chaveiro: o token ausente é pedido mesmo com o chaveiro quebrado', async () => {
    const run = botSetup([MISSING, VALID_OWN], { keychain: 'no-service' });

    const ok = await setupBot('/nao/usado', BOT_SETUP, 'file', run.deps);

    expect(ok).toBe(true);
    expect(run.keychainStatus).not.toHaveBeenCalled();
    expect(run.storeToken).toHaveBeenCalledWith('update');
    expect(run.order).toEqual(['storeToken:update', 'installHelper']);
  });

  // Controle: com o chaveiro funcionando, o mesmo token ausente chega ao storeToken.
  it('AI-14 armazenamento do sistema com o chaveiro ok e token ausente chega ao storeToken (controle)', async () => {
    const run = botSetup([MISSING, VALID_OWN], { keychain: 'ok' });

    expect(await setupBot('/nao/usado', BOT_SETUP, 'system', run.deps)).toBe(true);
    expect(run.storeToken).toHaveBeenCalledWith('update');
  });
});

// O setup não pode deixar o clone apontando para um item do chaveiro que o setupBot recusou (A11):
// a identidade e o armazenamento só valem se o setup do bot deu certo, senão volta o que havia, inclusive o que faltava.
describe('AI-14 configureIdentity, a configuração só fica se o setup do bot deu certo', () => {
  const botOf = (login: string, keychainService: string): Identity => ({ mode: 'bot', login, keychainService });
  const setupBotResult = (result: boolean) => ({ setupBot: () => Promise.resolve(result) });
  const keys = ['identity', 'botLogin', 'keychainService', 'tokenStore'] as const;
  const saved = (dir: string): Record<string, string | undefined> =>
    Object.fromEntries(keys.map((key) => [key, localConfig(dir, `casecellshop.${key}`)]));

  it('AI-14 setupBot que devolve false mantém o modo self que já estava no clone e devolve false', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    const ok = await configureIdentity(dir, botOf('outra-conta', 'item-da-outra'), 'system', setupBotResult(false));

    expect(ok).toBe(false);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBeUndefined();
    expect(localConfig(dir, 'casecellshop.keychainService')).toBeUndefined();
  });

  it('AI-14 setupBot que devolve false mantém o bot e o item anteriores', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'a');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-a');

    const ok = await configureIdentity(dir, botOf('b', 'item-b'), 'system', setupBotResult(false));

    expect(ok).toBe(false);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('bot');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBe('a');
    expect(localConfig(dir, 'casecellshop.keychainService')).toBe('item-a');
  });

  it('AI-14 setupBot que devolve true troca para o bot e o item novos e devolve true', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'a');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-a');

    const ok = await configureIdentity(dir, botOf('b', 'item-b'), 'system', setupBotResult(true));

    expect(ok).toBe(true);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('bot');
    expect(localConfig(dir, 'casecellshop.botLogin')).toBe('b');
    expect(localConfig(dir, 'casecellshop.keychainService')).toBe('item-b');
  });

  // O setupBot rejeita quando a pessoa cancela com Ctrl+C no prompt ou o arquivo do token não grava (A11).
  // A função pode rejeitar ou devolver false; nos dois casos o clone volta ao que era.
  const failed = async (dir: string, identity: Identity, store: 'system' | 'file'): Promise<void> => {
    const outcome = await configureIdentity(dir, identity, store, {
      setupBot: () => Promise.reject(new Error('x')),
    }).then(
      (ok) => ({ rejected: false, ok }),
      () => ({ rejected: true, ok: undefined }),
    );
    expect(outcome.rejected || outcome.ok === false).toBe(true);
  };

  it('AI-14 setupBot que rejeita restaura o modo self que já estava no clone', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    await failed(dir, botOf('outra-conta', 'item-da-outra'), 'system');

    expect(saved(dir)).toEqual({ identity: 'self', botLogin: undefined, keychainService: undefined, tokenStore: undefined });
  });

  it('AI-14 setupBot que rejeita mantém o bot a e o item-a anteriores', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'bot');
    git(dir, 'config', '--local', 'casecellshop.botLogin', 'a');
    git(dir, 'config', '--local', 'casecellshop.keychainService', 'item-a');

    await failed(dir, botOf('b', 'item-b'), 'file');

    expect(saved(dir)).toEqual({ identity: 'bot', botLogin: 'a', keychainService: 'item-a', tokenStore: undefined });
  });

  it('AI-14 setupBot que rejeita, sem configuração antes, não deixa nenhuma chave casecellshop.*', async () => {
    const dir = makeRepo();

    await failed(dir, botOf('b', 'item-b'), 'system');

    expect(saved(dir)).toEqual({ identity: undefined, botLogin: undefined, keychainService: undefined, tokenStore: undefined });
  });

  it('AI-14 sem configuração antes e com setupBot false não sobra nenhuma chave casecellshop.*', async () => {
    const dir = makeRepo();

    const ok = await configureIdentity(dir, botOf('b', 'item-b'), 'file', setupBotResult(false));

    expect(ok).toBe(false);
    expect(saved(dir)).toEqual({ identity: undefined, botLogin: undefined, keychainService: undefined, tokenStore: undefined });
  });

  it('AI-14 o armazenamento do token também volta ao que era quando o setupBot devolve false', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');

    await configureIdentity(dir, botOf('b', 'item-b'), 'file', setupBotResult(false));

    expect(saved(dir)).toEqual({ identity: 'self', botLogin: undefined, keychainService: undefined, tokenStore: undefined });
  });

  it('AI-14 setupBot true com armazenamento em arquivo grava o tokenStore file', async () => {
    const dir = makeRepo();

    const ok = await configureIdentity(dir, botOf('b', 'item-b'), 'file', setupBotResult(true));

    expect(ok).toBe(true);
    expect(saved(dir)).toEqual({ identity: 'bot', botLogin: 'b', keychainService: 'item-b', tokenStore: 'file' });
  });

  // O setupBot lê o token pela configuração do clone (readToken): quando ele roda, a identidade nova já precisa estar gravada.
  it('AI-14 quando o setupBot roda, a identidade e o armazenamento novos já estão no git config', async () => {
    const dir = makeRepo();
    git(dir, 'config', '--local', 'casecellshop.identity', 'self');
    let during: Record<string, string | undefined> = {};

    await configureIdentity(dir, botOf('b', 'item-b'), 'file', {
      setupBot: () => {
        during = saved(dir);
        return Promise.resolve(false);
      },
    });

    expect(during).toEqual({ identity: 'bot', botLogin: 'b', keychainService: 'item-b', tokenStore: 'file' });
  });
});

// O CLI de verdade, numa cópia dos scripts: o modo self tira do clone o helper do projeto (A3), os dois valores.
describe('AI-14 o CLI do setup:local no modo self com o helper do projeto instalado', () => {
  it('AI-14 --identity self remove o valor vazio e o helper do projeto do credential.helper local e grava self', () => {
    expect(runsOnlyWhenDirect()).toBe(true);
    const dir = makeScriptsSandbox();
    git(dir, 'config', '--local', '--add', 'credential.helper', '');
    git(dir, 'config', '--local', '--add', 'credential.helper', `!node "${join(dir, 'scripts', 'git-credential-bot.ts')}"`);
    const helpers = () =>
      spawnSync('git', ['config', '--local', '--get-all', 'credential.helper'], { cwd: dir, encoding: 'utf8', env: isolatedEnv() });
    expect(helpers().stdout).toContain('git-credential-bot');

    const result = runScript(dir, 'setup-local.ts', ['--identity', 'self'], { env: isolatedEnv() });

    expect(result.status).toBe(0);
    expect(helpers().stdout.trim()).toBe('');
    expect(helpers().status).not.toBe(0);
    expect(localConfig(dir, 'casecellshop.identity')).toBe('self');
  }, 30_000);
});
