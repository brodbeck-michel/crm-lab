#!/usr/bin/env bash
#
# Avisa alguem quando o backup do CRM Lab falha.
#
# Disparado pelo systemd, nao a mao: `OnFailure=crm-lab-backup-alerta@%n.service`
# no `crm-lab-backup.service`. Recebe como $1 o nome da unidade que falhou.
#
# POR QUE EXISTE
#   Ate 2026-09-19 uma falha do backup era silenciosa: o timer marcava
#   `failed` e ninguem ficava sabendo, porque o unico jeito de ver era alguem
#   resolver rodar `journalctl -u crm-lab-backup`. Backup que falha calado e
#   pior do que backup nenhum — da a sensacao de estar protegido.
#
# CANAL DE ALERTA: O MESMO DO MONITOR (scripts/lib/alerta.sh)
#   Ate a revisao do PR #24 este script tinha o seu proprio notificador — um
#   escape de JSON em bash puro, uma variavel propria (`BACKUP_ALERT_WEBHOOK`)
#   e um payload diferente — enquanto `monitora-saude.sh` ja usava
#   `lib/alerta.sh` (`ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_TOKEN`, payload
#   estruturado, `json.dumps` do python3 que ja e dependencia do host). Quem
#   configurava o webhook do monitor achava que TODOS os alertas iam para la;
#   o do backup nunca chegava, porque precisava de outra variavel, com outro
#   nome, em outro arquivo. Agora e um canal so:
#
#   ALERT_WEBHOOK_URL / ALERT_WEBHOOK_TOKEN   (ver lib/alerta.sh) — o padrao.
#   BACKUP_ALERT_CMD    escotilha de saida: comando que recebe a mensagem no
#                       STDIN (mail, um script de WhatsApp, o que vier). Tem
#                       precedencia sobre o webhook.
#   BACKUP_ALERT_WEBHOOK  legado: se ainda estiver no .env e ALERT_WEBHOOK_URL
#                       nao, e usado como ALERT_WEBHOOK_URL. Remover do .env
#                       quando o outro estiver configurado.
#
#   Sem nenhum dos tres, o alerta vai para o syslog com prioridade `err` e o
#   script sai 0 — ele nao pode falhar, porque uma falha aqui nao tem quem
#   avise. O `logger` deixa o rastro para quem for ler depois.
#
# Ver "Backup e restore" em docs/guides/DEPLOYMENT.md.
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
UNIDADE="${1:-crm-lab-backup.service}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/alerta.sh
. "$SCRIPT_DIR/lib/alerta.sh"

if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi
# Legado (ver cabecalho): a variavel antiga ainda vale se a nova nao existir.
: "${ALERT_WEBHOOK_URL:=${BACKUP_ALERT_WEBHOOK:-}}"
export ALERT_WEBHOOK_URL

# As ultimas linhas do journal vao junto: um alerta que so diz "falhou" obriga
# quem recebe a abrir a VPS para saber o que aconteceu, e as 3 da manha isso e
# a diferenca entre agir e adiar.
contexto="$(journalctl -u "$UNIDADE" -n 20 --no-pager 2>/dev/null || echo '(journal indisponivel)')"

mensagem="[CRM Lab] BACKUP FALHOU em $(hostname) — ${UNIDADE}
$(date -Is)

$contexto

Diagnostico: journalctl -u ${UNIDADE} -n 50
Rodar a mao:  /opt/crm-lab/scripts/backup-postgres.sh && /opt/crm-lab/scripts/backup-offsite.sh"

# `|| true` em tudo: este script nunca deve sair diferente de 0. Se ele falhar,
# o systemd nao tem um OnFailure do OnFailure — o alerta simplesmente some.
logger -t crm-lab-backup -p user.err "backup falhou (${UNIDADE})" || true

if [[ -n "${BACKUP_ALERT_CMD:-}" ]]; then
  printf '%s\n' "$mensagem" | sh -c "$BACKUP_ALERT_CMD" || \
    logger -t crm-lab-backup -p user.err "BACKUP_ALERT_CMD tambem falhou" || true
elif [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  # `alerta_envia` (lib/alerta.sh): mesmo payload, mesma URL e mesmo token do
  # monitor. Nunca lanca — falha do webhook vira log, nao saida != 0.
  alerta_envia critical "BACKUP FALHOU em $(hostname) — ${UNIDADE}" "$mensagem" || true
else
  printf '%s\n' "$mensagem" >&2
fi

exit 0
