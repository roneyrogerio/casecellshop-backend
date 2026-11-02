// Porta do cache de latência (AD-005): uma entrada só, carregada por uma função de origem. Genérica e sem
// telemetria: quem a usa mede pelo resultado de cada leitura.
import type { Clock } from '../shared/clock.ts';

// hit: dentro do TTL; miss: esperou uma carga que deu certo; stale: expirada, servida por erro ou pausa da origem.
export type CacheResult = 'hit' | 'miss' | 'stale';

export interface CacheLookup<V> {
  value: V;
  result: CacheResult;
  // Idade da entrada servida, desde o fim da carga que a gerou, pelo relógio injetável.
  ageMs: number;
}

export interface Cache<V> {
  // Rejeita com CacheUnavailableError quando não há entrada servível e a origem falhou ou está em pausa.
  get(): Promise<CacheLookup<V>>;
}

export interface InMemoryCacheOptions<V> {
  // A origem; uma carga por vez (single-flight), e a promessa rejeitada é descartada.
  load: () => Promise<V>;
  clock: Clock;
  ttlMs: number;
  // Fração do TTL sorteada para mais ou para menos (0,1 = ±10%).
  ttlJitter: number;
  // Idade máxima da entrada servida depois de um erro da origem.
  staleCeilingMs: number;
  // Depois de uma falha da origem, quanto tempo servir a entrada antiga (ou recusar) sem chamar a origem.
  failurePauseMs: number;
  // Sorteio em [0, 1), injetável para os testes.
  random: () => number;
}

// Sem entrada servível: a rota responde 503 com Retry-After.
export class CacheUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('cache sem entrada servível e origem indisponível', options);
    this.name = 'CacheUnavailableError';
  }
}

interface Entry<V> {
  value: V;
  loadedAt: number;
  // Sorteado a cada carga: instâncias que subiram juntas não expiram juntas.
  ttlMs: number;
}

// A entrada expirada só é servida dentro do teto de idade.
function staleLookup<V>(
  entry: Entry<V> | undefined,
  now: number,
  staleCeilingMs: number,
): CacheLookup<V> | undefined {
  if (!entry || now - entry.loadedAt > staleCeilingMs) return undefined;
  return { value: entry.value, result: 'stale', ageMs: now - entry.loadedAt };
}

function jitteredTtl(options: {
  ttlMs: number;
  ttlJitter: number;
  random: () => number;
}): number {
  return options.ttlMs * (1 + options.ttlJitter * (2 * options.random() - 1));
}

export function createInMemoryCache<V>(
  options: InMemoryCacheOptions<V>,
): Cache<V> {
  const { clock } = options;
  let entry: Entry<V> | undefined;
  let pausedUntil = 0;
  let inFlight: Promise<V> | undefined;
  const stale = (now: number) =>
    staleLookup(entry, now, options.staleCeilingMs);

  // Uma carga por vez; a promessa é descartada ao terminar, com sucesso ou erro, para a próxima leitura recomeçar.
  const startLoad = (): Promise<V> => {
    inFlight ??= options
      .load()
      .then((value) => {
        entry = { value, loadedAt: clock.now(), ttlMs: jitteredTtl(options) };
        pausedUntil = 0;
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    async get() {
      const now = clock.now();
      if (entry && now - entry.loadedAt < entry.ttlMs) {
        return {
          value: entry.value,
          result: 'hit',
          ageMs: now - entry.loadedAt,
        };
      }
      if (now < pausedUntil) {
        const served = stale(now);
        if (served) return served;
        throw new CacheUnavailableError();
      }
      try {
        const value = await startLoad();
        return { value, result: 'miss', ageMs: 0 };
      } catch (cause) {
        pausedUntil = clock.now() + options.failurePauseMs;
        const served = stale(clock.now());
        if (served) return served;
        throw new CacheUnavailableError({ cause });
      }
    },
  };
}
