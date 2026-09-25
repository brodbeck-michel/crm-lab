# 🌍 Ambientes — produção e homologação

**Este é o documento de referência quando alguém disser "prod" ou "hml".** Os dois
ambientes rodam na **mesma VPS** (Hostinger KVM2, `srv1985833`, 2 vCPU / 7.9 GB),
isolados por projeto Docker Compose. Deploy e operação: `DEPLOYMENT.md`.

---

## 1. Vocabulário

| Eu digo | Significa | Onde |
|---------|-----------|------|
| **prod**, produção, "o que está no ar" | o ambiente que o laboratório usa, com dado real e WhatsApp ligado | `https://vitrocrm.cloud` |
| **hml**, homologação, "homolog" | cópia para testar antes de prod, com dado **copiado** de prod e WhatsApp **desligado** | `https://homolog.vitrocrm.cloud` (atrás de senha) |
| **local**, dev | `docker-compose.yml` na máquina do dev, banco e dado próprios | `http://localhost:5173` |

Fluxo pretendido: **local → hml → prod**. `hml` existe para o teste que precisa de
dado parecido com o real e de build de produção (nginx, imagem, migration
aplicada de verdade) — coisas que `localhost` não reproduz.

---

## 1.1. Estado em 2026-09-18 (montagem do ambiente)

- **prod**: `v1.7.0`, imagem `1e7fc41`, no ar em `https://vitrocrm.cloud`. Não foi
  reconstruída nem reiniciada para montar homologação.
- **hml**: no ar, imagem `hml-24ae78e` (branch `chore/ambiente-homologacao`), com o
  dado de produção de 2026-09-18 13:23 — 1 tenant, 3 usuários, 33 pacientes, 33
  conversas, **0 canais ativos**.
- **Custo medido com as duas de pé**: 1.17 GB de RAM usados dos 7.9 GB (hml inteira
  = ~208 MB; o maior consumidor é o Evolution, 125 MB) e 10 GB de 96 GB em disco.
  Folga grande; o gargalo continua sendo os 2 vCPU durante o build.
- **Borda no ar**: `https://homolog.vitrocrm.cloud` responde `401` sem credencial e
  `200` com, cabeçalho `X-Robots-Tag: noindex, nofollow`, `308` de HTTP para HTTPS e
  certificado Let's Encrypt válido até 2026-12-17. DNS: `A homolog -> 2.25.227.155`
  (TTL 300) na zona da Hostinger; o `AAAA` existe só na raiz, e o A basta.
- **Basic auth**: usuário `homolog`; a senha foi entregue ao Michel na montagem e
  **não é versionada**. Perdeu? Gere outra: `caddy hash-password`, troque o hash em
  `/etc/caddy/homolog.caddyfile` e recarregue.
- Alternativa sem passar pela borda, útil se o DNS ou o certificado der problema:
  `ssh -L 8081:127.0.0.1:8081 crm-vps` e `http://localhost:8081` — já está no
  `CORS_ORIGIN`.

### Duas armadilhas que custaram caro na montagem

**`caddy validate` como root deixa o log com dono errado, e o reload seguinte
falha.** O `validate` **abre** o arquivo de log declarado no site; rodado com
`sudo`, cria `/var/log/caddy/homolog.log` como `root:root`. O serviço roda como
`caddy`, não consegue escrever, e o `systemctl reload caddy` é **rejeitado**.
Valide sempre como o usuário do serviço:

```bash
sudo -u caddy caddy validate --config /etc/caddy/Caddyfile
```

O lado bom: o reload do Caddy é atômico — a config velha continua servindo e
produção não cai. O lado ruim é o que fica armado: o `import` já está no arquivo
do disco, então um `restart` do Caddy (ou um reboot do host) **aí sim** derruba
produção. Config rejeitada no reload é urgência, não pendência.

**O UFW limita a porta 22 (`22/tcp LIMIT`)**: cerca de 6 conexões por 30 s por IP,
e o excedente é REJEITADO — "Connection refused", igualzinho a serviço derrubado.
Uma sequência de `ssh` curtos em rajada (um por comando) trava o próprio acesso
por alguns minutos. Não era fail2ban (zero banimentos). Agrupe o trabalho remoto
em **uma** sessão com heredoc em vez de várias conexões seguidas.

---

## 2. As duas stacks, lado a lado

Mesmo `docker-compose.prod.yml`, mesma VPS, **nada compartilhado**:

| | produção | homologação |
|---|---|---|
| Diretório | `/opt/crm-lab` | `/opt/crm-lab-homolog` |
| Projeto Compose | `crm-lab-prod` | `crm-lab-homolog` |
| `APP_ENV` no `.env` | `production` | `homologacao` |
| Porta no host | `127.0.0.1:8080` | `127.0.0.1:8081` |
| Endereço | `vitrocrm.cloud` | `homolog.vitrocrm.cloud` + basic auth |
| Volumes | `crm-lab-prod_{postgres,redis,media}-data` | `crm-lab-homolog_{postgres,redis,media}-data` |
| Tag das imagens | `<sha>` | `hml-<sha>` |
| Código | só `origin/main` | qualquer branch/tag/sha (`--ref`) |
| Selo na tela | nenhum | pílula **HOMOLOGACAO** no pé da sidebar |
| WhatsApp (Evolution) | ligado, número real | `EVOLUTION_API_KEY` vazia + canais desativados no banco |
| Sincronização LIS (Bitlab, CRMLAB-52) | chave de produção colada pelo admin | `LIS_SYNC_INTERVAL_MS=0` + `lis_sync_settings` desligada e sem chave no banco. O Bitlab não tem sandbox da API de Orçamentos |
| Backup automático | sim, `crm-lab-backup.timer` 03:12 UTC | não — é descartável por definição |
| Segredos (JWT, senha do banco, `CHANNEL_SECRET_KEY`) | próprios | **próprios e diferentes** |

O que garante o isolamento de verdade é o **nome do projeto**: ele é o prefixo dos
containers, da rede e — o que importa — dos **volumes**. Dois projetos = dois
Postgres, em dois volumes que não se conhecem.

### Por que `COMPOSE_PROJECT_NAME` vive no `.env`

O `docker-compose.prod.yml` traz `name: crm-lab-prod` no topo. A precedência do
Compose é `-p` > `COMPOSE_PROJECT_NAME` > `name:`, então cada `.env` define o seu
`COMPOSE_PROJECT_NAME` e **até um `docker compose up` cru, digitado à mão no
diretório errado de propósito, cai no projeto certo**. Não depende de lembrar do
`-p`. Os scripts passam `-p` de todo jeito, porque uma variável exportada na
sessão venceria o `.env`.

---

## 3. Como subir

Sempre pelo script, de dentro do diretório do ambiente. **Não existe flag de
ambiente**: o script descobre onde está e prova a identidade antes de agir.

```bash
# homologação — branch de feature, quantas vezes quiser
ssh crm-vps
cd /opt/crm-lab-homolog
./scripts/deploy.sh --ref origin/feature/CRMLAB-12-editar-orcamento

# produção — só origin/main, com versão bumpada e tag
cd /opt/crm-lab
./scripts/deploy.sh          # pede para digitar PRODUCAO
```

O `deploy.sh` faz, em ordem: identidade → árvore limpa → `fetch` → `checkout
--detach` → **CI verde no SHA** (D-150) → `pull` (ou `build`, fallback sem
`IMAGE_REGISTRY` — CRMLAB-36) → `run --rm migrate` → `up -d` → `/healthz` →
limpeza de imagem/cache antigos.

### `--sem-ci`, e quando ele se justifica

A checagem de CI aborta o deploy quando o run do commit não está verde — inclusive
quando ele **não pôde rodar**, que é o caso da cota do GitHub Actions estourada. Como
a trava é anterior ao build, isso trava homologação também, e homologação é justamente
onde se valida uma mudança que o CI não validou.

```bash
# só homologação; pede "SEM CI" digitado e um motivo obrigatório
printf 'SEM CI\ncota do Actions estourada até 01/10\n' \
  | ./scripts/deploy.sh --ref origin/feature/minha-branch --sem-ci
```

**Em produção a flag aborta**, sem exceção: lá o CI verde é inegociável. O motivo
digitado aparece no começo e na última linha do deploy — quem lê só o fim do log
precisa saber que aquele build subiu sem validação.

A flag existe porque a alternativa real era pior. Sem ela, a saída na pressa é comentar
a checagem no script — e ninguém nunca descomenta.

> ⏳ **Esta flag tem data de validade: 01/10/2026.** Ela é dívida consciente, aberta pela cota
> do Actions estourada. Na data, `docs/STATUS.md` → "Dívida: `--sem-ci`" manda decidir
> explicitamente entre removê-la ou mantê-la com teste. Se você chegou aqui depois do prazo e
> nada foi decidido, ela passou da validade — leve para revisão em vez de usar.

### As travas do `deploy.sh`

1. **Três fontes de identidade têm que concordar**: diretório, `APP_ENV` e
   `COMPOSE_PROJECT_NAME`. O par `APP_ENV`/`COMPOSE_PROJECT_NAME` pega `.env`
   meio-editado; o **diretório** pega o caso pior — `.env` de produção copiado
   inteiro para `/opt/crm-lab-homolog`, que sem essa checagem faria um "deploy de
   homologação" reconstruir **produção** em cima do volume de produção.
2. **`-p` explícito** em toda chamada do compose, e conferência do `name:` que o
   compose resolveu.
3. **Árvore suja aborta.** Imagem feita de código não versionado não é
   reproduzível nem rastreável.
4. **`--ref` é proibido em produção.** Prod sobe o que passou por PR.
5. **Produção exige digitar `PRODUCAO`.** `--sim` pula isso, e é ignorado quando
   o `HEAD` está sem tag.
6. **Versão × tag.** Se o `HEAD` tem tag, ela precisa bater com o `version` do
   `package.json` da raiz. Se não tem tag, avisa e força a confirmação — a versão
   da tela é **build-time** e um deploy sem bump faz a tela mentir.
7. **Nenhum `down`, nenhum `-v`.** Não estão no script; derrubar stack e apagar
   volume são atos manuais e conscientes. Desde o CRMLAB-36 o script roda
   `docker image prune -a`/`docker builder prune` no fim — não toca em volume
   nem em container rodando, só imagem/cache não usados.

### As travas foram testadas (2026-09-18)

Em `/tmp`, com `.env` sintéticos, sem tocar em nenhuma das duas stacks. Todos os
seis casos abortaram com saída 1 e mensagem dizendo o que estava errado:

| Cenário | Trava que pegou |
|---|---|
| `.env` de produção num clone que não é `/opt/crm-lab` | diretório |
| `APP_ENV=homologacao` com `COMPOSE_PROJECT_NAME=crm-lab-prod` | par inconsistente |
| `APP_ENV=staging` | ambiente desconhecido |
| `--ref` com `APP_ENV=production` | `--ref` proibido em prod |
| sincronia de dados com `.env` de produção | `APP_ENV` != homologacao |
| sincronia de dados fora de `/opt/crm-lab-homolog` | diretório |

O que **não** dá para testar sem um deploy real de produção: a confirmação digitada
`PRODUCAO` e a conferência tag × versão. Elas aparecem no próximo deploy de prod.

### Rollback

Imagem antiga continua no host:

```bash
cd /opt/crm-lab
IMAGE_TAG=<sha-anterior> docker compose -p crm-lab-prod -f docker-compose.prod.yml up -d backend frontend
```

---

## 4. Dado de homologação

`hml` nasce com uma cópia de `prod` — **banco e arquivos de mídia**. Os dois
precisam vir: `message_media` viaja no dump, mas o arquivo mora em
`<projeto>_media-data`, um volume por ambiente. Sem a cópia dos arquivos, toda
foto e áudio de produção aparecem como "não foi possível carregar" em hml, o
que em 19/09 pareceu bug de tela e não era. O script faz as duas coisas desde
então; produção entra como `:ro`.

Recarregar:

```bash
cd /opt/crm-lab-homolog
./scripts/homolog-sincroniza-dados.sh              # pg_dump novo de produção
./scripts/homolog-sincroniza-dados.sh --do-backup  # usa o último dump noturno
```

O script é de **direção única** — produção só é lida (`pg_dump`), e não há flag que
inverta. Antes do `pg_restore --clean` ele grava o estado atual de homologação em
`/opt/crm-lab-homolog/backups/homolog-antes-<stamp>.dump`. E confere o destino
**quatro** vezes: `APP_ENV`, `COMPOSE_PROJECT_NAME`, diretório e o label
`com.docker.compose.project` do container que vai receber o restore.

No fim ele roda:

```sql
UPDATE tenant_channels SET is_active = FALSE, api_token = NULL, webhook_secret = NULL;
```

e, desde o CRMLAB-52 (D-185):

```sql
UPDATE lis_sync_settings SET enabled = FALSE, api_key = NULL;
```

**Isso não é higiene, é contenção.** Homologação com canal ativo e credencial
válida manda WhatsApp de verdade para paciente de verdade. Com a chave do Bitlab,
homologação puxaria a base de orçamentos de produção (com nome de paciente) para um
banco que não tem backup nem o mesmo controle de acesso. Os tokens vêm cifrados
com a `CHANNEL_SECRET_KEY` de produção e não decifrariam aqui — mas "não
decifraria" é sorte, não garantia.

**LGPD:** homologação carrega nome, telefone e conversa de paciente real. É por
isso que ela fica atrás de basic auth e com `X-Robots-Tag: noindex`. Não é
ambiente para demonstração pública nem para acesso de terceiros.

### Login em homologação

Os usuários vêm no dump: as **mesmas credenciais de produção** valem em hml
(inclusive `admin@vitrocrm.com.br`). Não há rota de cadastro em nenhum dos dois.

---

## 5. Borda (Caddy no host)

Um Caddy só, dois sites. `hml` fica atrás de um **porteiro por cookie** — não de
`basic_auth` em todos os caminhos (o porquê está logo abaixo, e custou uma tarde):

```caddyfile
homolog.vitrocrm.cloud {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"

	@gate path /entrar
	@sem_cookie not header_regexp Cookie "hml_ok=<segredo>"
	@api_sem_cookie {
		path /api/* /ws /ws/*
		not header_regexp Cookie "hml_ok=<segredo>"
	}

	route {
		handle @gate {
			basic_auth {
				homolog <hash bcrypt via `caddy hash-password`>
			}
			header +Set-Cookie "hml_ok=<segredo>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax"
			redir * / 302
		}

		respond @api_sem_cookie "homologacao: porteiro expirou — recarregue a pagina" 403
		redir @sem_cookie /entrar 302

		reverse_proxy 127.0.0.1:8081
	}

	log { output file /var/log/caddy/homolog.log { roll_size 10MiB roll_keep 5 } }
}
```

Fluxo: sem cookie → `/entrar` → basic auth (a **única** caixa de senha) →
`Set-Cookie` → volta para `/`. Uma senha por navegador, 30 dias. O ambiente
inteiro fica protegido, **inclusive a API** — que é onde mora a cópia do dado
real de paciente.

### Por que `basic_auth` em tudo não funciona com este app

Duas incompatibilidades, as duas de protocolo, nenhuma contornável por ajuste:

1. **A API.** O app manda o **seu próprio** `Authorization: Bearer <jwt>` em toda
   chamada, e esse cabeçalho substitui a credencial de basic auth do navegador.
   O Caddy não reconhece o Bearer como Basic, responde `401` com
   `WWW-Authenticate`, e o navegador reabre a caixa de senha **a cada chamada de
   API**. No log da borda: 188 dos 400 últimos acessos eram esse 401.
2. **O WebSocket.** O navegador nunca envia basic auth no handshake de upgrade.
   O `/ws` levava `401` na borda, o app reconectava em loop, e o tempo real
   (inbox, chat interno) nunca conectava.

Cookie resolve os dois porque `Cookie` e `Authorization` são cabeçalhos
**diferentes**, e o navegador manda o cookie em `fetch` e no handshake de WS
(mesma origem). O `/api` continua exigindo o Bearer do próprio app; o `/ws`
(desde o CRMLAB-33/D-151) autentica pelo cookie httpOnly `crm_refresh` —
`lib/ws-hub.ts` verifica esse cookie com o `JWT_REFRESH_SECRET` deste
ambiente e tira `tenantId`/`userId` só do token verificado, além de checar o
header `Origin` contra `CORS_ORIGIN`.

Diferença observável que importa: os `401` de dentro da aplicação (JWT expirado,
senha errada) **não** têm cabeçalho de desafio, então não abrem caixa nenhuma. Se
a caixa de senha voltar a aparecer fora do `/entrar`, é a borda respondendo —
comece olhando o log.

### Pegadinha do `redir`

`redir / 302` **não** redireciona para `/`: o token `/` é lido como *matcher de
caminho*, e o destino vira `302`. O sintoma é um `Location` errado e, no
navegador, um laço no porteiro. Com destino relativo, o matcher tem que ser
explícito:

```caddyfile
redir * / 302
```

Nenhuma das duas stacks publica porta pública: ambas escutam em `127.0.0.1`, e
quem atende 80/443 é o Caddy. `TRUST_PROXY_HOPS=2` (Caddy + nginx da imagem).

Sem DNS ainda? Homologação também abre por túnel, sem passar pelo Caddy:

```bash
ssh -L 8081:127.0.0.1:8081 crm-vps   # depois http://localhost:8081
```

---

## 6. `.env` de homologação — molde

Existe **só na VPS** (`/opt/crm-lab-homolog/.env`, modo 600). Nunca versionar.
Todo segredo é gerado localmente (`openssl rand -hex 32`) e **diferente** do de
produção — segredo repetido transforma qualquer vazamento de hml em vazamento de
prod.

```dotenv
APP_ENV=homologacao
COMPOSE_PROJECT_NAME=crm-lab-homolog
# IMAGE_TAG NÃO vai no .env: `deploy.sh` exporta `hml-<sha7>` a cada deploy. (A
# versão anterior deste exemplo trazia `hml-latest`, uma tag que o CI nunca
# publica — um `docker compose pull` manual com ela falhava com "manifest
# unknown".) Para rollback manual, use `IMAGE_TAG=hml-<sha7>` na linha de comando.
# CRMLAB-36/CRMLAB-41 — `ghcr.io/<owner>/<repo>/`, COM o repositório e COM a
# barra final: o CI publica sob `ghcr.io/<owner>/<repo>/crm-lab-*`. Vazio (ou
# ausente) = deploy.sh cai no fallback de build local (DEPLOYMENT.md §2/§4).
IMAGE_REGISTRY=ghcr.io/brodbeck-michel/crm-lab/

POSTGRES_USER=crm
POSTGRES_PASSWORD=<openssl rand -hex 24>
POSTGRES_DB=crm_lab
DATABASE_URL=postgres://crm:<a senha acima>@postgres:5432/crm_lab
REDIS_URL=redis://redis:6379

JWT_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>
CHANNEL_SECRET_KEY=<openssl rand -hex 32>

HTTP_PORT=127.0.0.1:8081
CORS_ORIGIN=https://homolog.vitrocrm.cloud,http://localhost:8081
LOG_LEVEL=debug
TRUST_PROXY_HOPS=2

# Vazio de propósito: gateway desligado devolve CHANNEL_QR_UNAVAILABLE, sem crash.
EVOLUTION_API_KEY=

# CRMLAB-52: agendador da sincronização com o Bitlab desligado em homologação.
LIS_SYNC_INTERVAL_MS=0
```

---

## 7. Custo na VPS

Com as duas stacks de pé: ~2 GB de RAM dos 7.9 GB, e as imagens de hml somam
alguns GB no disco de 96 GB.

**Build deixou de rodar na VPS (CRMLAB-36).** Antes, o `build` ocupava os 2
vCPU por ~10 min e um build de homologação deixava produção lenta nesse
intervalo — era a própria razão de existir deste aviso. O CI agora publica
`crm-lab-{backend,frontend}` no GHCR a cada push em `main`
(`.github/workflows/ci.yml`, job `docker`) e `deploy.sh` faz `pull` em vez de
`build` quando `IMAGE_REGISTRY` está definido no `.env` do ambiente — deploy
em segundos, sem competir por CPU com o outro ambiente. Sem `IMAGE_REGISTRY`
no `.env`, o script cai no fallback antigo (build local, mesmo custo de
sempre) — ver `docs/guides/DEPLOYMENT.md` §2/§4.

Cada container agora tem `mem_limit` (postgres 1536m · redis 256m · backend
512m · frontend 64m · evolution 768m · migrate 256m — somando os dois
ambientes fica abaixo de 6 GB dos 7.9 GB da VPS): um vazamento em um serviço
não compete mais pela RAM do Postgres nem convida o OOM killer a escolher a
vítima errada. Redis ganhou `maxmemory 200mb` + `allkeys-lru` — sem teto,
`noeviction` virava erro de escrita quando a RAM apertava (era o que derrubava
o rate limit em 500 global, CRMLAB-34).

`deploy.sh` já roda a limpeza abaixo sozinho depois de cada `up -d`
(best-effort — falha aqui não aborta o deploy). Rodar manual quando o disco
pedir fora de um deploy (`docker system df`):

```bash
docker image prune -af --filter 'until=336h'   # nunca em cima da tag no ar
docker builder prune -f --filter 'until=168h'
```

---

## 8. Nunca

- `docker compose down -v` em qualquer um dos dois — `-v` apaga o volume do banco.
- `.env` copiado entre ambientes. Se precisar de um novo, copie o **molde** acima.
- Segredo de produção em homologação (e vice-versa).
- `--ref` apontando para código não mergeado em produção.
- Ligar `EVOLUTION_API_KEY` em homologação com o número real do laboratório: dois
  ambientes pareando a mesma sessão brigam pela conexão e derrubam o WhatsApp de
  produção.
- Tratar homologação como ambiente público: tem dado real de paciente.
