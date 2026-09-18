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
--detach` → `build` → `run --rm migrate` → `up -d` → `/healthz`.

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
7. **Nenhum `down`, nenhum `-v`, nenhum `prune`.** Não estão no script; derrubar
   stack e apagar volume são atos manuais e conscientes.

### Rollback

Imagem antiga continua no host:

```bash
cd /opt/crm-lab
IMAGE_TAG=<sha-anterior> docker compose -p crm-lab-prod -f docker-compose.prod.yml up -d backend frontend
```

---

## 4. Dado de homologação

`hml` nasce com uma cópia de `prod`. Recarregar:

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

**Isso não é higiene, é contenção.** Homologação com canal ativo e credencial
válida manda WhatsApp de verdade para paciente de verdade. Os tokens vêm cifrados
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

Um Caddy só, dois sites. `hml` com `basic_auth` e `noindex`:

```caddyfile
homolog.vitrocrm.cloud {
	encode zstd gzip
	header X-Robots-Tag "noindex, nofollow"
	basic_auth {
		homolog <hash bcrypt via `caddy hash-password`>
	}
	reverse_proxy 127.0.0.1:8081
	log { output file /var/log/caddy/homolog.log { roll_size 10MiB roll_keep 5 } }
}
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
IMAGE_TAG=hml-latest

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
```

---

## 7. Custo na VPS

Com as duas stacks de pé: ~2 GB de RAM dos 7.9 GB, e as imagens de hml somam
alguns GB no disco de 96 GB. O aperto é **CPU**: o build ocupa os 2 vCPU por
~10 min, e um build de homologação deixa produção lenta nesse intervalo. Não
buildar hml em horário de atendimento do laboratório.

Limpeza, quando o disco pedir (`docker system df`):

```bash
docker image prune -a --filter 'until=336h' --filter 'label!=keep'   # nunca em cima da tag no ar
docker builder prune --filter 'until=168h'
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
