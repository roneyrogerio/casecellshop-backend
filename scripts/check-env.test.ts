import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface Facts {
  remote: boolean;
  nodeVersion: string;
  nvmrc: string;
  depsInstalled: boolean;
  dockerRunning: boolean;
  originUrl: string;
  credentialHelperIsBot: boolean;
  botLogin: string | null;
  mcpRegistered: boolean;
}

interface Diagnosis {
  item: string;
  ok: boolean;
  fix?: string;
}

let diagnose: (facts: Facts) => Diagnosis[];

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(import.meta.dirname, 'check-env.ts')).href)) as {
    diagnose: typeof diagnose;
  };
  diagnose = mod.diagnose;
});

// Máquina local com tudo certo: é o controle negativo de cada teste.
const LOCAL_OK: Facts = {
  remote: false,
  nodeVersion: 'v26.13.0',
  nvmrc: '26.13.0',
  depsInstalled: true,
  dockerRunning: true,
  originUrl: 'https://github.com/roneyrogerio/casecellshop-backend.git',
  credentialHelperIsBot: true,
  botLogin: 'honeyforge-bot',
  mcpRegistered: true,
};

const REMOTE_OK: Facts = {
  ...LOCAL_OK,
  remote: true,
  credentialHelperIsBot: false,
  mcpRegistered: false,
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
    ['login do bot sem token (null)', { botLogin: null }],
    ['login do bot diferente de honeyforge-bot', { botLogin: 'roneyrogerio' }],
  ] as [string, Partial<Facts>][])('AI-09 %s falha, com correção', (_label, change) => {
    const found = failures({ ...LOCAL_OK, ...change });

    expect(found.length).toBeGreaterThan(0);
    expect(found.every((entry) => (entry.fix ?? '') !== '')).toBe(true);
  });

  it('AI-09 credencial do git que não é a do bot falha e a correção cita npm run setup:local', () => {
    const found = failures({ ...LOCAL_OK, credentialHelperIsBot: false });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
  });

  it('AI-09 MCP do GitHub não registrado falha e a correção cita npm run setup:local', () => {
    const found = failures({ ...LOCAL_OK, mcpRegistered: false });

    expect(found.length).toBeGreaterThan(0);
    expect(found.some((entry) => (entry.fix ?? '').includes('npm run setup:local'))).toBe(true);
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

  it('AI-09 na nuvem a falha do login do bot cita /web-setup', () => {
    const found = failures({ ...REMOTE_OK, botLogin: null });

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
