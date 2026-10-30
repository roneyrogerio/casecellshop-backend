// Diagnóstico do ambiente (AI-09), rodado pelo hook SessionStart em toda sessão,
// local ou na nuvem. Diz o que falta e como resolver, e nunca bloqueia: uma
// sessão sem Docker ainda pode escrever specs. O que ele evita é o agente
// descobrir no meio do trabalho que não consegue rodar os testes ou que o push
// sairia com a credencial errada.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BOT_LOGIN, readBotToken } from './lib/bot-token.ts';

export interface Facts {
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

export interface Diagnosis {
  item: string;
  ok: boolean;
  fix?: string;
}

function major(version: string): string {
  return version.trim().replace(/^v/, '').split('.')[0] ?? '';
}

export function diagnose(facts: Facts): Diagnosis[] {
  const results: Diagnosis[] = [
    {
      item: `Node ${facts.nodeVersion} (o .nvmrc pede ${facts.nvmrc.trim()})`,
      ok: major(facts.nodeVersion) === major(facts.nvmrc),
      fix: `Use o Node ${facts.nvmrc.trim()}: nvm install && nvm use (ou instale pela nodejs.org).`,
    },
    { item: 'Dependências instaladas', ok: facts.depsInstalled, fix: 'Rode npm ci.' },
    {
      item: 'Docker rodando (testes de integração e docker compose)',
      ok: facts.dockerRunning,
      fix: 'Abra o Docker Desktop ou inicie o serviço do Docker; sem ele, só npm run test:unit roda.',
    },
    {
      item: 'origin em HTTPS do GitHub',
      ok: facts.originUrl.startsWith('https://github.com/'),
      fix: 'Use o remoto HTTPS: git remote set-url origin https://github.com/roneyrogerio/casecellshop-backend.git',
    },
    {
      item: `GitHub como ${BOT_LOGIN}`,
      ok: facts.botLogin === BOT_LOGIN,
      fix: facts.remote
        ? `A sessão na nuvem não está como ${BOT_LOGIN}: rode /web-setup num terminal com GH_TOKEN do bot.`
        : `Token do ${BOT_LOGIN} ausente no chaveiro ou de outra conta: rode npm run setup:local.`,
    },
  ];
  // Na nuvem, o git e o MCP vêm do proxy da sessão; essas duas peças só existem na máquina.
  if (!facts.remote) {
    results.push(
      {
        item: 'Push pelo credential helper do bot',
        ok: facts.credentialHelperIsBot,
        fix: 'Rode npm run setup:local (configura o credential helper só neste repositório).',
      },
      {
        item: 'MCP do GitHub registrado neste clone',
        ok: facts.mcpRegistered,
        fix: 'Rode npm run setup:local (registra o MCP no escopo local, sem gravar o token).',
      },
    );
  }
  return results.map((result) => (result.ok ? { item: result.item, ok: true } : result));
}

function run(cmd: string, args: string[], timeout = 8000): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

async function githubLogin(remote: boolean): Promise<string | null> {
  if (remote) {
    const who = run('gh', ['api', 'user', '--jq', '.login']);
    return who.ok ? who.out : null;
  }
  const token = readBotToken();
  if (!token) return null;
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    return response.ok ? ((await response.json()) as { login?: string }).login ?? null : null;
  } catch {
    return null;
  }
}

export async function collectFacts(root: string): Promise<Facts> {
  const remote = process.env.CLAUDE_CODE_REMOTE === 'true';
  const helpers = run('git', ['-C', root, 'config', '--local', '--get-all', 'credential.helper']).out;
  return {
    remote,
    nodeVersion: process.version,
    nvmrc: existsSync(join(root, '.nvmrc')) ? readFileSync(join(root, '.nvmrc'), 'utf8') : '',
    depsInstalled: existsSync(join(root, 'node_modules', '.package-lock.json')),
    dockerRunning: run('docker', ['info'], 5000).ok,
    originUrl: run('git', ['-C', root, 'remote', 'get-url', '--push', 'origin']).out,
    credentialHelperIsBot: helpers.includes('git-credential-bot'),
    botLogin: await githubLogin(remote),
    mcpRegistered: remote || run('claude', ['mcp', 'get', 'github']).ok,
  };
}

export function report(results: Diagnosis[]): string {
  const missing = results.filter((result) => !result.ok);
  if (missing.length === 0) return 'Ambiente pronto: Node, dependências, Docker, GitHub como o bot e MCP.';
  return [
    'Ambiente incompleto. Antes de trabalhar, resolva (ou avise o mantenedor):',
    ...missing.map((result) => `- ${result.item}: ${result.fix ?? ''}`),
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const text = report(diagnose(await collectFacts(root)));
  // O contexto vai para o modelo, que orienta o mantenedor; a mensagem aparece na tela.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
      ...(text.startsWith('Ambiente pronto') ? {} : { systemMessage: text }),
    }),
  );
}
