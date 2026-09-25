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
| **`docker`** | `build` | Constrói as imagens de produção (buildx + cache GHA) e afirma que **nenhuma roda como root**. Em `push` para `main` (nunca em PR, CRMLAB-36) também publica no **GHCR**: `crm-lab-backend` (`:<sha>`, `:hml-<sha>`, `:latest` — mesma imagem serve os dois ambientes) e `crm-lab-frontend`, que em vez disso ganha DUAS imagens (`:<sha>` produção, `:hml-<sha>` homologação) porque `VITE_APP_ENV` é build-time e fica inlinado no bundle. |
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
`RATE_LIMIT_PER_MINUTE` (100) · `BITLAB_API_BASE_URL` (`https://integracoes.bitlab.net.br/webhook`) ·
`LIS_SYNC_INTERVAL_MS` (1800000 = 30 min; **`0` desliga o agendador**, e "Sincronizar agora"
continua funcionando) · `LIS_SYNC_INITIAL_DAYS` (90) — CRMLAB-52, D-185. A chave do Bitlab **não**
é env var: é por laboratório, cifrada no banco, e colada pelo admin em Configurações → Integração
LIS.

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

> **O caminho normal é `./scripts/deploy.sh`**, de dentro do diretório do
> ambiente (`/opt/crm-lab` = produção, `/opt/crm-lab-homolog` = homologação).
> Ele faz a sequência abaixo com as travas de identidade, versão e confirmação
> descritas em **`ENVIRONMENTS.md`** — que é também onde estão as diferenças
> entre os dois ambientes. Os comandos crus ficam aqui como referência e para
> quando algo der errado no meio.

```bash
# 1. Ambiente (a partir de backend/.env.example + as chaves do compose de prod)
export DATABASE_URL=... POSTGRES_USER=... POSTGRES_PASSWORD=...
export JWT_SECRET=$(openssl rand -hex 32)
export JWT_REFRESH_SECRET=$(openssl rand -hex 32)
export CORS_ORIGIN=https://<dominio-da-ui>
export IMAGE_TAG=$(git rev-parse --short HEAD)
export IMAGE_REGISTRY=ghcr.io/<owner>/<repo>/   # CRMLAB-36/41 — COM o repo e barra final; vazio = build local (fallback)

# 2. Imagens — pull do GHCR (o CI publica a cada push em `main`, ver §2 e §7).
#    Sem IMAGE_REGISTRY definido, cai no fallback documentado (build local,
#    ~10 min nos 2 vCPU — era o unico caminho antes do CRMLAB-36):
docker compose -f docker-compose.prod.yml pull
# docker compose -f docker-compose.prod.yml build   # fallback, so se IMAGE_REGISTRY vazio

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

# 6. Limpeza (CRMLAB-36) — imagem/cache velhos, nunca a tag no ar:
docker image prune -af --filter 'until=336h'
docker builder prune -f --filter 'until=168h'
```

`./scripts/deploy.sh` faz os passos 1-6 automaticamente (2 e 6 com o fallback
e o "best-effort" descritos acima).

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

### Backup e restore

O dump manual acima continua sendo pré-requisito do deploy, mas **não é mais a
única rede de proteção**. Até a auditoria de 2026-09-17 não havia backup nenhum
em produção: o único dump existente era anterior a todas as mensagens e
conversas que já estavam no ar — perder o volume era perder tudo.

São **três camadas**, e cada uma cobre uma falha que a anterior não cobre:

| Camada | O quê | Onde | Retenção | Cobre |
|---|---|---|---|---|
| Local | `crm_lab.dump`, `evolution.dump` | `/opt/crm-lab/backups` (disco da VPS) | 14 dias | `DROP TABLE` errado, migração ruim |
| Externa | os dois dumps **+ tar da mídia**, cifrados | GitHub Releases, repo privado | 30 dias | perder a VPS inteira |
| Manual | dump pré-deploy | onde você rodou | você | rollback com migração incompatível |

#### O que roda, e quando

`crm-lab-backup.timer` dispara `crm-lab-backup.service` às 03:10 (UTC) todo dia.
O service tem **dois** `ExecStart`, nesta ordem:

1. `scripts/backup-postgres.sh` — dump dos dois bancos, local.
2. `scripts/backup-offsite.sh` — cifra e sobe para fora da VPS.

A ordem não é decorativa: o systemd para no primeiro `ExecStart` que falha.
Assim o dump local, que é a última linha de defesa, sempre acontece antes; e
uma queda de rede no envio externo nunca impede o backup local do dia.

`evolution` entra no backup junto com `crm_lab` porque, embora perdê-lo não
perca nenhum dado do CRM, ele guarda as credenciais da sessão Baileys: sem ele,
voltar ao ar exige parear o número de novo lendo o QR no celular do
laboratório — uma parada de atendimento, não um inconveniente.

A mídia (`crm-lab-prod_media-data`) **não viaja no dump**. `message_media`
referencia o arquivo, mas o arquivo mora no volume. Restaurar só o banco deixa
toda foto de pedido médico e todo áudio como "não foi possível carregar" — foi
exatamente o que pareceu bug de tela em homologação em 19/09. Por isso o tar do
volume sobe junto na cópia externa.

```bash
# Instalação (uma vez, na VPS)
sudo cp scripts/systemd/crm-lab-backup.service \
        scripts/systemd/crm-lab-backup.timer \
        scripts/systemd/crm-lab-backup-alerta@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now crm-lab-backup.timer
# A unidade de alerta tem `SupplementaryGroups=systemd-journal` (revisão do PR
# #24): sem isso o `journalctl -u` que ela roda para anexar o contexto voltava
# vazio para o usuário `deploy`, e o alerta chegava sem uma linha de log. Depois
# de copiar uma versão nova da unit: `daemon-reload` de novo.

# Conferir
systemctl list-timers crm-lab-backup.timer
journalctl -u crm-lab-backup.service -n 30

# Rodar agora, fora do horário
/opt/crm-lab/scripts/backup-postgres.sh
/opt/crm-lab/scripts/backup-offsite.sh

# Ensaiar o envio externo sem tocar no GitHub nem no Docker
BACKUP_OFFSITE_DRYRUN=1 /opt/crm-lab/scripts/backup-offsite.sh
```

#### ⚠️ A CHAVE DE CIFRAGEM

> **CHAVE PERDIDA = BACKUP INÚTIL. NÃO EXISTE RECUPERAÇÃO.**
>
> Tudo que sobe para o GitHub é cifrado antes de sair da VPS. Sem a chave
> privada, os arquivos da release são ruído — nem o Michel, nem o GitHub, nem
> ninguém decifra. Não há "esqueci minha senha".
>
> A chave privada mora **fora da VPS e fora do repositório**, com o Michel.
> Guarde uma segunda cópia em lugar diferente do primeiro (gerenciador de
> senhas **e** papel no cofre, não os dois na mesma máquina). Uma cópia só, na
> mesma máquina que faz o backup, é o mesmo problema que o offsite veio
> resolver.

Cifrar não é zelo extra: os dumps têm nome de paciente, telefone, conversa e
mídia. Mandar isso em claro para um terceiro não passa em LGPD, nem em
repositório privado. O `backup-offsite.sh` **recusa rodar** sem chave
configurada, de propósito.

Dois métodos, nesta preferência:

- **`age` com destinatário** (`BACKUP_AGE_RECIPIENT=age1...`). A VPS guarda só
  a chave **pública**. Quem comprometer o host consegue cifrar backups novos,
  mas **não decifra os antigos** — o que é exatamente a propriedade que se quer
  de um backup contra comprometimento.
- **`gpg` simétrico** (`BACKUP_GPG_PASSPHRASE=...`). Plano B: a mesma senha
  cifra e decifra, e ela precisa morar no `.env` do host. Funciona, protege
  contra o GitHub e contra vazamento da release, mas não contra quem já entrou
  na VPS.

#### Configuração (em `/opt/crm-lab/.env`, nunca no repo)

`.env` já é `chmod 600`. Nada disto entra em git.

| Variável | Obrigatória | O que é |
|---|---|---|
| `BACKUP_OFFSITE_REPO` | sim | `owner/repo` privado de destino |
| `GH_TOKEN` | sim | PAT com escopo `repo`, para o `gh` |
| `BACKUP_AGE_RECIPIENT` | uma das duas | chave **pública** age (`age1...`) |
| `BACKUP_GPG_PASSPHRASE` | uma das duas | senha simétrica |
| `BACKUP_REMOTE_RETENTION_DAYS` | não | default 30 (local é 14) |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_TOKEN` | não | **o mesmo canal do monitor** (`scripts/lib/alerta.sh`) — desde a revisão do PR #24 o alerta de backup usa ele, não um webhook próprio |
| `BACKUP_ALERT_CMD` | não | escotilha: comando que recebe o alerta no stdin (tem precedência) |
| `BACKUP_ALERT_WEBHOOK` | não | **legado** — usado como `ALERT_WEBHOOK_URL` se esta não existir; remova do `.env` ao migrar |

#### Alerta quando o backup falha

Até 19/09 uma falha era **silenciosa**: o timer marcava `failed` e só descobria
quem resolvesse rodar `journalctl`. Backup que falha calado é pior que backup
nenhum, porque dá a sensação de estar protegido.

`crm-lab-backup.service` agora tem `OnFailure=crm-lab-backup-alerta@%n.service`,
que roda `scripts/backup-alerta.sh` com as últimas 20 linhas do journal da
unidade que falhou.

**O canal é plugável de propósito.** O destino final ainda não está decidido (a
preferência é WhatsApp, o que esbarra em depender do gateway que este mesmo
backup protege). Trocar de canal é editar o `.env`:

```bash
# qualquer webhook JSON (Discord, Slack, n8n, gateway próprio)
ALERT_WEBHOOK_URL='https://.../hook'      # o mesmo do monitor; BACKUP_ALERT_WEBHOOK ainda funciona como legado

# ou um comando qualquer, que recebe a mensagem no stdin
BACKUP_ALERT_CMD='mail -s "backup CRM Lab falhou" michel@...'
```

Sem nenhum dos dois, o alerta vai para o syslog com prioridade `err` e o script
sai 0 — ele nunca falha, porque não existe `OnFailure` do `OnFailure`.

Testar o caminho de alerta sem quebrar o backup de verdade:

```bash
sudo systemctl start crm-lab-backup-alerta@crm-lab-backup.service
journalctl -t crm-lab-backup -n 20
```

#### Verifique o dump, não confie nele

Um arquivo com tamanho plausível pode estar truncado; os dois scripts escrevem
em `.partial` e só renomeiam no fim justamente para que um dump interrompido
nunca se pareça com um bom. Mas a conferência real é listar o conteúdo:

```bash
docker compose -f docker-compose.prod.yml cp backups/crm_lab-<stamp>.dump postgres:/tmp/t.dump
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -l /tmp/t.dump | grep 'TABLE DATA'
```

`pg_restore -l` **não** funciona lendo de stdin (o formato custom precisa de
seek no arquivo) — copie para dentro do container, como acima.

A retenção — local e remota — só roda quando **tudo** deu certo: apagar o
backup antigo logo depois de falhar em gerar o novo é a melhor forma de ficar
sem nenhum.

---

### Restore completo, do zero

**Leia isto inteiro antes de digitar o primeiro comando.** Esta seção é escrita
para ser seguida às 3 da manhã, por alguém com pressa e sem contexto.

Antes de tudo: **respire e não apague nada.** Nenhum passo aqui exige
`docker compose down -v`, `volume rm` ou `system prune`. Se algum comando que
você pensou em rodar apaga volume, ele não é deste roteiro.

O que você precisa ter em mãos:

- acesso à VPS (ou a uma VPS nova, se a antiga se perdeu);
- acesso ao repositório privado de backup no GitHub (`gh auth login`);
- **a chave de cifragem** (a privada `age`, ou a senha `gpg`). Sem ela pare
  aqui: não há restore. Ver o aviso acima.

#### Passo 0 — descobrir o que existe

```bash
gh release list --repo "$BACKUP_OFFSITE_REPO" --limit 40
```

As releases se chamam `backup-AAAA-MM-DD`. Pegue a mais recente **anterior ao
incidente** — a mais recente de todas pode já conter o estrago (uma exclusão
acidental de ontem à noite entrou no backup desta madrugada).

#### Passo 1 — baixar

```bash
cd /tmp && mkdir -p restore && cd restore
gh release download backup-2026-09-19 --repo "$BACKUP_OFFSITE_REPO"
ls -la      # espera: crm_lab-*.dump.age, evolution-*.dump.age, media-*.tar.gz.age
```

(`.gpg` em vez de `.age` se o backup foi feito com o método simétrico.)

#### Passo 2 — decifrar

```bash
# age (chave privada num arquivo, ex. ~/chave-backup.txt)
for f in *.age; do age -d -i ~/chave-backup.txt -o "${f%.age}" "$f"; done

# gpg simétrico (vai pedir a senha)
for f in *.gpg; do gpg --output "${f%.gpg}" --decrypt "$f"; done
```

**Confira antes de seguir.** Um dump decifrado com a chave errada não existe —
o comando falha. Mas confirme que os arquivos têm tamanho plausível e que o
dump abre:

```bash
ls -la *.dump *.tar.gz
pg_restore -l crm_lab-*.dump | grep -c 'TABLE DATA'    # > 0
```

Se você não tem `pg_restore` na máquina, copie para dentro do container
Postgres como mostrado na seção anterior.

#### Passo 3 — restaurar os dois bancos

Com a stack de pé (`docker compose -f docker-compose.prod.yml up -d postgres`),
a partir de `/opt/crm-lab`:

```bash
cd /opt/crm-lab
set -a; . ./.env; set +a          # traz POSTGRES_USER

# copia os dumps para dentro do container (pg_restore precisa de seek)
docker compose -f docker-compose.prod.yml cp /tmp/restore/crm_lab-<stamp>.dump   postgres:/tmp/crm_lab.dump
docker compose -f docker-compose.prod.yml cp /tmp/restore/evolution-<stamp>.dump postgres:/tmp/evolution.dump

# banco do CRM
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d crm_lab \
  --clean --if-exists --no-owner --no-privileges /tmp/crm_lab.dump

# banco do gateway de WhatsApp
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d evolution \
  --clean --if-exists --no-owner --no-privileges /tmp/evolution.dump
```

**Avisos `does not exist, skipping` são normais** com `--clean` num banco vazio.
Não interrompa por causa deles. O que importa é o `pg_restore` terminar.

Se o banco `evolution` **não existir** (VPS nova, volume `postgres-data` vazio
ou provisionado antes da Onda 7 — ver §6):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  createdb -U "$POSTGRES_USER" evolution
```

#### Passo 4 — restaurar a mídia

O tar foi feito a partir da **raiz** do volume, então ele se desempacota em
`/m` direto. Produção entra como `rw` aqui (é o destino), e só aqui:

```bash
docker run --rm -i -v crm-lab-prod_media-data:/m alpine tar xzf - -C /m \
  < /tmp/restore/media-<data>.tar.gz

# conferir
docker run --rm -v crm-lab-prod_media-data:/m:ro alpine sh -c 'ls /m | wc -l'
```

#### Passo 5 — subir e conferir de verdade

```bash
cd /opt/crm-lab
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Checklist de "voltou mesmo", nesta ordem — os três, não só o primeiro:

1. **Login funciona** e o painel abre com os números esperados (conversas,
   pacientes). Banco `crm_lab` ok.
2. **Uma conversa com imagem abre a imagem.** Se aparecer "não foi possível
   carregar", o banco voltou mas a mídia não — repita o passo 4.
3. **O WhatsApp está conectado** (`tenant_channels` ativo, sem QR pedindo
   pareamento). Banco `evolution` ok. Se estiver pedindo QR, o dump do
   `evolution` não entrou: alguém vai precisar ler o QR no celular do
   laboratório, e o atendimento fica parado até lá.

#### Passo 6 — voltar o backup a funcionar

Fácil de esquecer no alívio de ter voltado. Numa VPS nova, nada disto existe:

```bash
sudo cp scripts/systemd/crm-lab-backup.service \
        scripts/systemd/crm-lab-backup.timer \
        scripts/systemd/crm-lab-backup-alerta@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now crm-lab-backup.timer
# e conferir que BACKUP_OFFSITE_REPO, GH_TOKEN e a chave estão no .env novo
/opt/crm-lab/scripts/backup-offsite.sh
```

#### RTO — quanto tempo isso leva

`[PENDENTE: medir no primeiro restore de verdade em homologação.]` O número vai
aqui depois do ensaio, com a data. Enquanto estiver `[PENDENTE]`, trate o tempo
de recuperação como **desconhecido**, não como "rápido".

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

- **Deploy automático (CD).** O CI publica a imagem no GHCR (CRMLAB-36) mas
  ninguém dispara `deploy.sh` sozinho — subir em produção continua sendo
  humano, digitado, com a confirmação de `ENVIRONMENTS.md` §3.
- **Ambiente de staging.** Não existe host definido.
- **Certificado TLS.** O nginx da imagem serve HTTP em 8080; TLS/HSTS ficam no
  proxy de borda do host.
- **Zero-downtime no `up -d`.** `docker compose up -d` recria o container e
  há uma janela de indisponibilidade real (log do Caddy mostrou rajadas de
  502/503 em deploys de 17/09) — aceito como limitação conhecida por ora
  (CRMLAB-36).
- **Ações que exigem acesso à VPS**, fora do alcance de um PR (ver
  `docs/STATUS.md`, entradas CRMLAB-36 e CRMLAB-38, para o passo a passo):
  - **`gh auth login` na VPS** (CRMLAB-38/D-150). Desde a Onda C o `deploy.sh`
    consulta o GitHub antes de buildar e **aborta** se o workflow `CI` daquele
    commit não estiver verde — ou se o `gh` não estiver instalado/autenticado.
    É login manual, uma vez por máquina; sem ele nenhum deploy passa.
  - **Apontar `DATABASE_URL` para `crm_login`** (CRMLAB-38/D-145, corrigida pela D-165 —
    a role só ficou utilizável a partir da v1.13.1, migração 023). **Obrigatório junto:**
    definir `MIGRATE_DATABASE_URL` com a URL da role dona (a `DATABASE_URL` antiga) no mesmo
    `.env` — o job `migrate` precisa de DDL e `crm_login` não tem. Ordem: (1) `ALTER ROLE
    crm_login WITH PASSWORD '...'` no Postgres; (2) `.env`: `MIGRATE_DATABASE_URL=<url atual>`
    e `DATABASE_URL=postgresql://crm_login:<senha>@postgres:5432/<db>`; (3) `./scripts/deploy.sh`
    (recria `backend` e `migrate` com o ambiente novo); (4) conferir login real e um webhook. A migração
    020 cria a role sem senha de propósito. Na VPS, por ambiente:
    `ALTER ROLE crm_login WITH PASSWORD '<senha nova>';` e então trocar o
    usuário na `DATABASE_URL` do `.env`. Enquanto isso não for feito, a pool
    continua conectando como superuser e o ganho da 020 é zero. O serviço
    `migrate` do compose **não** muda — ele precisa da role dona para DDL.
  - Definir `IMAGE_REGISTRY` no `.env` dos dois ambientes (`/opt/crm-lab` e
    `/opt/crm-lab-homolog`) — sem isso o `deploy.sh` continua caindo no
    fallback de build local.
  - Reiniciar a VPS para aplicar o kernel pendente (`/var/run/reboot-required`
    em 19/09) — fora de horário de atendimento, depois do backup das 03:10 UTC.
  - `evolution: user: "1000:1000"` (D-140 em `docs/DECISIONS.md`) — validar em
    homologação antes de aplicar em produção; imagem de terceiro, sem como
    testar da CI.
