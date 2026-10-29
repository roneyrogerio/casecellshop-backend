import { defineConfig } from 'vitest/config';

// Sem globalSetup: cada teste de integração sobe o próprio contêiner,
// para que as pastas rodem isoladas e em qualquer ordem.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
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
