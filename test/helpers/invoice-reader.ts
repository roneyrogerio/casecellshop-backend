import type { ErpInvoiceReader } from '../../src/erp/transport.ts';

// Leitura do banco do ERP (AD-031) falsa, para os testes de unidade da camada anticorrupção: é uma porta nossa,
// sem banco nem fila por trás. Os testes de integração usam o `invoiceReader` do ERP simulado.

export interface FakeInvoiceReader extends ErpInvoiceReader {
  calls: { reference: string; signal: AbortSignal }[];
}

export function fakeInvoiceReader(
  behavior: (reference: string, signal: AbortSignal) => Promise<number>,
): FakeInvoiceReader {
  const calls: FakeInvoiceReader['calls'] = [];
  return {
    calls,
    countInvoices(reference, signal) {
      calls.push({ reference, signal });
      return behavior(reference, signal);
    },
  };
}

// Conta o que o teste mandar (por padrão, nenhuma fatura): serve a quem não exercita a contagem.
export function countingInvoices(count = 0): FakeInvoiceReader {
  return fakeInvoiceReader(() => Promise.resolve(count));
}

export function rejectingInvoices(
  error: Error = new Error('mysql indisponível'),
): FakeInvoiceReader {
  return fakeInvoiceReader(() => Promise.reject(error));
}

// Como o contrato do leitor manda: rejeita com o motivo do sinal quando ele aborta.
export function hangingInvoices(): FakeInvoiceReader {
  return fakeInvoiceReader(
    (_reference, signal) =>
      new Promise<number>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error), {
          once: true,
        });
      }),
  );
}

// Ignora o sinal e só responde quando o teste mandar: prova que o timeout limita a chamada mesmo assim.
export function deferredInvoices(): FakeInvoiceReader & {
  respond(value: unknown): void;
} {
  let respond: (value: number) => void = () => undefined;
  const reader = fakeInvoiceReader(
    () =>
      new Promise<number>((resolve) => {
        respond = resolve;
      }),
  );
  return {
    ...reader,
    respond: (value) => respond(value as number),
  };
}
