import { configDefaults, defineConfig } from 'vitest/config';

// Sem globalSetup: cada teste de integração sobe o próprio contêiner,
// para que as pastas rodem isoladas e em qualquer ordem.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          // Todo *.test.ts fora da integração é unitário, onde quer que esteja: um
          // teste fora das pastas listadas não rodaria e o CI ficaria verde sem
          // ele (AI-02). Os unitários ficam ao lado do arquivo que testam.
          // A varredura com ** não entra em pastas que começam com ponto, então os
          // testes dos hooks e das permissões, em .claude/, entram pelo próprio padrão.
          include: ['**/*.test.ts', '.claude/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/integration/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
