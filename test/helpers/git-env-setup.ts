// AI-17: sob um hook do git (o pre-push roda o `npm run verify`), o git exporta GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE, GIT_COMMON_DIR e outras para o hook e para tudo que ele inicia. Os testes que montam um
// repositório temporário e chamam `git` herdariam essas variáveis, e o git operaria no repositório de verdade em vez
// do temporário (config, branches, HEAD). O vitest.config.ts liga este arquivo como `setupFiles` dos dois projetos,
// antes de qualquer outro, e ele tira do ambiente do teste toda variável que começa por GIT_.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}
