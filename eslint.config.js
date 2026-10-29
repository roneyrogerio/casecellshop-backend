import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'spike/', 'coverage/', 'dist/'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Arquivos em JavaScript (configurações e hooks de .claude/) ficam fora do
    // tsconfig, então não podem usar regras que exigem informação de tipos.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
