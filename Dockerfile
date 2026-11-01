# Mesma versão do .nvmrc. A imagem roda o TypeScript direto, com o type stripping do Node.
FROM node:26.13.0 AS deps

ENV NODE_ENV=production
WORKDIR /app

# Dependências antes do código, para o cache de camadas sobreviver a mudanças em src/.
# Atrás de um proxy que reabre o TLS (o da sessão na nuvem, ou um corporativo), o npm só confia no
# registro com o certificado dele. O scripts/cloud-setup.ts grava esse certificado em .build-ca.pem,
# fora do git; o colchete faz o COPY aceitar o arquivo ausente, e sem ele o build roda como antes
# (AI-51). O certificado fica só neste estágio: a imagem final leva apenas o node_modules.
COPY package.json package-lock.json .build-ca.pe[m] ./
RUN if [ -f .build-ca.pem ]; then export NODE_EXTRA_CA_CERTS=/app/.build-ca.pem; fi; \
    npm ci --omit=dev

FROM node:26.13.0

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY migrations ./migrations

USER node
EXPOSE 3000
CMD ["node", "src/main/api.ts"]
