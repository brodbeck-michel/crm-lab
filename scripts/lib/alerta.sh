#!/usr/bin/env bash
#
# Notificador de alerta — PLUGAVEL (CRMLAB-29).
#
# Biblioteca para ser lida com `source`, nao executada. Quem usa:
#   scripts/monitora-saude.sh   (saude dos containers, disco, reboot, backup)
#   scripts/backup-postgres.sh  (heartbeat no fim — ver "Heartbeat" abaixo)
#
# Dois destinos, independentes (CRMLAB-29 o webhook; CRMLAB-99 o WhatsApp):
#
#   Mensagem (D-269): o alerta vira texto e sai por DOIS caminhos em sequencia
#   — primeiro o WhatsApp `ALERT_WHATSAPP_TO`, pela instancia propria do
#   Evolution (`ALERT_EVOLUTION_INSTANCE`, um numero so de alertas, NUNCA o de
#   um laboratorio); se ele falhar (gateway fora, instancia nao pareada), um
#   bot do Telegram, que mora fora da VPS. Alerta que depende so do que quebrou
#   nao chega: o Evolution sozinho nao avisaria que o Evolution caiu.
#
#   Webhook generico: `ALERT_WEBHOOK_URL` (n8n, ntfy, Healthchecks.io...).
#
# Configuracao (todas opcionais — sem nenhuma, o alerta vai so para o log):
#   ALERT_WHATSAPP_TO        numero que RECEBE (so digitos, com DDI: 5548...).
#   ALERT_EVOLUTION_INSTANCE instancia do Evolution que ENVIA. Default: alertas.
#   ALERT_EVOLUTION_URL      base do Evolution. Default: IP do container
#                            `evolution` do projeto `COMPOSE_PROJECT_NAME`
#                            (o servico nao publica porta no host).
#   EVOLUTION_API_KEY        chave administrativa do gateway (vem do `.env`).
#   ALERT_TELEGRAM_BOT_TOKEN token do bot (do @BotFather) — caminho reserva.
#   ALERT_TELEGRAM_CHAT_ID   conversa que recebe (`whatsapp-alertas.sh telegram-chat-id`).
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

# alerta_tem_destino — 0 se algum destino (WhatsApp ou webhook) esta configurado.
alerta_tem_destino() {
  [[ -n "${ALERT_WHATSAPP_TO:-}" || -n "${ALERT_TELEGRAM_CHAT_ID:-}" || -n "${ALERT_WEBHOOK_URL:-}" ]]
}

# alerta_evolution_url — base HTTP do Evolution, ou nada (retorno 1).
alerta_evolution_url() {
  if [[ -n "${ALERT_EVOLUTION_URL:-}" ]]; then
    printf '%s' "${ALERT_EVOLUTION_URL%/}"
    return 0
  fi
  [[ -n "${COMPOSE_PROJECT_NAME:-}" ]] || return 1
  local id ip
  id="$(docker ps --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME" \
    --filter label=com.docker.compose.service=evolution --format '{{.ID}}' 2>/dev/null | head -n1 || true)"
  [[ -n "$id" ]] || return 1
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id" 2>/dev/null \
    | awk '{print $1}' || true)"
  [[ -n "$ip" ]] || return 1
  printf 'http://%s:8080' "$ip"
}

# alerta_texto <severidade> <titulo> <detalhe> — mensagem legivel no celular.
alerta_texto() {
  local icone
  case "$1" in
    critical) icone='🔴' ;;
    info) icone='🟢' ;;
    *) icone='🟡' ;;
  esac
  printf '%s *%s*\n%s\n\n%s · %s' "$icone" "$2" "${3:-}" \
    "${ALERT_SOURCE:-$(hostname)}" "$(TZ=America/Sao_Paulo date '+%d/%m %H:%M')"
}

# alerta_whatsapp <texto> — 0 se a instancia do Evolution entregou.
alerta_whatsapp() {
  local texto="$1" numero url corpo
  numero="$(printf '%s' "${ALERT_WHATSAPP_TO:-}" | tr -cd '0-9')"
  [[ -n "$numero" ]] || return 1

  local instancia="${ALERT_EVOLUTION_INSTANCE:-alertas}"
  if [[ -z "${EVOLUTION_API_KEY:-}" ]] || ! url="$(alerta_evolution_url)"; then
    alerta_log 'Evolution indisponivel para alerta (sem EVOLUTION_API_KEY ou sem container)'
    return 1
  fi
  corpo="$(ALERTA_NUM="$numero" ALERTA_TXT="$texto" python3 -c '
import json, os
print(json.dumps({"number": os.environ["ALERTA_NUM"], "text": os.environ["ALERTA_TXT"]}, ensure_ascii=False))')"
  if curl -fsS --max-time "${ALERT_TIMEOUT:-10}" -X POST \
      -H 'Content-Type: application/json' -H "apikey: ${EVOLUTION_API_KEY}" \
      --data "$corpo" "$url/message/sendText/$instancia" >/dev/null 2>&1; then
    alerta_log "WhatsApp entregue pela instancia '$instancia' do Evolution"
    return 0
  fi
  alerta_log "envio pela instancia '$instancia' do Evolution falhou"
  return 1
}

# alerta_telegram <texto> — 0 se o bot do Telegram entregou.
alerta_telegram() {
  [[ -n "${ALERT_TELEGRAM_BOT_TOKEN:-}" && -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]] || {
    alerta_log 'Telegram nao configurado (ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID)'
    return 1
  }
  # Texto puro, sem `parse_mode`: o `*negrito*` do WhatsApp sai sem os
  # asteriscos, e um `_` num nome de arquivo nao derruba o envio com 400.
  if curl -fsS --max-time "${ALERT_TIMEOUT:-10}" -X POST \
      "https://api.telegram.org/bot${ALERT_TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${ALERT_TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=${1//\*/}" >/dev/null 2>&1; then
    alerta_log 'alerta entregue pelo Telegram'
    return 0
  fi
  alerta_log 'envio pelo Telegram falhou'
  return 1
}

# alerta_mensagem <texto> — WhatsApp; se falhar, Telegram. 0 se algum entregou.
alerta_mensagem() {
  if [[ -n "${ALERT_WHATSAPP_TO:-}" ]]; then
    alerta_whatsapp "$1" && return 0
    alerta_log 'tentando o caminho reserva (Telegram)'
  fi
  alerta_telegram "$1"
}

# alerta_envia <severidade: critical|warning|info> <titulo> [detalhe]
#
# Severidade `info` e usada para "recuperado": o criterio de aceite do card
# pede que a volta tambem avise, senao ninguem sabe se ainda esta fora.
#
# Sempre sai 0. Quem precisa saber se chegou le `ALERTA_FALHOU` (1 = algum
# destino configurado nao recebeu): o monitor usa isso para tentar de novo na
# rodada seguinte em vez de dar o alerta por entregue.
alerta_envia() {
  local severidade="$1" titulo="$2" detalhe="${3:-}"
  ALERTA_FALHOU=0
  alerta_log "[$severidade] $titulo${detalhe:+ — $detalhe}"

  alerta_tem_destino || {
    alerta_log 'nenhum destino configurado (ALERT_WHATSAPP_TO / ALERT_TELEGRAM_CHAT_ID / ALERT_WEBHOOK_URL): alerta ficou so no log'
    return 0
  }

  if [[ -n "${ALERT_WHATSAPP_TO:-}" || -n "${ALERT_TELEGRAM_CHAT_ID:-}" ]]; then
    alerta_mensagem "$(alerta_texto "$severidade" "$titulo" "$detalhe")" \
      || { ALERTA_FALHOU=1; alerta_log 'FALHA ao entregar o alerta no WhatsApp e no Telegram (o alerta acima vale pelo log)'; }
  fi

  [[ -n "${ALERT_WEBHOOK_URL:-}" ]] || return 0

  local -a cabecalhos=(-H 'Content-Type: application/json')
  [[ -n "${ALERT_WEBHOOK_TOKEN:-}" ]] \
    && cabecalhos+=(-H "Authorization: Bearer ${ALERT_WEBHOOK_TOKEN}")

  if curl -fsS --max-time "${ALERT_TIMEOUT:-10}" -X POST \
      "${cabecalhos[@]}" \
      --data "$(alerta_payload "$severidade" "$titulo" "$detalhe")" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    return 0
  fi

  ALERTA_FALHOU=1
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
#
# `CRM_LAB_MONITOR_STATE_DIR` e o default COMPARTILHADO com `STATE_DIR` de
# monitora-saude.sh: os dois scripts leem o mesmo diretorio de estado, entao
# tem uma unica variavel de ambiente para mudar o caminho dos dois de uma vez
# (em vez de duas variaveis independentes que so por acaso apontam para o
# mesmo default). `HEARTBEAT_DIR` continua existindo para quem quiser um
# caminho SO para o heartbeat, diferente do STATE_DIR do monitor — caso raro,
# por isso o default dela cai para `CRM_LAB_MONITOR_STATE_DIR`.
# ---------------------------------------------------------------------------
CRM_LAB_MONITOR_STATE_DIR="${CRM_LAB_MONITOR_STATE_DIR:-/var/lib/crm-lab-monitor}"
HEARTBEAT_DIR="${HEARTBEAT_DIR:-$CRM_LAB_MONITOR_STATE_DIR}"

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
