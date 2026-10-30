import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

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
    expect(answer(request('protocol=https', 'host=github.com'), TOKEN)).toBe(OK);
  });

  it('AI-08 a ordem das linhas e linhas extras (path) não mudam a resposta', () => {
    expect(answer(request('host=github.com', 'path=roney/repo.git', 'protocol=https'), TOKEN)).toBe(OK);
  });

  it.each(['gitlab.com', 'gist.github.com', 'github.com.evil.example', 'evilgithub.com', 'api.github.com'])(
    'AI-08 não responde para o host %s',
    (host) => {
      expect(answer(request('protocol=https', `host=${host}`), TOKEN)).toBe('');
    },
  );

  it.each(['http', 'ssh', 'git'])('AI-08 não responde para o protocolo %s', (protocol) => {
    expect(answer(request(`protocol=${protocol}`, 'host=github.com'), TOKEN)).toBe('');
  });

  it('AI-08 sem token (undefined) não responde', () => {
    expect(answer(request('protocol=https', 'host=github.com'), undefined)).toBe('');
  });

  it('AI-08 com token vazio não responde', () => {
    expect(answer(request('protocol=https', 'host=github.com'), '')).toBe('');
  });

  it('AI-08 pedido sem host ou sem protocolo não responde', () => {
    expect(answer(request('protocol=https'), TOKEN)).toBe('');
    expect(answer(request('host=github.com'), TOKEN)).toBe('');
    expect(answer('', TOKEN)).toBe('');
  });
});
