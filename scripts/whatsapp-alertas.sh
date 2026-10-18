#!/usr/bin/env bash
#
# Numero de WhatsApp que ENVIA os alertas do monitor (CRMLAB-99, D-269).
#
# E uma instancia propria do Evolution (`ALERT_EVOLUTION_INSTANCE`, default
# `alertas`), separada das instancias `tenant-<id>` dos laboratorios e SEM
# webhook: o que alguem responder para esse numero nao entra no CRM.
#
# Uso (na VPS, de dentro do diretorio do ambiente, como `deploy`):
#   scripts/whatsapp-alertas.sh parear [numero-do-chip]
#       Cria a instancia (se faltar) e mostra como parear. Com o numero do chip
#       (so digitos, com DDI), mostra tambem o CODIGO de pareamento, que se
#       digita no celular em Aparelhos conectados > Conectar com numero de
#       telefone — sem precisar ver o QR.
#   scripts/whatsapp-alertas.sh estado
#   scripts/whatsapp-alertas.sh testar
#       Manda um alerta de teste pelo mesmo caminho do monitor e diz por onde
#       saiu (instancia do Evolution ou CallMeBot).
#
# Le o `.env` do ambiente (EVOLUTION_API_KEY, COMPOSE_PROJECT_NAME) e o
# `/etc/crm-lab/monitor.env` (ALERT_WHATSAPP_TO, ALERT_CALLMEBOT_APIKEY...).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
# shellcheck source=lib/alerta.sh
. "$SCRIPT_DIR/lib/alerta.sh"

for arquivo in "$PROJECT_DIR/.env" /etc/crm-lab/monitor.env; do
  if [[ -r "$arquivo" ]]; then
    set -a
    # shellcheck disable=SC1090
    . "$arquivo"
    set +a
  fi
done

: "${EVOLUTION_API_KEY:?EVOLUTION_API_KEY nao definida (rode de dentro do diretorio do ambiente)}"
INSTANCIA="${ALERT_EVOLUTION_INSTANCE:-alertas}"
URL="$(alerta_evolution_url)" || {
  echo "Evolution nao encontrado (COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-<vazio>})" >&2
  exit 1
}

evo() {
  local metodo="$1" caminho="$2" corpo="${3:-}"
  curl -sS --max-time 20 -X "$metodo" -H 'Content-Type: application/json' \
    -H "apikey: $EVOLUTION_API_KEY" ${corpo:+--data "$corpo"} "$URL$caminho"
}

case "${1:-}" in
  parear)
    numero="$(printf '%s' "${2:-}" | tr -cd '0-9')"
    # 403 "already in use" = ja existe; segue para o connect.
    evo POST /instance/create \
      "{\"instanceName\":\"$INSTANCIA\",\"qrcode\":true,\"integration\":\"WHATSAPP-BAILEYS\"}" >/dev/null || true
    resposta="$(evo GET "/instance/connect/$INSTANCIA${numero:+?number=$numero}")"
    RESPOSTA="$resposta" QR_PNG="/tmp/$INSTANCIA-qr.png" python3 - <<'PY'
import base64, json, os
r = json.loads(os.environ["RESPOSTA"] or "{}")
estado = (r.get("instance") or {}).get("state")
if estado == "open":
    print("Instancia ja conectada. Nada a fazer.")
    raise SystemExit
if r.get("pairingCode"):
    print("Codigo de pareamento:", r["pairingCode"])
    print("No celular do chip: WhatsApp > Aparelhos conectados > Conectar aparelho > Conectar com numero de telefone.")
b64 = (r.get("base64") or "").split(",", 1)[-1]
if b64:
    open(os.environ["QR_PNG"], "wb").write(base64.b64decode(b64))
    print("QR Code salvo em", os.environ["QR_PNG"], "(expira em ~40 s; rode de novo se vencer).")
if not r.get("pairingCode") and not b64:
    print("Resposta inesperada do Evolution:", json.dumps(r)[:300])
PY
    ;;
  estado)
    evo GET "/instance/connectionState/$INSTANCIA"
    echo
    ;;
  testar)
    [[ -n "${ALERT_WHATSAPP_TO:-}" ]] || { echo 'ALERT_WHATSAPP_TO nao definida em /etc/crm-lab/monitor.env' >&2; exit 1; }
    if alerta_whatsapp "$(alerta_texto info 'Teste de alerta do CRM Lab' 'Se chegou, o caminho de alerta esta funcionando.')"; then
      echo 'Entregue (o log acima diz por qual caminho).'
    else
      echo 'NAO entregue por nenhum caminho (ver log acima).' >&2
      exit 1
    fi
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
