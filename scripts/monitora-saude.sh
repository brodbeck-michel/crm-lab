#!/usr/bin/env bash
#
# Saude da VPS e dos containers do CRM Lab (CRMLAB-29).
#
# Roda no HOST, via systemd timer (`scripts/systemd/crm-lab-monitor.timer`),
# de 5 em 5 minutos. So LE: nao reinicia container, nao apaga arquivo, nao
# sobe nada. Diagnostico e acao sao coisas separadas de proposito — um script
# que "conserta sozinho" de madrugada e um script que esconde o problema.
#
# O que verifica:
#   1. container `unhealthy` (`docker ps --filter health=unhealthy`)
#   2. container que SAIU (`status=exited`), ignorando o `migrate`, que sai com
#      0 por desenho a cada deploy
#   3. readiness da API pela borda (`/api/v1/health` — 503 quando Postgres ou
#      Redis caem; o `/healthz` do nginx nao serve, ele responde ok sozinho)
#   4. disco acima de `CRM_DISCO_LIMITE`% (default 80)
#   5. reboot pendente (`/var/run/reboot-required`)
#   6. heartbeat do backup mais velho que `CRM_BACKUP_MAX_HORAS` (default 26)
#
# Cada verificacao tem ESTADO em disco: alerta quando muda para ruim, e avisa
# "recuperado" quando volta. Sem isso, um monitor de 5 em 5 minutos manda 288
# mensagens por dia da mesma coisa e vira ruido que ninguem le.
#
# Configuracao:
#   ALERT_WEBHOOK_URL / ALERT_WEBHOOK_TOKEN / ALERT_SOURCE  (ver lib/alerta.sh)
#   STATE_DIR              default /var/lib/crm-lab-monitor
#   CRM_DISCO_LIMITE       default 80
#   CRM_BACKUP_MAX_HORAS   default 26 (o backup e diario as 03:10)
#   CRM_HEALTH_URL         default http://127.0.0.1:${HTTP_PORT:-8080}/api/v1/health
#   CRM_IGNORAR_EXITED     regex de nomes ignorados. Default: migrate
#
# Saida: 0 mesmo com alerta. E um monitor, nao um teste — o systemd nao deve
# marcar a unidade como falha porque o disco encheu; quem avisa e o alerta.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/alerta.sh
. "$SCRIPT_DIR/lib/alerta.sh"

PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
STATE_DIR="${STATE_DIR:-/var/lib/crm-lab-monitor}"
DISCO_LIMITE="${CRM_DISCO_LIMITE:-80}"
BACKUP_MAX_HORAS="${CRM_BACKUP_MAX_HORAS:-26}"
IGNORAR_EXITED="${CRM_IGNORAR_EXITED:-migrate}"

# `if`, e nao `[[ ... ]] && { ... }`: com `set -e`, um teste falso na ultima
# linha de um comando composto no nivel de cima encerra o script.
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi
# `HTTP_PORT` no `.env` pode vir como `8080` ou `127.0.0.1:8080`; so a porta
# interessa aqui.
porta="${HTTP_PORT:-8080}"
HEALTH_URL="${CRM_HEALTH_URL:-http://127.0.0.1:${porta##*:}/api/v1/health}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Maquina de estado: alerta na BORDA (ok -> ruim) e na volta (ruim -> ok).
# ---------------------------------------------------------------------------
# registra <chave> <ok|ruim> <titulo> [detalhe]
registra() {
  local chave="$1" estado="$2" titulo="$3" detalhe="${4:-}"
  local marca="$STATE_DIR/alerta-$chave"

  if [[ "$estado" == 'ruim' ]]; then
    if [[ -f "$marca" ]]; then
      alerta_log "ainda ruim (sem repetir alerta): $chave"
    else
      alerta_envia critical "$titulo" "$detalhe"
      printf '%s\n' "$detalhe" > "$marca" 2>/dev/null || true
    fi
    return 0
  fi

  if [[ -f "$marca" ]]; then
    alerta_envia info "RECUPERADO: $titulo" "$detalhe"
    rm -f "$marca" 2>/dev/null || true
  fi
}

# ---------------------------------------------------------------------------
# 1 e 2. Containers
# ---------------------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  registra docker ruim 'Docker nao responde na VPS' \
    'docker info falhou — engine parado ou sem permissao para o usuario do timer'
else
  registra docker ok 'Docker nao responde na VPS' 'docker info voltou a responder'

  doentes="$(docker ps --filter health=unhealthy --format '{{.Names}}' | sort | tr '\n' ' ')"
  doentes="${doentes% }"
  if [[ -n "$doentes" ]]; then
    registra unhealthy ruim 'Container unhealthy no CRM Lab' "containers: $doentes"
  else
    registra unhealthy ok 'Container unhealthy no CRM Lab' 'todos os healthchecks voltaram'
  fi

  # `migrate` sai com 0 a cada deploy: alertar nele seria alertar em todo
  # deploy bem-sucedido, e alerta que sempre toca e alerta que ninguem le.
  saidos="$(docker ps -a --filter status=exited --format '{{.Names}} ({{.Status}})' \
    | { grep -Ev "$IGNORAR_EXITED" || true; } | sort | tr '\n' '; ')"
  saidos="${saidos%; }"
  if [[ -n "$saidos" ]]; then
    registra exited ruim 'Container saiu e nao voltou' "$saidos"
  else
    registra exited ok 'Container saiu e nao voltou' 'nenhum container parado'
  fi
fi

# ---------------------------------------------------------------------------
# 3. Readiness da API (o health honesto, nao o /healthz do nginx)
# ---------------------------------------------------------------------------
if curl -fsS --max-time 10 "$HEALTH_URL" >/dev/null 2>&1; then
  registra api ok 'API do CRM Lab fora do ar ou degradada' "$HEALTH_URL respondeu 200"
else
  # Sem `-f`: o corpo do 503 diz QUAL dependencia caiu, e isso e o alerta util.
  detalhe="$(curl -sS --max-time 10 "$HEALTH_URL" 2>/dev/null | head -c 400 || true)"
  registra api ruim 'API do CRM Lab fora do ar ou degradada' \
    "$HEALTH_URL nao respondeu 200. Corpo: ${detalhe:-<vazio, backend nao respondeu>}"
fi

# ---------------------------------------------------------------------------
# 4. Disco
# ---------------------------------------------------------------------------
uso="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [[ -n "$uso" ]] && (( uso >= DISCO_LIMITE )); then
  registra disco ruim "Disco da VPS em ${uso}%" \
    "limite ${DISCO_LIMITE}%. Candidatos: backups antigos, imagens Docker orfas, logs."
else
  registra disco ok "Disco da VPS acima de ${DISCO_LIMITE}%" "uso atual ${uso}%"
fi

# ---------------------------------------------------------------------------
# 5. Reboot pendente
# ---------------------------------------------------------------------------
if [[ -f /var/run/reboot-required ]]; then
  pacotes="$(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null || true)"
  registra reboot ruim 'Reboot pendente na VPS' \
    "atualizacao de kernel/libs aguardando reinicio. Pacotes: ${pacotes:-desconhecidos}"
else
  registra reboot ok 'Reboot pendente na VPS' 'sem reboot pendente'
fi

# ---------------------------------------------------------------------------
# 6. Dead man's switch do backup
#
# Quem grava a marca e o proprio backup, chamando `alerta_heartbeat` no fim
# (ver lib/alerta.sh). Enquanto essa linha nao existir no backup-postgres.sh,
# esta verificacao fica em silencio de proposito: alertar por marca que nunca
# foi escrita seria alarme falso diario.
# ---------------------------------------------------------------------------
marca_backup="$(alerta_heartbeat_arquivo backup-postgres)"
if [[ -f "$marca_backup" ]]; then
  idade_min=$(( ( $(date +%s) - $(stat -c %Y "$marca_backup") ) / 60 ))
  if (( idade_min > BACKUP_MAX_HORAS * 60 )); then
    registra backup ruim 'Backup do CRM Lab nao rodou' \
      "ultimo sucesso ha $(( idade_min / 60 ))h (teto ${BACKUP_MAX_HORAS}h). Ver: journalctl -u crm-lab-backup"
  else
    registra backup ok 'Backup do CRM Lab nao rodou' \
      "ultimo sucesso ha $(( idade_min / 60 ))h"
  fi
else
  alerta_log "heartbeat do backup ainda nao existe ($marca_backup) — verificacao inativa"
fi

alerta_log 'varredura concluida'
exit 0
