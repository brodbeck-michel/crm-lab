# 🚀 Guia de Deploy e CI/CD

Como o pipeline funciona, o que é necessário para subir a stack em produção e
como voltar atrás quando algo dá errado.

> Escopo: `.github/workflows/`, `backend/Dockerfile`, `frontend/Dockerfile`,
> `nginx/frontend.conf`, `docker-compose.yml` (dev) e `docker-compose.prod.yml`.
> Domínio do **Agent-Infra**.

---

## 1. Pipeline de CI (`.github/workflows/ci.yml`)

Dispara em `push` para `main`, em todo `pull_request` para `main` e manualmente
(`workflow_dispatch`). `concurrency` cancela runs obsoletos do mesmo ref — um
push novo mata o anterior que ainda estivesse rodando.

| Job | Depende de | O que garante |
|-----|-----------|---------------|
| **`quality`** | — | `npm run typecheck` (shared + backend + frontend), `npm run lint`, `npm run test:backend`, `npm run test:frontend`. Sem serviço externo: as suítes de backend, inclusive as de isolamento multitenant, rodam em **PGlite** (D-008). |
| **`build`** | — | `npm run build` compila de verdade os três workspaces e **verifica os artefatos emitidos** (`backend/dist/backend/src/main.js`, `backend/dist/shared/types/index.js`, `frontend/dist/index.html`). Um build que "passa" sem emitir arquivo é falso verde. Publica `build-dist` como artifact (3 dias). |
| **`docker`** | `build` | Constrói as duas imagens de produção (buildx + cache GHA) e afirma que **nenhuma das duas roda como root**. Não publica em registry — não há credencial no CI. |
| **`e2e`** | `quality`, `build` | Postgres 16 como *service*, `npm run migrate` + `npm run seed:e2e` com `DATABASE_URL`, navegador via `npm run e2e:install --workspace e2e`, API + UI no ar, e a suíte Playwright (`npm run e2e`). |

### Detalhes do job `e2e`

1. **Banco:** service `postgres:16-alpine` com healthcheck `pg_isready`. Usuário
   e senha são os mesmos do `docker-compose.yml` de dev — não são segredo, o
   serviço morre com o job.
2. **`NODE_ENV=development`, nunca `test`.** Com `NODE_ENV=test` o backend
   escolhe o driver **PGlite em memória** (D-008) e o seed iria para um banco que
   desaparece com o processo — a suíte rodaria contra um banco vazio.
3. **Segredos de JWT** são gerados no próprio job (`openssl rand -hex 32`) e
   exportados via `$GITHUB_ENV`. Nada de valor fixo no YAML.
4. **API e UI** sobem com `npm run dev` (`npm-run-all --parallel`), exatamente
   como `e2e/playwright.config.ts` documenta ("started manually: `npm run dev`") —
   o config traz `webServer: undefined`. O passo seguinte espera
   `GET http://localhost:3000/health` e `http://localhost:5173/` responderem, com
   teto de 120s; se estourar, o log dos servidores é impresso e o job falha.
5. **Falha é falha.** Não existe `continue-on-error` neste job (D-052). Em caso
   de falha sobem dois artifacts: `playwright-report`
   (`e2e/playwright-report/` + `e2e/test-results/`) e `server-logs`.

### Cache

- Dependências npm: `actions/setup-node` com `cache: npm` (chave = `package-lock.json`).
- Navegadores do Playwright: `actions/cache` em `~/.cache/ms-playwright`.
- Camadas Docker: `type=gha` no `docker/build-push-action`.

---

## 2. Imagens de produção

Ambas usam a **raiz do monorepo como contexto de build** (precisam do workspace
`shared` e do `package-lock.json` único).

### `backend/Dockerfile`

Multi-stage: `deps` (npm ci completo) → `build` (tsc) → `prod-deps`
(`npm ci --omit=dev`) → `runtime` (`node:22-alpine`, usuário `node` uid 1000,
`tini` como PID 1, `HEALTHCHECK` em `/health`).

Três pegadinhas de empacotamento que o Dockerfile resolve (ver **D-050**):

- `tsconfig.build.json` usa `rootDir: ".."`, então a saída é
  `dist/backend/src/**` + `dist/shared/types/**` — **não** `dist/main.js`. O
  `CMD` da imagem é `node dist/backend/src/main.js`.
  ⚠️ O script `start` de `backend/package.json` (`node dist/main.js`) aponta para
  um caminho que não existe. Está fora do domínio do Agent-Infra; enquanto não
  for corrigido, **não use `npm start` para subir a API**.
- O JS emitido mantém o import bare `@crm-lab/shared`, que no repo resolve para
  `shared/types/index.ts` — TypeScript, que o Node não executa. Na imagem, esse
  pacote é substituído por um shim apontando para o JS já compilado em
  `dist/shared/types/`.
- `backend/migrations/*.sql` são lidas do disco em runtime pelo migrator, então
  são copiadas para a imagem (`/app/migrations`).

O container roda com `read_only: true` + `tmpfs:/tmp` no compose de produção:
nada é escrito em disco.

### `frontend/Dockerfile`

Multi-stage: `build` (vite) → `runtime` (`nginx:1.27-alpine`, usuário `nginx`
uid 101, porta **8080**).

As variáveis `VITE_*` são **build-time** — o Vite as inlina no bundle. Não são
segredo (são URLs públicas), mas trocar de ambiente exige **rebuild da imagem**.
Defaults `/api/v1` e `/ws`: mesmo origin, com o próprio nginx fazendo proxy para
a API (`nginx/frontend.conf`, upstream em `API_UPSTREAM`). Isso elimina CORS e
não expõe a URL do backend.

`frontend/.env` é ignorado pelo `.dockerignore` — o bundle só enxerga os `ARG`s.

### `docker-compose.prod.yml`

`postgres` · `redis` · `migrate` (job one-shot) · `backend` · `frontend`.
Nenhum valor sensível está no arquivo: toda chave crítica usa
`${VAR:?mensagem}`, que **falha explicitamente** se não estiver no ambiente.
Postgres, Redis e backend **não publicam porta** — só o nginx do frontend
(`${HTTP_PORT:-8080}`) é acessível de fora.

---

## 3. Variáveis de ambiente

Fonte única: **`backend/.env.example`**. Nenhum valor real aparece neste doc.

### Backend (obrigatórias em `NODE_ENV=production`)

`src/config/env.ts` recusa subir sem elas:

| Variável | Regra em produção |
|---|---|
| `DATABASE_URL` | obrigatória; sem ela o driver cai em PGlite (D-008) |
| `JWT_SECRET` | obrigatória, **≥ 32 caracteres**, e não pode ser o placeholder do `.env.example` |
| `JWT_REFRESH_SECRET` | idem |
| `CHANNEL_SECRET_KEY` | obrigatória, **≥ 32 caracteres** — cifra credencial de canal em repouso (D-076) |
| `MEDIA_DIR` | obrigatória (Onda 8 §4) — caminho do volume de mídia; no `docker-compose.prod.yml` é `/data/media`, montado do volume nomeado `media-data` |

### Backend (com default, ajuste conforme o ambiente)

`NODE_ENV` · `PORT` (3000) · `LOG_LEVEL` (info) · `REDIS_URL` (sem ela, cache e
fila usam adaptador in-memory — D-011) · `JWT_ACCESS_TTL` (900) ·
`JWT_REFRESH_TTL` (604800) · `CORS_ORIGIN` (origem da UI) ·
`RATE_LIMIT_PER_MINUTE` (100).

### WhatsApp

`WHATSAPP_API_URL` · `WHATSAPP_API_TOKEN` · `WHATSAPP_WEBHOOK_SECRET`.
Vazias = driver **mock** que ecoa (bom para dev, nunca para produção).

⚠️ Dois pontos vindos do Agent-API-Conversations:
- A URL do webhook configurada no provedor **precisa incluir o slug do
  laboratório**: `POST /api/v1/webhooks/whatsapp/<slug>` (e `.../status`) — D-032.
- `WHATSAPP_WEBHOOK_SECRET` é obrigatória para o webhook aceitar qualquer coisa:
  **segredo vazio recusa tudo, de propósito**.

### Frontend (build-time)

`VITE_API_URL` · `VITE_WS_URL` (`frontend/.env.example`). Passadas como `ARG` no
build da imagem.

### Onde os valores moram

- **CI:** nada sensível. Os segredos de JWT do job `e2e` são gerados no run.
- **Produção:** GitHub Secrets / gestor de segredos do host, injetados como env
  vars no `docker compose`. **Nunca** commitar `.env`; `.dockerignore` e
  `.gitignore` já bloqueiam.

---

## 4. Deploy

```bash
# 1. Ambiente (a partir de backend/.env.example + as chaves do compose de prod)
export DATABASE_URL=... POSTGRES_USER=... POSTGRES_PASSWORD=...
export JWT_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export CORS_ORIGIN=https://<dominio-da-ui>
export IMAGE_TAG=$(git rev-parse --short HEAD)

# 2. Build das imagens
docker compose -f docker-compose.prod.yml build

# 3. Migração — SEMPRE antes de subir a aplicação nova
docker compose -f docker-compose.prod.yml run --rm migrate

# 4. Subir
docker compose -f docker-compose.prod.yml up -d
#    ⚠️ Primeiro deploy do servico `evolution` (D-083) num host que JA TINHA
#    o volume `postgres-data` provisionado de antes da Onda 7: o script que
#    cria o banco `evolution` (`postgres-init/`) so roda em volume vazio —
#    ver "Pegadinhas conhecidas" (§6) para o sintoma e a recuperacao

# 5. Conferir
curl -fsS http://localhost:${HTTP_PORT:-8080}/healthz          # nginx
docker compose -f docker-compose.prod.yml exec backend \
  wget -qO- http://127.0.0.1:3000/health                       # API
```

### Passo de migração

O runner aplica `backend/migrations/*.sql` em **ordem lexical**, cada arquivo
inteiro em uma transação, registrando o nome em `schema_migrations` (tabela
criada pelo próprio runner). É **idempotente**: rodar duas vezes não repete nada.

Regra do Agent-DB, válida também aqui: **nunca editar migração já aplicada** —
criar uma nova. Renomear coluna são três migrações (criar nova → migrar dados →
remover antiga), justamente para que uma versão antiga da aplicação continue
funcionando durante o deploy.

### Seeds

- `npm run seed` → dataset de **desenvolvimento** (3 tenants, 106 exames, 114
  conversas...).
- `npm run seed:e2e` → dataset **fixo e determinístico** usado pelo Playwright.
- Ambos são idempotentes (truncate + recria) e **recusam rodar com
  `NODE_ENV=production`**. Seed nunca faz parte de um deploy de produção.

🪤 **Pegadinha registrada em STATUS.md (Agent-DB-Seeds → Agent-Infra):**
`npm run seed` **sem `DATABASE_URL` cai no PGlite em memória** (D-008) — o dado
some quando o processo termina, sem erro nenhum. Para semear o Postgres do
`docker-compose`, é preciso `backend/.env` com `DATABASE_URL` (o `.env.example`
já traz a URL correta) ou exportá-la no shell. O mesmo vale para
`npm run migrate`.

🪤 O RLS só funciona se a conexão do app usar o papel `crm_app` e cada transação
abrir com `SET LOCAL app.tenant_id` — é o que `db.withTenant()` faz. Sem isso,
**0 linhas visíveis** (fail-closed). O papel é criado pela migração `002`.

---

## 5. Rollback

O critério é: **schema é compatível com a versão anterior?**

### a) Só a aplicação mudou (nenhuma migração nova)

```bash
export IMAGE_TAG=<sha-anterior>
docker compose -f docker-compose.prod.yml up -d backend frontend
```

As imagens são versionadas por `IMAGE_TAG`; voltar é trocar a tag e subir.

### b) Houve migração nova

Não existe `down` no runner — **a migração só anda para frente**. Duas saídas:

1. **Compatível (o caso normal):** migrações aditivas (coluna nova opcional,
   tabela nova, índice) não quebram a versão anterior. Basta voltar as imagens
   como em (a) e deixar o schema onde está.
2. **Incompatível:** restaurar o backup do Postgres tomado **antes** do passo 3
   e voltar as imagens. Por isso o backup é pré-requisito do deploy:

```bash
# ANTES de migrar
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > backup-$(date +%F-%H%M).dump

# Restauração
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backup-....dump
```

Escreva migrações aditivas sempre que possível — é o que torna o rollback (1)
possível e evita a rota (2).

---

## 6. Pegadinhas conhecidas

| Sintoma | Causa | Saída |
|---|---|---|
| `npm run seed`/`migrate` "funciona" e o banco continua vazio | `DATABASE_URL` ausente → PGlite em memória (D-008) | exportar `DATABASE_URL` ou criar `backend/.env` |
| Seed vai para o lugar errado no CI | `NODE_ENV=test` força PGlite | usar `NODE_ENV=development` no job |
| `npm start` no backend: `Cannot find module dist/main.js` | build emite `dist/backend/src/main.js` (`rootDir: ".."`) | usar o caminho real; a imagem já faz isso |
| API compilada: `ERR_MODULE_NOT_FOUND .../shared/types/api.types.js` | `@crm-lab/shared` resolve para TypeScript | shim do Dockerfile aponta para `dist/shared/types` |
| Toda query devolve 0 linhas | conexão sem `crm_app` / sem `app.tenant_id` | usar `db.withTenant()`; conferir migração `002` |
| Backend recusa subir em produção | `JWT_*` ausente, com placeholder, ou < 32 caracteres | gerar segredo real (`openssl rand -hex 32`) |
| Webhook do WhatsApp recusa tudo | `WHATSAPP_WEBHOOK_SECRET` vazia (comportamento intencional) | definir o segredo e usar a URL com slug do tenant |
| E2E passa local e falha no CI | `retries: 2` e `forbidOnly` só ligam com `CI=true` | reproduzir com `CI=true npm run e2e` |
| Vite sobe em 5174 em vez de 5173 | porta ocupada; o config não usa `strictPort` | liberar a 5173 — o gate de readiness do CI falha de propósito |
| `evolution` reinicia em loop após o primeiro deploy da Onda 7 | volume `postgres-data` **já existia** antes deste deploy (host anterior à Onda 7) — o script de `postgres-init/` que cria o banco `evolution` só roda em volume vazio (D-083) | o próprio gateway costuma se recuperar sozinho (roda `prisma migrate` no boot e cria o banco se faltar, usando `$POSTGRES_USER` — superusuário do cluster); se `docker compose ps` mostrar `evolution` reiniciando mesmo assim: `docker compose -f docker-compose.prod.yml exec -T postgres createdb -U "$POSTGRES_USER" evolution` (não apaga nada — nunca use `down -v` em produção) |

---

## 7. O que ainda não está no pipeline

Registrado aqui para não virar promessa implícita:

- **Publicação de imagem em registry e deploy automático.** O job `docker`
  constrói e valida, mas não faz `push` — não há registry nem credencial
  definidos para este projeto. Quando houver, é acrescentar `login-action` +
  `push: true` com secrets.
- **Ambiente de staging.** Não existe host definido.
- **Certificado TLS.** O nginx da imagem serve HTTP em 8080; TLS/HSTS ficam no
  proxy de borda do host.
