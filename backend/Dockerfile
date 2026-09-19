# syntax=docker/dockerfile:1.7
#
# Imagem de producao da API.
#
# Contexto de build = RAIZ do monorepo (precisa dos workspaces `shared` e
# `backend` e do package-lock unico):
#     docker build -f backend/Dockerfile -t crm-lab-backend .
#
# Notas de empacotamento (ver DECISIONS.md D-050):
#  - `tsc -p tsconfig.build.json` usa `rootDir: ".."`, entao a saida e
#    `dist/backend/src/**` + `dist/shared/types/**` — NAO `dist/main.js`.
#  - o codigo emitido mantem o import bare `@crm-lab/shared`, que no repo
#    resolve para `shared/types/index.ts` (TypeScript, que o Node nao executa).
#    Na imagem, esse pacote e substituido por um shim apontando para o JS ja
#    compilado em `dist/shared/types/`.
#  - `backend/migrations/*.sql` sao lidas do disco em runtime pelo migrator
#    (ele sobe a partir do proprio modulo procurando `migrations/`), por isso
#    sao copiadas para a imagem.

# ---------------------------------------------------------------------------
# Stage 1 — dependencias completas (dev incluidas) para compilar
# ---------------------------------------------------------------------------
FROM node:25-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY e2e/package.json e2e/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 2 — build (shared + backend)
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY backend/ backend/

RUN npm run build --workspace shared \
 && npm run build --workspace backend \
 && test -f backend/dist/backend/src/main.js \
 && test -f backend/dist/shared/types/index.js

# ---------------------------------------------------------------------------
# Stage 3 — dependencias apenas de producao
# ---------------------------------------------------------------------------
FROM node:25-alpine AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY e2e/package.json e2e/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace backend --include-workspace-root \
 && rm -rf node_modules/@crm-lab

# ---------------------------------------------------------------------------
# Stage 4 — runtime
# ---------------------------------------------------------------------------
FROM node:25-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

RUN apk add --no-cache curl tini

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/migrations ./migrations

# Shim do workspace compartilhado apontando para o JS compilado.
RUN mkdir -p node_modules/@crm-lab/shared \
 && cp -R dist/shared/types node_modules/@crm-lab/shared/types \
 && printf '%s\n' \
      '{' \
      '  "name": "@crm-lab/shared",' \
      '  "version": "1.0.0",' \
      '  "private": true,' \
      '  "type": "module",' \
      '  "main": "./types/index.js",' \
      '  "types": "./types/index.d.ts",' \
      '  "exports": { ".": "./types/index.js" }' \
      '}' > node_modules/@crm-lab/shared/package.json \
 && printf '%s\n' '{ "name": "crm-lab-backend-runtime", "private": true, "type": "module" }' \
      > package.json

# `/data/media` (Onda 8 §4 — MEDIA_DIR) e a UNICA escrita em disco em runtime,
# via o volume nomeado `media-data` do compose de producao. O Docker copia o
# conteudo (e a permissao) deste diretorio da IMAGEM para dentro do volume na
# primeira montagem — por isso ele precisa existir e ja pertencer a `node`
# AQUI, antes do volume nascer, senao a primeira escrita falha com EACCES
# (o mount point de um volume nomeado nasce `root:root` por padrao).
RUN mkdir -p /data/media && chown node:node /data/media

# `node` (uid 1000) ja existe na imagem base. Fora de `/data/media` (acima) e
# `/tmp` (tmpfs do compose), nada mais e escrito em disco em runtime.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# tini como PID 1: encaminha SIGTERM para o Node, que ja tem shutdown limpo.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/backend/src/main.js"]
