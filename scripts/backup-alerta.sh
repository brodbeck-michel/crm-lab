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
# CANAL DE ALERTA: PLUGAVEL DE PROPOSITO
#   O canal final ainda nao esta decidido (o Michel quer WhatsApp, o que
#   depende do gateway que este proprio backup protege — dependencia circular
#   a resolver). Em vez de travar o card numa escolha, o destino vem do
#   ambiente. Trocar de canal e editar o .env, nao este script.
#
#   BACKUP_ALERT_CMD      comando que recebe a mensagem no STDIN. Escotilha de
#                         saida para qualquer canal (mail, um script de
#                         WhatsApp, o que vier). Tem precedencia.
#   BACKUP_ALERT_WEBHOOK  URL que recebe POST {"text": "..."}. Funciona direto
#                         com Discord, Slack, n8n e a maioria dos gateways.
#
#   Sem nenhum dos dois, o alerta vai para o syslog com prioridade `err` e o
#   script sai 0 — ele nao pode falhar, porque uma falha aqui nao tem quem
#   avise. O `logger` deixa o rastro para quem for ler depois.
#
# Ver "Backup e restore" em docs/guides/DEPLOYMENT.md.
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
UNIDADE="${1:-crm-lab-backup.service}"

if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

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
elif [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
  # Escape de JSON em bash puro, de proposito: `jq` pode nao estar instalado no
  # host (nao e dependencia do projeto — grep confirma que nao ha uso real do
  # binario em scripts/ nem no compose), e um alerta que nao dispara porque
  # falta uma ferramenta e o mesmo silencio que este script veio resolver.
  #
  # As tres classes originais (`\`, `"`, newline) nao bastam: o `contexto` vem
  # de `journalctl -u "$UNIDADE" -n 20`, e se o servico que falhou tiver saida
  # com progress bar/cores (sequencias ANSI) ou `\r`, sobra byte de controle
  # invalido em JSON. Isso quebra exatamente o alerta cujo trabalho e cobrir
  # incidente — silencio disfarcado de erro no webhook. Por isso escapamos
  # TODOS os bytes de controle ASCII < 0x20 (nao so os 3 mais comuns).
  escapar_json() {
    local str="$1" out="" c ord esc i len
    # backslash e aspas primeiro, antes de introduzirmos os nossos proprios
    str="${str//\\/\\\\}"
    str="${str//\"/\\\"}"
    len=${#str}
    for (( i=0; i<len; i++ )); do
      c="${str:i:1}"
      case "$c" in
        $'\n') out+='\n' ;;
        $'\r') out+='\r' ;;
        $'\t') out+='\t' ;;
        *)
          printf -v ord '%d' "'$c"
          if (( ord < 32 )); then
            printf -v esc '\\u%04x' "$ord"
            out+="$esc"
          else
            out+="$c"
          fi
          ;;
      esac
    done
    printf '%s' "$out"
  }
  escapado="$(escapar_json "$mensagem")"
  curl -fsS --max-time 20 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"${escapado}\"}" "$BACKUP_ALERT_WEBHOOK" >/dev/null || \
    logger -t crm-lab-backup -p user.err "webhook de alerta tambem falhou" || true
else
  printf '%s\n' "$mensagem" >&2
fi

exit 0
