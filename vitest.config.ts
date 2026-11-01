import { configDefaults, defineConfig } from 'vitest/config';

// Sem globalSetup: cada teste de integração sobe o próprio contêiner,
// para que as pastas rodem isoladas e em qualquer ordem.
export default defineConfig({
  test: {
    // AI-37: só vale com --coverage, que o CI passa na perna do .nvmrc. Os
    // processos de src/main/ rodam em outro processo ou no compose, fora da
    // medição em processo. O piso é o medido ao criar a checagem, arredondado
    // para baixo, e só sobe.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/db/types/**', 'src/main/**'],
      thresholds: { lines: 1, functions: 1, branches: 1, statements: 1 },
    },
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
