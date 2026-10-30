// Diagnóstico do ambiente (AI-09), rodado pelo hook SessionStart em toda sessão,
// local ou na nuvem. Diz o que falta e como resolver, e nunca bloqueia: uma
// sessão sem Docker ainda pode escrever specs. O que ele evita é o agente
// descobrir no meio do trabalho que não consegue rodar os testes ou que o push
// sairia com a credencial errada.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitHookInstalled, configureGitBot, gitHelperIsBot, installCommitHook, removeGitBot } from './lib/git-bot.ts';
import { type Identity, readIdentity, readToken } from './lib/identity.ts';

export interface Facts {
  remote: boolean;
  nodeVersion: string;
  nvmrc: string;
  depsInstalled: boolean;
  dockerRunning: boolean;
  originUrl: string;
  credentialHelperIsBot: boolean;
  identity: Identity | undefined;
  // O login que o token da identidade devolve na API do GitHub; null sem token
  // ou com token recusado.
  githubLogin: string | null;
  mcpRegistered: boolean;
  commitHookInstalled: boolean;
}

export interface Diagnosis {
  item: string;
  ok: boolean;
  fix?: string;
  // Aviso que não é falha: aparece em toda sessão, sem marcar o ambiente como incompleto.
  notice?: boolean;
}

const SETUP_USAGE =
  'npm run setup:local -- --identity bot --login <conta-de-máquina> (recomendado: os PRs saem numa conta separada da sua, e você os aprova) ou npm run setup:local -- --identity self (a sua própria credencial do GitHub)';

function identityItems(facts: Facts): Diagnosis[] {
  const { identity } = facts;
  if (!identity) {
    return [{ item: 'Identidade do GitHub configurada neste clone (git config casecellshop.identity)', ok: false, fix: `Escolha com que conta os agentes agem no GitHub: ${SETUP_USAGE}.` }];
  }
  if (identity.mode === 'bot') {
    return [
      {
        item: `GitHub como ${identity.login} (modo bot, chaveiro: ${identity.keychainService})`,
        ok: facts.githubLogin === identity.login,
        fix: facts.remote
          ? `A sessão na nuvem não está como ${identity.login}: rode /web-setup num terminal com o GH_TOKEN dessa conta.`
          : `O token de ${identity.login} falta no chaveiro, foi recusado ou é de outra conta: rode npm run setup:local -- --identity bot --login ${identity.login}, que pede o token novo.`,
      },
    ];
  }
  return [
    {
      item: 'GitHub com a credencial desta máquina (modo self)',
      ok: facts.githubLogin !== null,
      fix: facts.remote
        ? 'A sessão na nuvem não tem credencial do GitHub: rode /web-setup.'
        : 'O git desta máquina não tem credencial do GitHub guardada: faça um push manual por HTTPS para o git guardá-la, ou troque para o modo bot.',
    },
    {
      item: `Modo self${facts.githubLogin ? ` (${facts.githubLogin})` : ''}: você será autor dos PRs que os agentes abrirem`,
      ok: true,
      notice: true,
      fix: 'O GitHub não deixa o autor aprovar o próprio PR, e o ruleset da main exige a aprovação de outra conta: o merge trava. Para aprovar, use o modo bot com uma conta de máquina.',
    },
  ];
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
    ...identityItems(facts),
  ];
  // Na nuvem, o git e o MCP vêm do proxy da sessão; essas duas peças só existem na máquina.
  if (!facts.remote) {
    if (facts.identity?.mode === 'bot') {
      results.push({
        item: 'Push pelo credential helper do projeto (modo bot)',
        ok: facts.credentialHelperIsBot,
        fix: `Rode npm run setup:local -- --identity bot --login ${facts.identity.login} (configura o credential helper só neste repositório; o início de sessão faz isso sozinho quando o token existe).`,
      });
    }
    if (facts.identity?.mode === 'self') {
      results.push({
        item: 'Push pela credencial da máquina (modo self)',
        ok: !facts.credentialHelperIsBot,
        fix: 'O credential helper do projeto ainda está neste clone: rode npm run setup:local -- --identity self, que o tira.',
      });
    }
    results.push(
      {
        item: 'Hook commit-msg do commitlint instalado',
        ok: facts.commitHookInstalled,
        fix: 'Rode npm run setup:local (aponta o core.hooksPath deste clone para .githooks/; o início de sessão faz isso sozinho).',
      },
      {
        item: 'Servidor github declarado no .mcp.json',
        ok: facts.mcpRegistered,
        fix: 'O .mcp.json do repositório não declara o servidor github: restaure-o com git checkout -- .mcp.json e rode npm run setup:local. Se o Claude Code perguntar, aceite a confiança da pasta e o servidor github.',
      },
    );
  }
  return results.map((result) => (result.ok && !result.notice ? { item: result.item, ok: true } : result));
}

function run(cmd: string, args: string[], timeout = 8000): { ok: boolean; out: string } {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return { ok: result.status === 0, out: (result.stdout ?? '').trim() };
}

async function githubLogin(remote: boolean, token: string | undefined): Promise<string | null> {
  if (remote) {
    const who = run('gh', ['api', 'user', '--jq', '.login']);
    return who.ok ? who.out : null;
  }
  return tokenLogin(token);
}

// O login que o token devolve na API do GitHub, ou null sem token, com token
// recusado ou sem rede.
export async function tokenLogin(token: string | undefined): Promise<string | null> {
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
  const identity = readIdentity(root);
  const token = remote ? undefined : readToken(identity, root);
  if (!remote && !commitHookInstalled(root)) installCommitHook(root);
  const plan = planGitSetup({ remote, identity, tokenPresent: Boolean(token), credentialHelperIsBot: gitHelperIsBot(root) });
  if (plan === 'configure') configureGitBot(root);
  if (plan === 'unconfigure') removeGitBot(root);
  return {
    remote,
    nodeVersion: process.version,
    nvmrc: existsSync(join(root, '.nvmrc')) ? readFileSync(join(root, '.nvmrc'), 'utf8') : '',
    depsInstalled: existsSync(join(root, 'node_modules', '.package-lock.json')),
    dockerRunning: run('docker', ['info'], 5000).ok,
    originUrl: run('git', ['-C', root, 'remote', 'get-url', '--push', 'origin']).out,
    credentialHelperIsBot: remote || gitHelperIsBot(root),
    identity,
    githubLogin: await githubLogin(remote, token),
    mcpRegistered: declaresGithubServer(root),
    commitHookInstalled: remote || commitHookInstalled(root),
  };
}

// O que o início de sessão pode resolver sozinho: ajustar a credencial do git ao
// modo escolhido. O resto (escolher a identidade, guardar o token, aceitar a
// confiança da pasta) só uma pessoa faz, e o relatório explica.
export function planGitSetup(facts: {
  remote: boolean;
  identity: Identity | undefined;
  tokenPresent: boolean;
  credentialHelperIsBot: boolean;
}): 'configure' | 'unconfigure' | 'skip' | 'explain' {
  if (facts.remote) return 'skip';
  if (!facts.identity) return 'explain';
  if (facts.identity.mode === 'self') return facts.credentialHelperIsBot ? 'unconfigure' : 'skip';
  if (facts.credentialHelperIsBot) return 'skip';
  return facts.tokenPresent ? 'configure' : 'explain';
}

function declaresGithubServer(root: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
    return Boolean(config.mcpServers?.github);
  } catch {
    return false;
  }
}

export function report(results: Diagnosis[]): string {
  const missing = results.filter((result) => !result.ok);
  const notices = results.filter((result) => result.notice).map((result) => `Aviso: ${result.item}. ${result.fix ?? ''}`.trim());
  if (missing.length === 0) {
    return ['Ambiente pronto: Node, dependências, Docker, GitHub com a identidade configurada e MCP.', ...notices].join('\n');
  }
  return [
    'Ambiente incompleto. Antes de trabalhar, resolva (ou avise o mantenedor):',
    ...missing.map((result) => `- ${result.item}: ${result.fix ?? ''}`),
    ...notices,
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
