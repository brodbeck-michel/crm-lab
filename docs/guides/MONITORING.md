# 🩺 Monitoramento e alerta

> Origem: CRMLAB-29 (auditoria de 19/09/2026). Antes deste card não havia
> monitor nenhum na VPS, e as três sondas que existiam mentiam de formas
> diferentes. Este documento é o mapa do que existe hoje, o que cada sonda
> responde de verdade e como ligar o alerta.

---

## 1. As duas sondas do backend, e por que são duas

| Sonda | Caminho | Quem consulta | O que responde |
|---|---|---|---|
| **Liveness** | `GET /health` e `GET /health/live` | `HEALTHCHECK` da imagem, `docker compose` | 200 fixo enquanto o processo aceita conexão. Não olha dependência nenhuma. |
| **Readiness** | `GET /api/v1/health` | `deploy.sh`, `monitora-saude.sh`, monitor externo | `SELECT 1` no pool + `PING` no cache. **200** com tudo de pé, **503** quando uma dependência cai. |

**Por que não uma só.** Se a liveness checasse o Postgres, uma queda do banco
marcaria o container do backend como `unhealthy` e o orquestrador o
reiniciaria em loop — matando WebSocket aberto e cache em memória para
consertar um problema que não é do backend, e que o reinício não conserta.
"O processo está vivo" e "o sistema serve" são perguntas diferentes e têm
respostas diferentes.

**Por que a readiness mora sob `/api/v1/`.** É o único prefixo que o nginx faz
proxy (`nginx/frontend.conf`, `location /api/`). `GET /health` pela internet
cai no `try_files` da SPA e devolve **o HTML do index com 200** — pior que não
existir, porque um monitor apontado para lá fica verde para sempre.

### Corpo da resposta

```jsonc
// 200
{
  "status": "ok",
  "driver": "pg",
  "uptime": 8123.4,
  "checkedAt": "2026-09-19T19:04:11.002Z",
  "checks": {
    "database": { "status": "up", "latencyMs": 3 },
    "cache":    { "status": "up", "latencyMs": 1 }
  }
}

// 503 — o corpo diz QUAL dependência caiu
{
  "status": "degraded",
  "checks": {
    "database": { "status": "down", "latencyMs": 2000, "error": "sem resposta em 2000ms" },
    "cache":    { "status": "up",   "latencyMs": 1 }
  }
}
```

### Custo

O relatório é **memoizado por 5 s** e as checagens concorrentes compartilham a
mesma execução (single-flight): um monitor de 1 em 1 minuto — ou dez monitores
— não multiplica ida ao banco. Nenhuma checagem abre transação: é `SELECT 1`
solto no pool, com **timeout de 2 s** por dependência, para que um Postgres
pendurado devolva 503 em vez de pendurar o health junto. Constantes em
`backend/src/lib/health.ts`.

Ambas as sondas ficam **fora do rate limit** — health que responde 429 não
serve de health — e respondem com `Cache-Control: no-store`.

---

## 2. `/healthz` do nginx: o que ele NÃO é

`https://vitrocrm.cloud/healthz` é um `return 200 "ok"` do próprio nginx.
Responde com o backend morto, com o Postgres fora e com o Redis fora. Serve
para uma coisa só: saber que o container do frontend subiu.

Até 19/09/2026 era ele que o `deploy.sh` consultava — o deploy declarava
"no ar" sem ter tocado em uma linha de código da aplicação. Hoje o
`deploy.sh` consulta `/api/v1/health` e imprime o corpo do 503 quando falha.

**Nunca aponte deploy nem monitor externo para `/healthz`.**

---

## 3. Varredura local: `scripts/monitora-saude.sh`

Roda no host por systemd timer, de 5 em 5 minutos
(`scripts/systemd/crm-lab-monitor.{service,timer}`). Só lê: não reinicia
container, não apaga arquivo, não sobe nada.

| # | Verificação | Limiar |
|---|---|---|
| 1 | Docker responde (`docker info`) | — |
| 2 | Container `unhealthy` **do projeto Compose monitorado** | — |
| 3 | Container `exited` **do projeto Compose monitorado**, **ignorando o `migrate`** (sai com 0 a cada deploy por desenho) | `CRM_IGNORAR_EXITED` |
| 4 | Readiness da API | `CRM_HEALTH_URL` |
| 5 | Disco da raiz | `CRM_DISCO_LIMITE`, default **80%** |
| 6 | Reboot pendente (`/var/run/reboot-required`) | — |
| 7 | Heartbeat do backup velho demais | `CRM_BACKUP_MAX_HORAS`, default **26 h** |

**Verificações 2 e 3 filtram por `COMPOSE_PROJECT_NAME`.** Prod e homolog
rodam na MESMA VPS como dois projetos Compose separados (`crm-lab-prod` /
`crm-lab-homolog`, ver `deploy.sh`). Sem esse filtro, `docker ps` enxerga o
HOST INTEIRO, e um container quebrado em homolog dispara um alerta genérico
"Container unhealthy no CRM Lab" que faz quem está de plantão achar que é
PRODUÇÃO que caiu (ou vice-versa). O script exige `COMPOSE_PROJECT_NAME`
definida — normalmente já vem do `.env` do próprio ambiente (a mesma
variável que `deploy.sh` usa em `docker compose -p`) — e aborta com erro
claro se não achar nenhuma, em vez de cair num default silencioso que
escanearia o host inteiro. O título do alerta também leva o nome do projeto
entre colchetes (ex. `[crm-lab-homolog]`), para o destinatário identificar o
ambiente sem precisar investigar.

Cada verificação tem **estado em disco** (`STATE_DIR`, default
`/var/lib/crm-lab-monitor`): o alerta sai na borda (ok → ruim) e um
"RECUPERADO" sai na volta. Sem isso, uma varredura de 5 em 5 minutos manda 288
mensagens por dia da mesma coisa, e alerta que sempre toca é alerta que
ninguém lê. Se `STATE_DIR` ficar inacessível (diretório ausente, permissão
errada), o script **não aborta** — continua checando saúde — mas registra um
aviso de alta prioridade no journal (`logger -p daemon.err`, tag
`crm-lab-monitor`) em vez de engolir o erro em silêncio, já que sem a marca
em disco toda rodada vira alerta novo.

O script sai com **0 mesmo tendo alertado**: é monitor, não teste — o systemd
não deve marcar a unidade como falha porque o disco encheu. Quem avisa é o
alerta; o journal (`journalctl -u crm-lab-monitor`) guarda tudo.

### Instalação na VPS

> O Michel não acessa o servidor: este bloco é para repassar ao analista de
> infra, junto com o deploy da onda.

O unit file declara `StateDirectory=crm-lab-monitor`: o systemd cria e
gerencia `/var/lib/crm-lab-monitor` automaticamente (dono, grupo e permissões
certos) na primeira ativação da unidade — **não é mais preciso** o passo
manual de `sudo install -d`.

```bash
sudo install -m 0644 /opt/crm-lab/scripts/systemd/crm-lab-monitor.service /etc/systemd/system/
sudo install -m 0644 /opt/crm-lab/scripts/systemd/crm-lab-monitor.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now crm-lab-monitor.timer
systemctl list-timers crm-lab-monitor.timer
sudo -u deploy /opt/crm-lab/scripts/monitora-saude.sh   # rodada manual
```

---

## 4. Notificador: plugável por variável de ambiente

`scripts/lib/alerta.sh` é a biblioteca de envio. O canal pedido pelo Michel é
**WhatsApp**, mas o número ainda não foi passado; por isso o destino é um
**webhook genérico**. Quando o número chegar, o que muda é o valor de uma
variável — não o código.

| Variável | Papel |
|---|---|
| `ALERT_WEBHOOK_URL` | Destino do `POST`. **Vazia = o alerta vai só para o journal** (e isso não é erro). |
| `ALERT_WEBHOOK_TOKEN` | Vira `Authorization: Bearer <token>`, quando o destino exige. |
| `ALERT_SOURCE` | Rótulo da origem no payload. Default: hostname. |
| `ALERT_TIMEOUT` | Teto do `curl` em segundos. Default: 10. |

Configuração na VPS em `/etc/crm-lab/monitor.env`, modo `0600`, **fora do
repositório** (a URL costuma carregar o token nela mesma):

```bash
# /etc/crm-lab/monitor.env
ALERT_WEBHOOK_URL=https://<destino>/hook/crm-lab
ALERT_WEBHOOK_TOKEN=<se o destino exigir>
ALERT_SOURCE=crm-lab-prod
```

Payload entregue (JSON):

```json
{ "source": "crm-lab-prod", "severity": "critical",
  "title": "Container unhealthy no CRM Lab",
  "detail": "containers: crm-lab-prod-backend-1",
  "timestamp": "2026-09-19T19:04:11+00:00" }
```

`severity` é `critical` no problema e `info` na recuperação.

**Falha de notificação nunca derruba quem chamou.** Um backup que deu certo
não pode virar backup falhado porque o webhook estava fora do ar; o log local
continua sendo a fonte da verdade.

### Ligando o WhatsApp quando o número chegar

Três caminhos, em ordem de esforço:

1. **Fluxo no Evolution API que já roda na VPS** — um endpoint que receba o
   JSON acima e envie texto para o número. Vantagem: nada novo na
   infraestrutura. Cuidado: o gateway é justamente um dos componentes que
   podem estar fora na hora do alerta — alerta que depende do que quebrou não
   chega. Serve como canal secundário, não como único.
2. **Serviço externo com webhook de entrada** (ntfy, n8n, Better Stack) que
   repassa para WhatsApp/Telegram. É o caminho recomendado: mora fora da VPS,
   então sobrevive à VPS.
3. **Uptime externo** (UptimeRobot, Better Stack, Healthchecks.io) apontado
   para `https://vitrocrm.cloud/api/v1/health` a cada 1–5 min. Este é o único
   que cobre "a VPS inteira sumiu", que nenhum monitor local consegue cobrir.
   **Ainda não existe conta criada** — decisão e cadastro são do Michel.

---

## 5. Heartbeat do backup (dead man's switch)

Alerta de coisa que **falhou** depende de o processo ter rodado. Backup que
nunca começa — timer desabilitado, host desligado, disco cheio antes do
primeiro byte — não gera falha nenhuma: gera **silêncio**. O heartbeat inverte
isso: o sucesso deixa uma marca datada, e a ausência da marca é que alerta.

`alerta_heartbeat <nome>` (em `scripts/lib/alerta.sh`) faz duas coisas:

- grava `"$HEARTBEAT_DIR/<nome>.heartbeat"` com a data — cobrado pela
  verificação 7 do `monitora-saude.sh` (26 h);
- se `<NOME>_HEARTBEAT_URL` estiver definida (ex.
  `BACKUP_POSTGRES_HEARTBEAT_URL` do Healthchecks.io), faz o ping HTTP. Só
  este cobre "a VPS inteira sumiu", porque quem cobra está fora dela.

**Pendência declarada:** a chamada precisa entrar no fim do
`scripts/backup-postgres.sh`, que é do Agent-Infra-28 (CRMLAB-28). Pedido
registrado em `docs/STATUS.md`. As duas linhas são:

```bash
# no topo, junto dos outros `source`
. "$(dirname "${BASH_SOURCE[0]}")/lib/alerta.sh"

# na última linha, DEPOIS de `log "concluido"` — só no caminho de sucesso
alerta_heartbeat backup-postgres
```

Enquanto essa linha não existir, a verificação 7 fica em silêncio de
propósito: alertar por uma marca que nunca foi escrita seria alarme falso
diário.

---

## 6. O que ainda depende de decisão humana

| Pendência | De quem |
|---|---|
| Número de WhatsApp / destino final do `ALERT_WEBHOOK_URL` | Michel |
| Conta no serviço de uptime externo (cobre "a VPS sumiu") | Michel |
| Linha de `alerta_heartbeat` no `backup-postgres.sh` | Agent-Infra-28 (CRMLAB-28) |
| `healthcheck:` do serviço `backend` no `docker-compose.prod.yml`, apontando para `/health/live` | Agent-Infra (o compose não é do CRMLAB-29) |
| Seção de monitoramento no `DEPLOYMENT.md` remetendo a este arquivo | Agent-Infra-28 |
