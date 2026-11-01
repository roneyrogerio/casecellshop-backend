// Captura as uncaughtException do processo durante um cenário. O vitest ouve uncaughtException e reprovaria a
// execução inteira por causa de um controle negativo que provoca o erro de propósito: os ouvintes dele saem
// durante o cenário e voltam em `restore()`.
export interface UncaughtCapture {
  errors: Error[];
  restore: () => void;
}

export function captureUncaught(): UncaughtCapture {
  const errors: Error[] = [];
  const previous = process.listeners('uncaughtException');
  process.removeAllListeners('uncaughtException');
  process.on('uncaughtException', (error) => {
    errors.push(error);
  });
  return {
    errors,
    restore() {
      process.removeAllListeners('uncaughtException');
      for (const listener of previous)
        process.on('uncaughtException', listener);
    },
  };
}
