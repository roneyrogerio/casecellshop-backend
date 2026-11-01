import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../test/helpers/git-sandbox.ts';
import {
  makeScriptsSandbox,
  runIsolatedScript,
} from '../test/helpers/identity-sandbox.ts';

interface CredentialModule {
  answer: (request: string, token: string | undefined) => string;
}

let answer: CredentialModule['answer'];

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(
    pathToFileURL(join(import.meta.dirname, 'git-credential-bot.ts')).href
  )) as CredentialModule;
  answer = mod.answer;
});

const TOKEN = 'ghs_exemplo';
const OK = `username=x-access-token\npassword=${TOKEN}\n`;

// O git manda linhas chave=valor e termina com uma linha em branco.
function request(...lines: string[]): string {
  return `${lines.join('\n')}\n\n`;
}

describe('AI-08 credential helper do git só responde para https://github.com', () => {
  it('AI-08 com protocol=https, host=github.com e token, devolve usuário e senha do bot', () => {
    expect(answer(request('protocol=https', 'host=github.com'), TOKEN)).toBe(
      OK,
    );
  });

  it('AI-08 a ordem das linhas e linhas extras (path) não mudam a resposta', () => {
    expect(
      answer(
        request('host=github.com', 'path=roney/repo.git', 'protocol=https'),
        TOKEN,
      ),
    ).toBe(OK);
  });

  it.each([
    'gitlab.com',
    'gist.github.com',
    'github.com.evil.example',
    'evilgithub.com',
    'api.github.com',
  ])('AI-08 não responde para o host %s', (host) => {
    expect(answer(request('protocol=https', `host=${host}`), TOKEN)).toBe('');
  });

  it.each(['http', 'ssh', 'git'])(
    'AI-08 não responde para o protocolo %s',
    (protocol) => {
      expect(
        answer(request(`protocol=${protocol}`, 'host=github.com'), TOKEN),
      ).toBe('');
    },
  );

  // Sem token, o git não pode consultar outra credencial (a do dono, administradora) nem perguntar.
  it('AI-08 sem token (undefined), para https://github.com, responde quit=1', () => {
    expect(
      answer(request('protocol=https', 'host=github.com'), undefined),
    ).toBe('quit=1\n');
  });

  it('AI-08 com token vazio, para https://github.com, responde quit=1', () => {
    expect(answer(request('protocol=https', 'host=github.com'), '')).toBe(
      'quit=1\n',
    );
  });

  it('AI-08 controle: o quit=1 não aparece quando há token', () => {
    expect(
      answer(request('protocol=https', 'host=github.com'), TOKEN),
    ).not.toContain('quit=1');
  });

  it.each([undefined, ''])(
    'AI-08 sem token (%j), outro host continua sem resposta',
    (token) => {
      expect(answer(request('protocol=https', 'host=gitlab.com'), token)).toBe(
        '',
      );
      expect(
        answer(
          request('protocol=https', 'host=github.com.evil.example'),
          token,
        ),
      ).toBe('');
      expect(answer(request('protocol=http', 'host=github.com'), token)).toBe(
        '',
      );
      expect(answer(request('protocol=ssh', 'host=github.com'), token)).toBe(
        '',
      );
    },
  );

  it('AI-08 pedido sem host ou sem protocolo não responde', () => {
    expect(answer(request('protocol=https'), TOKEN)).toBe('');
    expect(answer(request('host=github.com'), TOKEN)).toBe('');
    expect(answer('', TOKEN)).toBe('');
    expect(answer('', undefined)).toBe('');
  });
});

// O CLI de verdade, numa cópia dos scripts em um repositório temporário: sem identidade, nenhum token é lido.
describe('AI-08 o credential helper (CLI) sem identidade configurada', () => {
  afterEach(() => {
    cleanupTempDirs();
  });

  it('AI-08 sem identidade, para https://github.com, responde quit=1', () => {
    const dir = makeScriptsSandbox();

    const result = runIsolatedScript(dir, 'git-credential-bot.ts', ['get'], {
      input: request('protocol=https', 'host=github.com'),
    });

    // Compara sem imprimir a saída: se um token real vazasse, a mensagem de falha não o mostraria.
    expect(result.stdout === 'quit=1\n').toBe(true);
  }, 30_000);

  it('AI-08 sem identidade, para outro host, continua sem resposta', () => {
    const dir = makeScriptsSandbox();

    const result = runIsolatedScript(dir, 'git-credential-bot.ts', ['get'], {
      input: request('protocol=https', 'host=gitlab.com'),
    });

    expect(result.stdout).toBe('');
  }, 30_000);
});
