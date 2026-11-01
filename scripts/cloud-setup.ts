// Preparo da sessão do Claude Code na nuvem (AI-51). O script de preparo do
// ambiente, no painel de claude.ai/code, só chama este arquivo, e o hook
// SessionStart o chama de novo em toda sessão: o que o projeto precisa vive no
// repositório e muda por commit, sem editar o painel. O painel roda uma vez por
// cópia do disco (a nuvem guarda o disco e só repete o script quando ele muda,
// ou a cada ~7 dias); o hook cobre o que mudou depois e o que não sobrevive à
// cópia, como o Docker rodando.
//
// Tudo é idempotente e rápido quando já está feito. Nada sai no stdout, que no
// SessionStart vira contexto e é do relatório do check-env; o progresso vai
// para o stderr, e uma etapa que falha não derruba a sessão: o check-env, logo
// depois, diz o que ficou faltando.
//
// Roda com o Node que a imagem traz (22), antes de o Node do .nvmrc existir.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Mode = 'setup-script' | 'hook' | 'skip';

// O painel passa --setup-script. Sem a flag é o hook, que só age na nuvem: na
// máquina, o Node, as dependências e o Docker são da pessoa.
export function modeFor(argv: string[], env: NodeJS.ProcessEnv): Mode {
  if (argv.includes('--setup-script')) return 'setup-script';
  return env.CLAUDE_CODE_REMOTE === 'true' ? 'hook' : 'skip';
}

export function nodeBinDir(nvmDir: string, nvmrc: string): string {
  return join(
    nvmDir,
    'versions',
    'node',
    `v${nvmrc.trim().replace(/^v/, '')}`,
    'bin',
  );
}

// Os hooks herdam o PATH do processo do Claude Code, que não muda depois de
// aberto, e lá o Node da imagem vem antes do nvm. Um link do node, do npm e do
// npx numa pasta do usuário que já está no PATH antes do Node da imagem faz os
// hooks (o npm ci e as checagens dos agentes) usarem o Node do .nvmrc. Sem uma
// pasta assim, devolve null e os hooks seguem com o Node da imagem.
export function shimDir(
  pathEntries: string[],
  home: string,
  hasNode: (dir: string) => boolean,
): string | null {
  const candidate = join(home, '.local', 'bin');
  const at = pathEntries.indexOf(candidate);
  if (at === -1) return null;
  const firstNode = pathEntries.findIndex(
    (dir) => dir !== candidate && hasNode(dir),
  );
  return firstNode === -1 || at < firstNode ? candidate : null;
}

// Os comandos do Bash da sessão leem o CLAUDE_ENV_FILE antes de cada comando,
// depois do perfil do shell, que põe o Node da imagem na frente.
export function envFileLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH"\n`;
}

// Muda quando o lockfile ou a versão do Node muda: os dois decidem o que o
// npm ci instala (e os módulos nativos dependem da versão).
export function depsStamp(lockfile: string, nodeVersion: string): string {
  return createHash('sha256')
    .update(nodeVersion)
    .update('\0')
    .update(lockfile)
    .digest('hex');
}

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function normalized(pem: string): string {
  return pem.replace(/\s/g, '');
}

// Os certificados do pacote que o Node não traz: os do proxy que reabre o TLS.
// Só eles vão para o build da imagem, que já tem as raízes públicas.
export function extraCertificates(
  bundle: string,
  roots: readonly string[],
): string[] {
  const known = new Set(roots.map(normalized));
  const seen = new Set<string>();
  return (bundle.match(PEM) ?? []).filter((pem) => {
    const key = normalized(pem);
    if (known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Onde a sessão na nuvem diz que estão os certificados confiáveis.
export function caBundleCandidates(env: NodeJS.ProcessEnv): string[] {
  return [
    env.NODE_EXTRA_CA_CERTS,
    env.SSL_CERT_FILE,
    '/etc/ssl/certs/ca-certificates.crt',
  ].filter((file): file is string => Boolean(file));
}

function log(message: string): void {
  process.stderr.write(`cloud-setup: ${message}\n`);
}

function run(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    quiet?: boolean;
  } = {},
): boolean {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeout: options.timeout ?? 600_000,
    stdio: ['ignore', 'ignore', options.quiet ? 'ignore' : 'inherit'],
  });
  return result.status === 0;
}

function ensureNode(root: string, nvmDir: string): string | null {
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const bin = nodeBinDir(nvmDir, nvmrc);
  if (existsSync(join(bin, 'node'))) return bin;
  if (!existsSync(join(nvmDir, 'nvm.sh'))) {
    log(`sem nvm em ${nvmDir}; o Node ${nvmrc} não foi instalado`);
    return null;
  }
  log(`instalando o Node ${nvmrc} pelo nvm`);
  // A versão vai como argumento ($1), nunca no texto do comando.
  run('bash', ['-c', '. "$NVM_DIR/nvm.sh" && nvm install "$1"', 'nvm', nvmrc], {
    env: { ...process.env, NVM_DIR: nvmDir },
  });
  return existsSync(join(bin, 'node')) ? bin : null;
}

function linkShims(bin: string): void {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const dir = shimDir(entries, homedir(), (d) => existsSync(join(d, 'node')));
  if (!dir) {
    log(
      'nenhuma pasta do PATH vem antes do Node da imagem; os hooks seguem com ele',
    );
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const name of ['node', 'npm', 'npx']) {
    rmSync(join(dir, name), { force: true });
    symlinkSync(join(bin, name), join(dir, name));
  }
}

function ensureDeps(root: string, bin: string): void {
  const lock = readFileSync(join(root, 'package-lock.json'), 'utf8');
  const version = spawnSync(join(bin, 'node'), ['--version'], {
    encoding: 'utf8',
  }).stdout.trim();
  const stamp = depsStamp(lock, version);
  const stampFile = join(root, 'node_modules', '.cloud-setup-stamp');
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp)
    return;
  log('rodando npm ci');
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
  };
  if (run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env }))
    writeFileSync(stampFile, stamp);
}

// O .build-ca.pem fica fora do git; o Dockerfile o copia quando existe.
function writeBuildCa(root: string): void {
  const file = caBundleCandidates(process.env).find((f) => existsSync(f));
  if (!file) return;
  const extra = extraCertificates(readFileSync(file, 'utf8'), rootCertificates);
  const target = join(root, '.build-ca.pem');
  if (extra.length === 0) {
    rmSync(target, { force: true });
    return;
  }
  const content = `${extra.join('\n')}\n`;
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content)
    writeFileSync(target, content);
}

function dockerUp(): boolean {
  return run('docker', ['info'], { timeout: 10_000, quiet: true });
}

// Devolve o processo quando foi este script que subiu o Docker.
async function ensureDocker(): Promise<number | null> {
  if (dockerUp()) return null;
  if (!run('sh', ['-c', 'command -v dockerd'], { quiet: true })) {
    log('sem dockerd; o Docker não foi iniciado');
    return null;
  }
  const out = openSync(join(tmpdir(), 'dockerd.log'), 'a');
  const child = spawn('dockerd', [], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    if (dockerUp()) return child.pid ?? null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  log(
    'o dockerd não respondeu em 30 s; veja o dockerd.log na pasta temporária',
  );
  return child.pid ?? null;
}

// No painel: as imagens ficam na cópia do disco, e as sessões novas não as
// baixam de novo. Processo não entra na cópia, então o Docker para no fim.
async function warmImages(
  root: string,
  dockerPid: number | null,
): Promise<void> {
  if (!dockerUp()) return;
  run('docker', ['compose', 'pull', '--ignore-buildable', '--quiet'], {
    cwd: root,
  });
  run('docker', ['compose', 'build', '--quiet'], { cwd: root });
  if (dockerPid === null) return;
  process.kill(dockerPid, 'SIGTERM');
  for (let i = 0; i < 30 && dockerUp(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 1000));
}

// Cada etapa isolada: uma falha não impede as outras.
function step(name: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    log(
      `${name} falhou: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function main(): Promise<void> {
  const mode = modeFor(process.argv.slice(2), process.env);
  if (mode === 'skip') return;
  const root = fileURLToPath(new URL('..', import.meta.url));
  const nvmDir = process.env.NVM_DIR ?? '/opt/nvm';
  let bin: string | null = null;
  step('o Node', () => {
    bin = ensureNode(root, nvmDir);
  });
  if (bin) {
    const nodeBin: string = bin;
    step('os links do Node', () => linkShims(nodeBin));
    const envFile = process.env.CLAUDE_ENV_FILE;
    if (envFile)
      step('o PATH da sessão', () =>
        appendFileSync(envFile, envFileLine(nodeBin)),
      );
    step('as dependências', () => ensureDeps(root, nodeBin));
  }
  step('o certificado do build', () => writeBuildCa(root));
  const dockerPid = await ensureDocker();
  if (mode === 'setup-script') await warmImages(root, dockerPid);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main().catch((error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
  });
}
