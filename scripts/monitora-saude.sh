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
#   COMPOSE_PROJECT_NAME   vem do `.env` do ambiente (mesma variavel que
#                          `deploy.sh` usa com `docker compose -p`). Prod e
#                          homolog rodam na MESMA VPS como dois projetos
#                          Compose separados (`crm-lab-prod` / `crm-lab-homolog`)
#                          — sem filtrar por ela, `docker ps` enxerga o HOST
#                          INTEIRO e um container quebrado em homolog dispara
#                          alerta de producao (ou vice-versa).
#
# Saida: 0 mesmo com alerta. E um monitor, nao um teste — o systemd nao deve
# marcar a unidade como falha porque o disco encheu; quem avisa e o alerta.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/alerta.sh
. "$SCRIPT_DIR/lib/alerta.sh"

PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
# `STATE_DIR` cai para `CRM_LAB_MONITOR_STATE_DIR` (default definido em
# lib/alerta.sh, ja carregado acima): e o MESMO diretorio que `HEARTBEAT_DIR`
# usa para o heartbeat do backup. Se um dia precisar mudar o caminho, mude
# `CRM_LAB_MONITOR_STATE_DIR` — assim os dois scripts continuam de acordo.
STATE_DIR="${STATE_DIR:-$CRM_LAB_MONITOR_STATE_DIR}"
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

# Prod e homolog compartilham a VPS como dois projetos Compose distintos
# (ver deploy.sh). Sem saber QUAL projeto monitorar, `docker ps` enxergaria os
# dois — por isso isto e obrigatorio, e nao um default silencioso.
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME nao definido (nem no ambiente, nem em $PROJECT_DIR/.env) — o monitor precisa saber qual projeto Compose filtrar, senao mistura alertas de producao e homologacao}"

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  msg_state_dir="STATE_DIR quebrado: nao consegui criar '$STATE_DIR' (diretorio ausente ou sem permissao) — alertas vao repetir a cada execucao ate isso ser corrigido"
  alerta_log "AVISO: $msg_state_dir"
  # `|| true` obrigatorio: sob `set -e`, o ULTIMO comando de uma lista `&&` no
  # nivel de cima nao e isento — um `logger` que falhe (sem /dev/log num
  # chroot/container minimo) abortava o monitor inteiro antes de qualquer
  # checagem rodar, e a unidade virava `failed` sem alerta: o proprio silencio
  # que este script veio eliminar (revisao do PR #24).
  { command -v logger >/dev/null 2>&1 && logger -p daemon.err -t crm-lab-monitor "$msg_state_dir"; } || true
fi

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
      if ! printf '%s\n' "$detalhe" > "$marca" 2>/dev/null; then
        registra_avisa_estado_quebrado "$marca"
      fi
    fi
    return 0
  fi

  if [[ -f "$marca" ]]; then
    alerta_envia info "RECUPERADO: $titulo" "$detalhe"
    if ! rm -f "$marca" 2>/dev/null; then
      registra_avisa_estado_quebrado "$marca"
    fi
  fi
}

# registra_avisa_estado_quebrado <marca>
#
# `registra()` nao pode abortar a varredura so porque STATE_DIR sumiu ou
# ficou sem permissao (rebuild de VPS, limpeza, passo de instalacao pulado)
# — o monitor deve continuar checando saude mesmo sem conseguir persistir
# estado. Mas engolir o erro em silencio e pior: SEM marca em disco, toda
# rodada de 5 em 5 minutos vira uma transicao "ok->ruim" nova, e o webhook
# `critical` dispara 288x/dia — exatamente o spam que o STATE_DIR existe para
# evitar, sem nenhuma pista no journal do motivo. Por isso isto vai para o
# log do sistema com prioridade alta, nao so para o stderr do `alerta_log`.
registra_avisa_estado_quebrado() {
  local marca="$1"
  local msg="STATE_DIR quebrado: nao consegui gravar/apagar '$marca' (diretorio ausente ou sem permissao) — alertas vao repetir a cada execucao ate isso ser corrigido"
  alerta_log "AVISO: $msg"
  if command -v logger >/dev/null 2>&1; then
    logger -p daemon.err -t crm-lab-monitor "$msg" 2>/dev/null || true
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

  # `--filter label=com.docker.compose.project=...`: sem isso, `docker ps`
  # escaneia o HOST INTEIRO — inclusive o outro ambiente que roda na mesma
  # VPS como projeto Compose separado.
  filtro_projeto=(--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")

  doentes="$(docker ps "${filtro_projeto[@]}" --filter health=unhealthy --format '{{.Names}}' | sort | tr '\n' ' ')"
  doentes="${doentes% }"
  if [[ -n "$doentes" ]]; then
    registra unhealthy ruim "Container unhealthy no CRM Lab [$COMPOSE_PROJECT_NAME]" "containers: $doentes"
  else
    registra unhealthy ok "Container unhealthy no CRM Lab [$COMPOSE_PROJECT_NAME]" 'todos os healthchecks voltaram'
  fi

  # `migrate` sai com 0 a cada deploy: alertar nele seria alertar em todo
  # deploy bem-sucedido, e alerta que sempre toca e alerta que ninguem le.
  saidos="$(docker ps -a "${filtro_projeto[@]}" --filter status=exited --format '{{.Names}} ({{.Status}})' \
    | { grep -Ev "$IGNORAR_EXITED" || true; } | sort | paste -sd';' - | sed 's/;/; /g')"
  if [[ -n "$saidos" ]]; then
    registra exited ruim "Container saiu e nao voltou [$COMPOSE_PROJECT_NAME]" "$saidos"
  else
    registra exited ok "Container saiu e nao voltou [$COMPOSE_PROJECT_NAME]" 'nenhum container parado'
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
