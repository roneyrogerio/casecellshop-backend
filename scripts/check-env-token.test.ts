import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

type TokenCheck =
  | { result: 'missing' }
  | { result: 'valid'; login: string }
  | { result: 'refused' }
  | { result: 'unreachable' };
type FetchFn = typeof fetch;

let checkToken: (token: string | undefined, deps?: { fetch?: FetchFn }) => Promise<TokenCheck> = () =>
  Promise.resolve({ result: 'não carregado' } as unknown as TokenCheck);
let tokenLogin: (token: string | undefined) => Promise<string | null> = () => Promise.resolve('não carregado');

// Import dinâmico: assim o teste falha com "módulo inexistente" enquanto o módulo não existe, sem quebrar o typecheck.
beforeAll(async () => {
  const mod = (await import(pathToFileURL(join(import.meta.dirname, 'check-env.ts')).href)) as {
    checkToken?: typeof checkToken;
    tokenLogin: typeof tokenLogin;
  };
  // Ausente até a implementação existir: o teste falha na asserção, não na importação.
  if (mod.checkToken) checkToken = mod.checkToken;
  tokenLogin = mod.tokenLogin;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown = {}): FetchFn {
  return vi.fn<FetchFn>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('AI-14 checkToken separa recusado de sem conferência', () => {
  it('AI-14 sem token devolve missing e não chama a API', async () => {
    const fetcher = respond(200, { login: 'minha-conta' });

    expect(await checkToken(undefined, { fetch: fetcher })).toEqual({ result: 'missing' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('AI-14 resposta 200 com o login devolve valid com o login', async () => {
    const fetcher = respond(200, { login: 'minha-conta' });

    expect(await checkToken('tok', { fetch: fetcher })).toEqual({ result: 'valid', login: 'minha-conta' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('AI-14 resposta 401 devolve refused (o token foi recusado)', async () => {
    expect(await checkToken('tok', { fetch: respond(401, { message: 'Bad credentials' }) })).toEqual({
      result: 'refused',
    });
  });

  it('AI-14 falha de rede (o fetch lança) devolve unreachable, não refused', async () => {
    const fetcher = vi.fn<FetchFn>(() => Promise.reject(new TypeError('fetch failed')));

    expect(await checkToken('tok', { fetch: fetcher })).toEqual({ result: 'unreachable' });
  });

  it.each([500, 502, 503])('AI-14 resposta %i da API devolve unreachable, não refused', async (status) => {
    expect(await checkToken('tok', { fetch: respond(status) })).toEqual({ result: 'unreachable' });
  });

  // Decisão: o 403 conta como unreachable, porque pode ser limite de taxa da API, e não prova que o token é ruim.
  // Só o 401 prova que a credencial foi recusada.
  it('AI-14 resposta 403 devolve unreachable (pode ser limite de taxa), não refused', async () => {
    expect(await checkToken('tok', { fetch: respond(403, { message: 'API rate limit exceeded' }) })).toEqual({
      result: 'unreachable',
    });
  });
});

describe('AI-14 tokenLogin continua devolvendo o login só quando o token vale', () => {
  it('AI-14 tokenLogin devolve o login no valid e null no recusado e na falta de conferência', async () => {
    vi.stubGlobal('fetch', respond(200, { login: 'minha-conta' }));
    expect(await tokenLogin('tok')).toBe('minha-conta');

    vi.stubGlobal('fetch', respond(401));
    expect(await tokenLogin('tok')).toBeNull();

    vi.stubGlobal('fetch', respond(503));
    expect(await tokenLogin('tok')).toBeNull();

    vi.stubGlobal(
      'fetch',
      vi.fn<FetchFn>(() => Promise.reject(new TypeError('fetch failed'))),
    );
    expect(await tokenLogin('tok')).toBeNull();
  });

  it('AI-14 tokenLogin sem token devolve null', async () => {
    expect(await tokenLogin(undefined)).toBeNull();
  });
});
