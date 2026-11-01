import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  caBundleCandidates,
  depsStamp,
  envFileLine,
  extraCertificates,
  modeFor,
  nodeBinDir,
  shimDir,
} from './cloud-setup.ts';

const SCRIPT = join(import.meta.dirname, 'cloud-setup.ts');

// Um certificado fora das raízes do Node, como o do proxy da nuvem. O conteúdo
// não precisa ser um certificado válido: a conferência compara o texto do PEM.
const PROXY_CA =
  '-----BEGIN CERTIFICATE-----\nUFJPWFktREEtTlVWRU0=\n-----END CERTIFICATE-----';
const PUBLIC_ROOT = rootCertificates[0] ?? '';

describe('modeFor', () => {
  it('AI-51 o painel passa --setup-script e prepara mesmo sem CLAUDE_CODE_REMOTE', () => {
    expect(modeFor(['--setup-script'], {})).toBe('setup-script');
  });

  it('AI-51 sem a flag, o hook só age na nuvem (CLAUDE_CODE_REMOTE=true)', () => {
    expect(modeFor([], { CLAUDE_CODE_REMOTE: 'true' })).toBe('hook');
  });

  it('AI-51 controle: na máquina o hook não faz nada, nem com a variável diferente de true', () => {
    expect(modeFor([], {})).toBe('skip');
    expect(modeFor([], { CLAUDE_CODE_REMOTE: '1' })).toBe('skip');
  });
});

describe('nodeBinDir', () => {
  it('AI-51 a pasta do Node sai do .nvmrc, com ou sem o v e com a quebra de linha', () => {
    expect(nodeBinDir('/opt/nvm', '26.13.0\n')).toBe(
      '/opt/nvm/versions/node/v26.13.0/bin',
    );
    expect(nodeBinDir('/opt/nvm', 'v26.13.0')).toBe(
      '/opt/nvm/versions/node/v26.13.0/bin',
    );
  });
});

describe('shimDir', () => {
  const home = '/root';
  const local = '/root/.local/bin';
  const withNode = new Set(['/opt/node22/bin', '/usr/local/bin']);
  const hasNode = (dir: string) => withNode.has(dir);

  it('AI-51 usa a ~/.local/bin quando ela vem antes do Node da imagem no PATH', () => {
    expect(
      shimDir(
        ['/nix/bin', local, '/opt/node22/bin', '/usr/bin'],
        home,
        hasNode,
      ),
    ).toBe(local);
  });

  it('AI-51 usa a ~/.local/bin quando nenhuma pasta do PATH tem node', () => {
    expect(shimDir([local, '/usr/bin'], home, () => false)).toBe(local);
  });

  it('AI-51 controle: a ~/.local/bin depois do Node da imagem não serve, e ausente também não', () => {
    expect(shimDir(['/opt/node22/bin', local], home, hasNode)).toBeNull();
    expect(shimDir(['/opt/node22/bin', '/usr/bin'], home, hasNode)).toBeNull();
  });

  it('AI-51 um node já linkado na ~/.local/bin não conta como o Node da imagem', () => {
    expect(
      shimDir(
        [local, '/opt/node22/bin'],
        home,
        (dir) => dir === local || hasNode(dir),
      ),
    ).toBe(local);
  });
});

describe('envFileLine', () => {
  it('AI-51 põe o Node do .nvmrc na frente do PATH que o perfil do shell montou', () => {
    expect(envFileLine('/opt/nvm/versions/node/v26.13.0/bin')).toBe(
      'export PATH="/opt/nvm/versions/node/v26.13.0/bin:$PATH"\n',
    );
  });
});

describe('depsStamp', () => {
  it('AI-51 o carimbo muda com o lockfile e com a versão do Node, e só com eles', () => {
    const base = depsStamp('{"a":1}', 'v26.13.0');
    expect(depsStamp('{"a":1}', 'v26.13.0')).toBe(base);
    expect(depsStamp('{"a":2}', 'v26.13.0')).not.toBe(base);
    expect(depsStamp('{"a":1}', 'v26.14.0')).not.toBe(base);
  });

  it('AI-51 controle: a fronteira entre versão e lockfile não se confunde', () => {
    expect(depsStamp('1x', 'v2')).not.toBe(depsStamp('x', 'v21'));
  });
});

describe('extraCertificates', () => {
  it('AI-51 devolve só o certificado que o Node não traz, sem repetir', () => {
    const bundle = [PUBLIC_ROOT, PROXY_CA, PROXY_CA].join('\n');
    expect(extraCertificates(bundle, rootCertificates)).toEqual([PROXY_CA]);
  });

  it('AI-51 compara sem espaço nem quebra de linha: a raiz com outra quebra continua conhecida', () => {
    const rewrapped = PUBLIC_ROOT.replace(/\n/g, '\r\n');
    expect(extraCertificates(rewrapped, rootCertificates)).toEqual([]);
  });

  it('AI-51 controle: um pacote só com raízes públicas, ou sem certificado, não devolve nada', () => {
    expect(
      extraCertificates(rootCertificates.join('\n'), rootCertificates),
    ).toEqual([]);
    expect(extraCertificates('texto qualquer', rootCertificates)).toEqual([]);
  });
});

describe('caBundleCandidates', () => {
  it('AI-51 procura nas variáveis da sessão antes do repositório do sistema', () => {
    expect(
      caBundleCandidates({
        NODE_EXTRA_CA_CERTS: '/a.pem',
        SSL_CERT_FILE: '/b.pem',
      }),
    ).toEqual(['/a.pem', '/b.pem', '/etc/ssl/certs/ca-certificates.crt']);
    expect(caBundleCandidates({})).toEqual([
      '/etc/ssl/certs/ca-certificates.crt',
    ]);
  });
});

describe('processo', () => {
  it('AI-51 na máquina, sem a flag, sai com 0 sem escrever nada nem tocar no CLAUDE_ENV_FILE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-setup-'));
    try {
      const envFile = join(dir, 'env');
      writeFileSync(envFile, '');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_ENV_FILE: envFile,
      };
      delete env.CLAUDE_CODE_REMOTE;
      const result = spawnSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(readFileSync(envFile, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
