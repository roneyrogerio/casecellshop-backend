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
      thresholds: { lines: 92, functions: 92, branches: 83, statements: 91 },
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
          // As worktrees dos agentes isolados ficam em .claude/worktrees/ e
          // repetiriam a suíte inteira, com o código de outra versão.
          exclude: [
            ...configDefaults.exclude,
            'test/integration/**',
            '.claude/worktrees/**',
          ],
          // AI-52: o unit roda antes do integration, na mesma execução e no
          // mesmo relatório. Os testes de hooks abrem centenas de processos git
          // e node, e não disputam a CPU com os prazos da integração (FND-13).
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          sequence: { groupOrder: 2 },
          // Cada arquivo de integração sobe o próprio PostgreSQL e ElasticMQ;
          // com mais de 4 ao mesmo tempo, o Docker de 4 CPUs e 6 GB derrubou um
          // banco no meio da suíte (FND-13). O PR C troca isso por um contêiner
          // por rodada (FND-14), e aí este limite é revisto.
          maxWorkers: 4,
        },
      },
    ],
  },
});
