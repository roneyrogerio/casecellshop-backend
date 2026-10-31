// SQLSTATE de espera além do lock_timeout, cancelamento pelo statement_timeout e deadlock.
const UNAVAILABLE_SQLSTATES = new Set(['55P03', '57014', '40P01']);

// Separa a falha do banco (o cliente pode tentar de novo: 503) de um defeito do código (500).
export function isUnavailable(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof code === 'string') {
    if (UNAVAILABLE_SQLSTATES.has(code)) return true;
    // Classe 08 (conexão) e 57P (desligamento do servidor).
    if (/^(08|57P)/.test(code)) return true;
    // Erros de rede do Node (ECONNREFUSED, ETIMEDOUT...) não são SQLSTATE de 5 caracteres.
    if (/^E[A-Z]{4,}$/.test(code)) return true;
  }
  // O pg-pool não dá código à espera esgotada por uma conexão nem à conexão encerrada.
  return typeof message === 'string' && /timeout exceeded when trying to connect|connection terminated|connection error/i.test(message);
}
