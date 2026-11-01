import { configDefaults, defineConfig } from 'vitest/config';

// O projeto integration sobe um PostgreSQL e um ElasticMQ por rodada, no
// globalSetup; cada arquivo clona o próprio banco do modelo migrado e usa
// filas com prefixo próprio, então as pastas seguem isoladas e em qualquer
// ordem (FND-14).
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
          globalSetup: ['./test/integration/global-setup.ts'],
          // Com um contêiner por arquivo, mais de 4 arquivos ao mesmo tempo
          // derrubaram um banco no Docker de 4 CPUs e 6 GB (FND-13). Com os
          // contêineres da rodada (FND-14), o limite é revisto pela medição.
          maxWorkers: 4,
        },
      },
    ],
  },
});
