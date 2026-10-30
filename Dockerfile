# Mesma versão do .nvmrc. A imagem roda o TypeScript direto, com o type stripping do Node.
FROM node:26.13.0

ENV NODE_ENV=production
WORKDIR /app

# Dependências antes do código, para o cache de camadas sobreviver a mudanças em src/.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "src/main/api.ts"]
