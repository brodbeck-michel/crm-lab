#!/usr/bin/env bash
#
# Notificador de alerta — PLUGAVEL (CRMLAB-29).
#
# Biblioteca para ser lida com `source`, nao executada. Quem usa:
#   scripts/monitora-saude.sh   (saude dos containers, disco, reboot, backup)
#   scripts/backup-postgres.sh  (heartbeat no fim — ver "Heartbeat" abaixo)
#
# O canal final pedido pelo Michel e WhatsApp, mas o numero ainda nao foi
# passado. Por isso o destino e um WEBHOOK GENERICO por variavel de ambiente:
# o que muda quando o numero chegar e o valor de `ALERT_WEBHOOK_URL` (para um
# fluxo do Evolution, n8n, ntfy, Slack, Healthchecks.io, o que for), nao o
# codigo destes scripts.
#
# Configuracao (todas opcionais — sem nenhuma, o alerta vai so para o log):
#   ALERT_WEBHOOK_URL    destino do POST. VAZIO = so loga (nao e erro).
#   ALERT_WEBHOOK_TOKEN  se definido, vira `Authorization: Bearer <token>`.
#   ALERT_SOURCE         rotulo da origem no payload. Default: hostname.
#   ALERT_TIMEOUT        segundos de teto para o curl. Default: 10.
#
# Payload (JSON, montado por python3 para escapar de verdade):
#   { "source", "severity", "title", "detail", "timestamp" }
#
# REGRA: falha de notificacao NUNCA derruba quem chamou. Um backup que deu
# certo nao pode virar backup falhado porque o webhook estava fora do ar; o
# `log` local continua sendo a fonte da verdade.

alerta_log() { printf '%s alerta: %s\n' "$(date -Is)" "$*" >&2; }

# alerta_payload <severidade> <titulo> <detalhe>
alerta_payload() {
  ALERTA_SEV="$1" ALERTA_TIT="$2" ALERTA_DET="$3" \
  ALERTA_SRC="${ALERT_SOURCE:-$(hostname)}" \
  python3 -c '
import json, os, datetime
print(json.dumps({
    "source": os.environ["ALERTA_SRC"],
    "severity": os.environ["ALERTA_SEV"],
    "title": os.environ["ALERTA_TIT"],
    "detail": os.environ["ALERTA_DET"],
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}, ensure_ascii=False))'
}

# alerta_envia <severidade: critical|warning|info> <titulo> [detalhe]
#
# Severidade `info` e usada para "recuperado": o criterio de aceite do card
# pede que a volta tambem avise, senao ninguem sabe se ainda esta fora.
alerta_envia() {
  local severidade="$1" titulo="$2" detalhe="${3:-}"
  alerta_log "[$severidade] $titulo${detalhe:+ — $detalhe}"

  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || {
    alerta_log 'ALERT_WEBHOOK_URL nao configurada: alerta ficou so no log'
    return 0
  }

  local -a cabecalhos=(-H 'Content-Type: application/json')
  [[ -n "${ALERT_WEBHOOK_TOKEN:-}" ]] \
    && cabecalhos+=(-H "Authorization: Bearer ${ALERT_WEBHOOK_TOKEN}")

  if curl -fsS --max-time "${ALERT_TIMEOUT:-10}" -X POST \
      "${cabecalhos[@]}" \
      --data "$(alerta_payload "$severidade" "$titulo" "$detalhe")" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    return 0
  fi

  alerta_log 'FALHA ao entregar o alerta no webhook (o alerta acima vale pelo log)'
  return 0
}

# ---------------------------------------------------------------------------
# Heartbeat (dead man's switch)
#
# Alerta de coisa que FALHOU depende de o processo ter rodado. Backup que nunca
# comeca — timer desabilitado, host desligado, disco cheio antes do primeiro
# byte — nao gera falha nenhuma: gera SILENCIO. O heartbeat inverte isso: o
# sucesso deixa uma marca datada, e quem cobra e o `monitora-saude.sh`, que
# alerta quando a marca fica velha demais.
#
# Duas marcas, porque cobrem coisas diferentes:
#   - arquivo local em HEARTBEAT_DIR: funciona sem internet e sem conta em
#     servico nenhum. Nao cobre a VPS inteira fora do ar.
#   - ping HTTP opcional (`<NOME>_HEARTBEAT_URL`, ex. Healthchecks.io): esse
#     cobre, porque quem cobra esta fora da VPS.
#
# Uso, no fim do processo que deu certo:
#   source "$(dirname "$0")/lib/alerta.sh"
#   alerta_heartbeat backup-postgres
# ---------------------------------------------------------------------------
HEARTBEAT_DIR="${HEARTBEAT_DIR:-/var/lib/crm-lab-monitor}"

alerta_heartbeat_arquivo() {
  printf '%s/%s.heartbeat' "$HEARTBEAT_DIR" "$1"
}

# alerta_heartbeat <nome>
alerta_heartbeat() {
  local nome="$1"
  local marca; marca="$(alerta_heartbeat_arquivo "$nome")"

  if mkdir -p "$HEARTBEAT_DIR" 2>/dev/null && date -Is > "$marca" 2>/dev/null; then
    alerta_log "heartbeat $nome gravado em $marca"
  else
    alerta_log "AVISO: nao consegui gravar o heartbeat em $marca (permissao?)"
  fi

  # `<NOME>_HEARTBEAT_URL` com o nome em maiusculas e `-` virando `_`:
  # backup-postgres -> BACKUP_POSTGRES_HEARTBEAT_URL
  local chave; chave="$(printf '%s' "$nome" | tr 'a-z-' 'A-Z_')_HEARTBEAT_URL"
  local url="${!chave:-}"
  [[ -n "$url" ]] || return 0

  curl -fsS --max-time "${ALERT_TIMEOUT:-10}" "$url" >/dev/null 2>&1 \
    || alerta_log "AVISO: ping de heartbeat para \$$chave falhou"
  return 0
}
