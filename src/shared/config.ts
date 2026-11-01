// Lê uma variável obrigatória; falhar na partida é melhor que falhar na primeira consulta.
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

// Variável opcional: vazia conta como ausente (o SQS_ENDPOINT fica vazio na AWS real).
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

export function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Porta inválida em ${name}: ${raw}`);
  return port;
}

// Variável de lista fechada: só o `undefined` usa o padrão; valor vazio ou fora da lista é erro na partida.
export function envChoice<T extends string>(
  name: string,
  choices: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const choice = choices.find((candidate) => candidate === raw);
  if (choice === undefined) throw new Error(`${name} inválido: ${raw}`);
  return choice;
}
