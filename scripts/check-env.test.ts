import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Identity = { mode: 'bot'; login: string; keychainService: string } | { mode: 'self' };

interface Facts {
  remote: boolean;
  nodeVersion: string;
  nvmrc: string;
  depsInstalled: boolean;
  dockerRunning: boolean;
  originUrl: string;
  credentialHelperIsBot: boolean;
  githubLogin: string | null;
  identity: Identity | undefined;
  mcpRegistered: boolean;
  commitHookInstalled: boolean;
  tokenStore?: 'system' | 'file';
  keychainStatus?: 'ok' | 'missing-tool' | 'no-service';
}

interface Diagnosis {
  item: string;
  ok: boolean;
  fix?: string;
  notice?: boolean;
}

type GitSetupFacts = Pick<Facts, 'remote' | 'credentialHelperIsBot' | 'identity'> & { tokenPresent: boolean };
type GitSetupPlan = 'configure' | 'unconfigure' | 'skip' | 'explain';

let diagnose: (facts: Facts) => Diagnosis[];
let planGitSetup: (facts: GitSetupFacts) => GitSetupPlan;
let report: (results: Diagnosis[]) => string;

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(import.meta.dirname, 'check-env.ts')).href)) as {
    diagnose: typeof diagnose;
    planGitSetup: typeof planGitSetup;
    report: typeof report;
  };
  diagnose = mod.diagnose;
  planGitSetup = mod.planGitSetup;
  report = mod.report;
});

const BOT_IDENTITY: Identity = { mode: 'bot', login: 'minha-conta', keychainService: 'casecellshop-minha-conta' };
const SELF_IDENTITY: Identity = { mode: 'self' };

// Máquina local com tudo certo: é o controle negativo de cada teste.
const LOCAL_OK: Facts = {
  remote: false,
  nodeVersion: 'v26.13.0',
  nvmrc: '26.13.0',
  depsInstalled: true,
  dockerRunning: true,
  originUrl: 'https://github.com/roneyrogerio/casecellshop-backend.git',
  credentialHelperIsBot: true,
  githubLogin: 'minha-conta',
  identity: BOT_IDENTITY,
  mcpRegistered: true,
  commitHookInstalled: true,
};

const REMOTE_OK: Facts = {
  ...LOCAL_OK,
  remote: true,
  credentialHelperIsBot: false,
  mcpRegistered: false,
  commitHookInstalled: false,
};

function failures(facts: Facts): Diagnosis[] {
  return diagnose(facts).filter((entry) => !entry.ok);
}

describe('AI-09 diagnóstico do ambiente, local', () => {
  it('AI-09 com tudo certo nenhum item falha', () => {
    expect(failures(LOCAL_OK)).toEqual([]);
  });

  it('AI-09 major do Node diferente do .nvmrc falha, com correção', () => {
    const found = failures({ ...LOCAL_OK, nodeVersion: 'v24.12.0' });

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => (entry.fix ?? '') !== '')).toBe(true);
  });

  it('AI-09 só o major conta: menor ou patch diferentes do .nvmrc não falham', () => {
    expect(failures({ ...LOCAL_OK, nodeVersion: 'v26.1.0' })).toEqual([]);
  });

  it.each([
    ['dependências não instaladas', { depsInstalled: false }],
    ['Docker parado', { dockerRunning: false }],
    ['origin em SSH', { originUrl: 'git@github.com:roneyrogerio/casecellshop-backend.git' }],
    ['origin em HTTP', { originUrl: 'http://github.com/roneyrogerio/casecellshop-backend.git' }],
    ['origin em outro host', { originUrl: 'https://gitlab.com/roneyrogerio/casecellshop-backend.git' }],
    ['login do token ausente (null)', { githubLogin: null }],
    ['login do token diferente do login configurado', { githubLogin: 'roneyrogerio' }],
  ] as [string, Partial<Facts>][])('AI-09 %s falha, com correção', (_label, change) => {
    const found = failures({ ...LOCAL_OK, ...change });

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => (entry.fix ?? '') !== '')).toBe(true);
  });

  it('AI-09 no modo bot, credencial do git que não é a do bot falha e a correção cita npm run setup:local', () => {
    const found = failures({ ...LOCAL_OK, credentialHelperIsBot: false });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
  });

  it('AI-09 MCP do GitHub não registrado falha e a correção cita npm run setup:local', () => {
    const found = failures({ ...LOCAL_OK, mcpRegistered: false });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
  });

  it('AI-09 hook commit-msg não instalado falha e a correção cita npm run setup:local', () => {
    const found = failures({ ...LOCAL_OK, commitHookInstalled: false });

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => (entry.fix ?? '') !== '')).toBe(true);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
  });

  it('AI-09 hook commit-msg instalado não gera falha (controle)', () => {
    expect(failures({ ...LOCAL_OK, commitHookInstalled: true })).toEqual([]);
  });

  it('AI-09 cada falha corrige só o que está errado: dois defeitos geram mais falhas que um', () => {
    const one = failures({ ...LOCAL_OK, dockerRunning: false });
    const two = failures({
      ...LOCAL_OK,
      dockerRunning: false,
      depsInstalled: false,
    });

    expect(one.length).toBeGreaterThan(0);
    expect(two.length).toBeGreaterThan(one.length);
  });
});

describe('AI-09 diagnóstico do ambiente, na nuvem', () => {
  it('AI-09 com tudo certo na nuvem nenhum item falha', () => {
    expect(failures(REMOTE_OK)).toEqual([]);
  });

  it('AI-09 na nuvem a credencial do git e o MCP não entram no diagnóstico', () => {
    const found = failures({
      ...REMOTE_OK,
      credentialHelperIsBot: false,
      mcpRegistered: false,
    });

    expect(found).toEqual([]);
  });

  it('AI-09 na nuvem o hook commit-msg não instalado não entra no diagnóstico', () => {
    expect(failures({ ...REMOTE_OK, commitHookInstalled: false })).toEqual([]);
    expect(diagnose({ ...REMOTE_OK, commitHookInstalled: false }).some((entry) => /commit-msg|commitlint/i.test(entry.item))).toBe(
      false,
    );
  });

  it('AI-09 na nuvem a falha do login do token cita /web-setup', () => {
    const found = failures({ ...REMOTE_OK, githubLogin: null });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('/web-setup'))).toBe(true);
  });

  it('AI-09 na nuvem a falha de Node, dependências, Docker ou origin continua aparecendo', () => {
    expect(failures({ ...REMOTE_OK, nodeVersion: 'v24.12.0' }).length).toBeGreaterThan(0);
    expect(failures({ ...REMOTE_OK, depsInstalled: false }).length).toBeGreaterThan(0);
    expect(failures({ ...REMOTE_OK, dockerRunning: false }).length).toBeGreaterThan(0);
    expect(failures({ ...REMOTE_OK, originUrl: 'git@github.com:a/b.git' }).length).toBeGreaterThan(0);
  });
});

describe('AI-09 configuração da credencial do git pelo hook', () => {
  const plan = (change: Partial<GitSetupFacts>): GitSetupPlan =>
    planGitSetup({ remote: false, identity: BOT_IDENTITY, tokenPresent: true, credentialHelperIsBot: false, ...change });

  it('AI-09 na nuvem o hook não mexe na credencial, com ou sem token, em qualquer modo', () => {
    for (const identity of [BOT_IDENTITY, SELF_IDENTITY, undefined]) {
      expect(plan({ remote: true, identity, tokenPresent: true })).toBe('skip');
      expect(plan({ remote: true, identity, tokenPresent: false, credentialHelperIsBot: true })).toBe('skip');
    }
  });

  it('AI-09 sem identidade o hook só explica', () => {
    expect(plan({ identity: undefined })).toBe('explain');
    expect(plan({ identity: undefined, credentialHelperIsBot: true })).toBe('explain');
  });

  it('AI-09 modo bot, com o helper já do projeto, não reconfigura', () => {
    expect(plan({ credentialHelperIsBot: true, tokenPresent: true })).toBe('skip');
    expect(plan({ credentialHelperIsBot: true, tokenPresent: false })).toBe('skip');
  });

  it('AI-09 modo bot, sem helper e com token, configura sozinho', () => {
    expect(plan({ tokenPresent: true, credentialHelperIsBot: false })).toBe('configure');
  });

  it('AI-09 modo bot, sem helper e sem token, só explica (guardar o token é de uma pessoa)', () => {
    expect(plan({ tokenPresent: false, credentialHelperIsBot: false })).toBe('explain');
  });

  it('AI-14 modo self, com o helper do projeto instalado, tira o helper', () => {
    expect(plan({ identity: SELF_IDENTITY, credentialHelperIsBot: true })).toBe('unconfigure');
    expect(plan({ identity: SELF_IDENTITY, credentialHelperIsBot: true, tokenPresent: false })).toBe('unconfigure');
  });

  it('AI-14 modo self, sem o helper do projeto, não faz nada', () => {
    expect(plan({ identity: SELF_IDENTITY, credentialHelperIsBot: false })).toBe('skip');
    expect(plan({ identity: SELF_IDENTITY, credentialHelperIsBot: false, tokenPresent: false })).toBe('skip');
  });
});

const SELF_OK: Facts = { ...LOCAL_OK, identity: SELF_IDENTITY, credentialHelperIsBot: false, githubLogin: 'alguem' };
const SELF_REMOTE_OK: Facts = { ...REMOTE_OK, identity: SELF_IDENTITY, githubLogin: 'alguem' };

function text(entry: Diagnosis): string {
  return `${entry.item} ${entry.fix ?? ''}`;
}

const SETUP_BOT = 'npm run setup:local -- --identity bot --login';

describe('AI-14 diagnóstico sem identidade', () => {
  it.each([
    ['local', LOCAL_OK],
    ['nuvem', REMOTE_OK],
  ] as [string, Facts][])('AI-14 sem identidade (%s) falha e a correção mostra os dois comandos', (_label, base) => {
    const found = failures({ ...base, identity: undefined, githubLogin: null });

    expect(found.some((entry) => (entry.fix ?? '').includes(SETUP_BOT) && (entry.fix ?? '').includes('--identity self'))).toBe(true);
  });

  it('AI-14 controle: com identidade configurada nenhuma correção pede para escolher a identidade', () => {
    expect(diagnose(LOCAL_OK).some((entry) => (entry.fix ?? '').includes('--identity self'))).toBe(false);
  });
});

describe('AI-14 diagnóstico no modo bot', () => {
  it('AI-14 o item da identidade cita o login configurado', () => {
    expect(diagnose(LOCAL_OK).some((entry) => text(entry).includes('minha-conta'))).toBe(true);
  });

  it('AI-14 login do token diferente do configurado falha e a correção repete o comando com o login configurado', () => {
    const found = failures({ ...LOCAL_OK, githubLogin: 'outra-conta' });

    expect(found.some((entry) => (entry.fix ?? '').includes(`${SETUP_BOT} minha-conta`))).toBe(true);
  });

  it('AI-14 token sem login (null) falha, e a correção local cita o comando com o login configurado', () => {
    const found = failures({ ...LOCAL_OK, githubLogin: null });

    expect(found.some((entry) => (entry.fix ?? '').includes(`${SETUP_BOT} minha-conta`))).toBe(true);
  });

  it('AI-14 na nuvem, login do token diferente do configurado falha e cita /web-setup', () => {
    const found = failures({ ...REMOTE_OK, githubLogin: 'outra-conta' });

    expect(found.some((entry) => (entry.fix ?? '').includes('/web-setup'))).toBe(true);
  });

  it('AI-14 no modo bot não há aviso de autoria', () => {
    expect(diagnose(LOCAL_OK).some((entry) => entry.notice === true)).toBe(false);
  });

  it('AI-14 no modo bot o helper do projeto ausente falha (local)', () => {
    expect(failures({ ...LOCAL_OK, credentialHelperIsBot: false }).length).toBeGreaterThan(0);
  });
});

describe('AI-14 diagnóstico no modo self', () => {
  it('AI-14 com token que responde e sem helper do projeto nenhum item falha', () => {
    expect(failures(SELF_OK)).toEqual([]);
    expect(failures(SELF_REMOTE_OK)).toEqual([]);
  });

  it('AI-14 sem token (githubLogin null) falha, com correção', () => {
    const found = failures({ ...SELF_OK, githubLogin: null });

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => (entry.fix ?? '') !== '')).toBe(true);
  });

  it('AI-14 qualquer login do token serve: o modo self não compara com conta configurada', () => {
    expect(failures({ ...SELF_OK, githubLogin: 'qualquer-pessoa' })).toEqual([]);
  });

  it('AI-14 o helper do projeto instalado falha no modo self, e a correção cita npm run setup:local', () => {
    const found = failures({ ...SELF_OK, credentialHelperIsBot: true });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
  });

  it('AI-14 na nuvem a credencial do git não entra no diagnóstico do modo self', () => {
    expect(failures({ ...SELF_REMOTE_OK, credentialHelperIsBot: true })).toEqual([]);
  });

  it.each([
    ['local', SELF_OK],
    ['nuvem', SELF_REMOTE_OK],
  ] as [string, Facts][])('AI-14 sempre avisa (%s), sem contar como falha, que a pessoa será autora e não poderá aprovar', (_label, base) => {
    const notices = diagnose(base).filter((entry) => entry.notice === true);

    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((entry) => entry.ok)).toBe(true);
    expect(notices.some((entry) => /autor/i.test(text(entry)) && /aprov/i.test(text(entry)))).toBe(true);
    expect(failures(base)).toEqual([]);
  });

  it('AI-14 o aviso continua aparecendo quando há falhas', () => {
    const found = diagnose({ ...SELF_OK, dockerRunning: false });

    expect(found.some((entry) => entry.notice === true && entry.ok)).toBe(true);
    expect(found.some((entry) => !entry.ok)).toBe(true);
  });
});

describe('AI-14 diagnóstico do chaveiro do sistema, no modo bot', () => {
  const fixes = (facts: Facts): string[] => failures(facts).map((entry) => entry.fix ?? '');

  it.each([
    ['token ausente (null)', { githubLogin: null }],
    ['login diferente do configurado', { githubLogin: 'outra-conta' }],
  ] as [string, Partial<Facts>][])('AI-14 sem o secret-tool (%s) a correção cita libsecret-tools', (_label, change) => {
    const found = fixes({ ...LOCAL_OK, ...change, tokenStore: 'system', keychainStatus: 'missing-tool' });

    expect(found.some((fix) => fix.includes('libsecret-tools'))).toBe(true);
  });

  it.each([
    ['token ausente (null)', { githubLogin: null }],
    ['login diferente do configurado', { githubLogin: 'outra-conta' }],
  ] as [string, Partial<Facts>][])(
    'AI-14 sem Secret Service (%s) a correção cita --identity self e --token-store file',
    (_label, change) => {
      const found = fixes({ ...LOCAL_OK, ...change, tokenStore: 'system', keychainStatus: 'no-service' });

      expect(found.some((fix) => fix.includes('--identity self') && fix.includes('--token-store file'))).toBe(true);
    },
  );

  it('AI-14 sem tokenStore informado vale o do sistema (a ajuda do chaveiro aparece)', () => {
    const found = fixes({ ...LOCAL_OK, githubLogin: null, keychainStatus: 'missing-tool' });

    expect(found.some((fix) => fix.includes('libsecret-tools'))).toBe(true);
  });

  // Controles negativos: com o chaveiro funcionando, ou com o arquivo escolhido, a ajuda do chaveiro não cabe.
  it('AI-14 com o chaveiro ok, a correção não cita libsecret-tools nem --token-store file', () => {
    const found = fixes({ ...LOCAL_OK, githubLogin: null, tokenStore: 'system', keychainStatus: 'ok' });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((fix) => fix.includes('libsecret-tools') || fix.includes('--token-store file'))).toBe(false);
  });

  it('AI-14 com o token em arquivo, a falta do secret-tool não importa: a correção não cita libsecret-tools', () => {
    const found = fixes({ ...LOCAL_OK, githubLogin: null, tokenStore: 'file', keychainStatus: 'missing-tool' });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((fix) => fix.includes('libsecret-tools'))).toBe(false);
  });

  it('AI-14 com tudo certo, o estado do chaveiro não gera falha', () => {
    expect(failures({ ...LOCAL_OK, tokenStore: 'system', keychainStatus: 'ok' })).toEqual([]);
  });
});

describe('AI-14 aviso do token em arquivo, no modo bot', () => {
  const fileNotices = (facts: Facts): Diagnosis[] =>
    diagnose(facts).filter((entry) => entry.notice === true && /arquivo/i.test(text(entry)));

  it('AI-14 tokenStore file avisa, sem contar como falha, que o token está em arquivo não cifrado', () => {
    const facts: Facts = { ...LOCAL_OK, tokenStore: 'file' };

    const notices = fileNotices(facts);

    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((entry) => entry.ok)).toBe(true);
    expect(notices.some((entry) => /não cifrado/i.test(text(entry)))).toBe(true);
    expect(failures(facts)).toEqual([]);
  });

  it('AI-14 o aviso do arquivo aparece no relatório, que continua pronto', () => {
    const out = report(diagnose({ ...LOCAL_OK, tokenStore: 'file' }));

    expect(out.startsWith('Ambiente pronto')).toBe(true);
    expect(out).toMatch(/não cifrado/i);
  });

  it('AI-14 o aviso continua aparecendo quando há falhas', () => {
    const found = diagnose({ ...LOCAL_OK, tokenStore: 'file', dockerRunning: false });

    expect(found.some((entry) => !entry.ok)).toBe(true);
    expect(fileNotices({ ...LOCAL_OK, tokenStore: 'file', dockerRunning: false }).length).toBeGreaterThan(0);
  });

  it('AI-14 controle: com tokenStore system ou ausente, nenhum aviso sobre arquivo', () => {
    expect(fileNotices({ ...LOCAL_OK, tokenStore: 'system' })).toEqual([]);
    expect(fileNotices(LOCAL_OK)).toEqual([]);
    expect(report(diagnose({ ...LOCAL_OK, tokenStore: 'system' }))).not.toMatch(/não cifrado/i);
  });
});

describe('AI-14 nenhuma mensagem do diagnóstico cita uma conta fixa', () => {
  it('AI-14 itens e correções, em todos os cenários, não têm o texto honeyforge', () => {
    const scenarios: Facts[] = [
      LOCAL_OK,
      REMOTE_OK,
      SELF_OK,
      SELF_REMOTE_OK,
      { ...LOCAL_OK, identity: undefined, githubLogin: null },
      { ...LOCAL_OK, githubLogin: null, credentialHelperIsBot: false },
      { ...REMOTE_OK, githubLogin: 'outra-conta' },
      { ...SELF_OK, githubLogin: null, credentialHelperIsBot: true },
      { ...LOCAL_OK, depsInstalled: false, dockerRunning: false, mcpRegistered: false, commitHookInstalled: false },
    ];

    for (const facts of scenarios) {
      expect(JSON.stringify(diagnose(facts))).not.toMatch(/honeyforge/i);
    }
  });
});

describe('AI-14 report', () => {
  const failure: Diagnosis = { item: 'Docker parado', ok: false, fix: 'abra o Docker' };
  const notice: Diagnosis = { item: 'Você será autora dos PRs', ok: true, notice: true, fix: 'não poderá aprová-los' };
  const fine: Diagnosis = { item: 'Node confere', ok: true };

  it('AI-14 com falhas começa por Ambiente incompleto e traz o aviso', () => {
    const out = report([fine, failure, notice]);

    expect(out.startsWith('Ambiente incompleto')).toBe(true);
    expect(out).toContain('Docker parado');
    expect(out).toContain('Você será autora dos PRs');
  });

  it('AI-14 sem falhas começa por Ambiente pronto e ainda traz o aviso', () => {
    const out = report([fine, notice]);

    expect(out.startsWith('Ambiente pronto')).toBe(true);
    expect(out).toContain('Você será autora dos PRs');
  });

  it('AI-14 o aviso não vira falha: só com ele o ambiente está pronto', () => {
    expect(report([notice]).startsWith('Ambiente pronto')).toBe(true);
    expect(report([notice, failure]).startsWith('Ambiente incompleto')).toBe(true);
  });

  it('AI-14 sem aviso, o texto do aviso não aparece (controle)', () => {
    expect(report([fine])).not.toContain('autora');
    expect(report([fine, failure])).not.toContain('autora');
  });

  it('AI-14 o diagnóstico real do modo self, pronto, traz o aviso no relatório', () => {
    const out = report(diagnose(SELF_OK));

    expect(out.startsWith('Ambiente pronto')).toBe(true);
    expect(out).toMatch(/aprov/i);
  });

  it('AI-14 o diagnóstico real do modo self, com falha, traz o aviso e a falha', () => {
    const out = report(diagnose({ ...SELF_OK, dockerRunning: false }));

    expect(out.startsWith('Ambiente incompleto')).toBe(true);
    expect(out).toMatch(/aprov/i);
  });

  it('AI-14 o diagnóstico real do modo bot não traz aviso de autoria', () => {
    expect(report(diagnose(LOCAL_OK))).not.toMatch(/aprov/i);
  });
});

describe('AI-09 o hook commit-msg versionado em .githooks/', () => {
  const hookPath = join(import.meta.dirname, '..', '.githooks', 'commit-msg');

  it('AI-09 .githooks/commit-msg existe e é executável', () => {
    expect(statSync(hookPath).isFile()).toBe(true);
    expect(() => {
      accessSync(hookPath, constants.X_OK);
    }).not.toThrow();
    expect(statSync(hookPath).mode & 0o111).not.toBe(0);
  });

  it('AI-09 .githooks/commit-msg roda o commitlint com --edit sobre o arquivo da mensagem', () => {
    const content = readFileSync(hookPath, 'utf8');

    expect(content.startsWith('#!')).toBe(true);
    expect(content).toMatch(/commitlint[^\n]*--edit/);
  });

  // Controle negativo: o hook de verdade recusa uma mensagem fora do padrão e aceita uma no padrão.
  it('AI-09 .githooks/commit-msg recusa mensagem fora do padrão e aceita a convencional', () => {
    const root = join(import.meta.dirname, '..');
    const dir = mkdtempSync(join(tmpdir(), 'commit-msg-'));
    const run = (message: string) => {
      const file = join(dir, 'COMMIT_EDITMSG');
      writeFileSync(file, `${message}\n`);
      return spawnSync(hookPath, [file], { cwd: root, encoding: 'utf8' }).status;
    };

    try {
      expect(run('mensagem qualquer sem tipo')).not.toBe(0);
      expect(run('docs(specs): ajusta o texto do critério')).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
