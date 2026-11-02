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

export function createInMemoryCache<V>(
  _options: InMemoryCacheOptions<V>,
): Cache<V> {
  throw new Error('não implementado');
}
