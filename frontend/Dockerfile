# syntax=docker/dockerfile:1.7
#
# Imagem de producao da UI: bundle estatico servido por nginx.
#
# Contexto de build = RAIZ do monorepo (o frontend importa `@crm-lab/shared`):
#     docker build -f frontend/Dockerfile -t crm-lab-frontend .
#
# As variaveis `VITE_*` sao BUILD-TIME (o Vite as inlina no bundle). Nao sao
# segredo — sao URLs publicas — mas mudar de ambiente exige rebuild da imagem.
# Default `/api/v1` e `/ws`: mesmo origin, com o proprio nginx fazendo proxy
# para a API. Assim nao ha CORS e nenhuma URL de backend fica exposta.
#
# Imagens base pinadas por digest (CRMLAB-36) — mesmo motivo do backend/Dockerfile.
ARG NODE_BASE=node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
ARG NGINX_BASE=nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

# ---------------------------------------------------------------------------
# Stage 1 — build do bundle
# ---------------------------------------------------------------------------
FROM ${NODE_BASE} AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY e2e/package.json e2e/

RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspaces --include-workspace-root

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY frontend/ frontend/

ARG VITE_API_URL=/api/v1
ARG VITE_WS_URL=/ws
# Ambiente do build. Default `production` = sem selo na tela; homologacao
# passa `homologacao` e a Sidebar pinta o selo (docs/guides/ENVIRONMENTS.md).
ARG VITE_APP_ENV=production
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_WS_URL=${VITE_WS_URL} \
    VITE_APP_ENV=${VITE_APP_ENV}

# `frontend/.env` e ignorado pelo .dockerignore — o bundle so ve os ARGs acima.
RUN npm run build --workspace frontend \
 && test -f frontend/dist/index.html

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM ${NGINX_BASE} AS runtime

# Upstream da API, resolvido por envsubst no boot do container.
ENV API_UPSTREAM=http://backend:3000

# A imagem oficial roda envsubst sobre /etc/nginx/templates/*.template e
# escreve o resultado em /etc/nginx/conf.d/.
COPY nginx/frontend.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/frontend/dist /usr/share/nginx/html

# Permite ao usuario `nginx` (uid 101) escrever o conf gerado, o pid e os temps.
RUN sed -i 's#^pid .*#pid /tmp/nginx.pid;#; /^user /d' /etc/nginx/nginx.conf \
 && chown -R nginx:nginx /etc/nginx/conf.d /var/cache/nginx /usr/share/nginx/html \
 && chmod -R u+w /etc/nginx/conf.d

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
