#!/usr/bin/env bash
#
# Backup dos bancos do CRM Lab (Postgres no compose de producao).
#
# Roda no HOST, via systemd timer (`scripts/systemd/`). Idempotente e seguro de
# rodar a mao a qualquer momento.
#
# Por que os DOIS bancos:
#   crm_lab   — conversas, mensagens, propostas. O dado do negocio.
#   evolution — sessao do WhatsApp (credenciais Baileys) + historico do gateway.
#               Perder este banco nao perde o CRM, mas OBRIGA a parear o numero
#               de novo, lendo o QR no celular do laboratorio. Em producao isso
#               e uma parada de atendimento, entao entra no backup.
#
# Auditoria de 2026-09-17: ate esta data nao havia backup nenhum. O unico dump
# existente era de 00:37 daquele dia, ANTERIOR a todas as 147 mensagens e 33
# conversas que ja estavam em producao. Perder o volume era perder tudo.
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/opt/crm-lab/docker-compose.prod.yml}"
PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
BACKUP_DIR="${BACKUP_DIR:-/opt/crm-lab/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DATABASES="${DATABASES:-crm_lab evolution}"

log() { printf '%s backup-postgres: %s\n' "$(date -Is)" "$*" >&2; }

cd "$PROJECT_DIR"

# `.env` traz POSTGRES_USER. Lido aqui e nao hardcoded: o usuario do banco ja
# divergiu do nome do proprio banco (`crm` para `crm_lab`), e um script que
# adivinha isso falha calado no meio da noite.
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi
: "${POSTGRES_USER:?POSTGRES_USER nao definido (.env de producao)}"

mkdir -p "$BACKUP_DIR"

stamp="$(date +%F-%H%M)"
falhas=0

for db in $DATABASES; do
  destino="$BACKUP_DIR/${db}-${stamp}.dump"
  parcial="${destino}.partial"

  # Escreve em `.partial` e so renomeia no fim: um dump interrompido (host
  # reiniciado, disco cheio) nunca deve ficar parecido com um backup bom. A
  # limpeza por retencao so enxerga `.dump`, entao o lixo parcial tambem nao
  # desloca um backup valido.
  if docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_dump -U "$POSTGRES_USER" -Fc "$db" > "$parcial"; then
    mv "$parcial" "$destino"
    log "ok $db -> $(basename "$destino") ($(du -h "$destino" | cut -f1))"
  else
    rm -f "$parcial"
    log "FALHOU $db"
    falhas=$((falhas + 1))
  fi
done

# Retencao so roda se TUDO deu certo: apagar backup antigo logo depois de
# falhar em gerar o novo e a melhor forma de ficar sem nenhum.
if (( falhas == 0 )); then
  find "$BACKUP_DIR" -name '*.dump' -type f -mtime "+${RETENTION_DAYS}" -print -delete \
    | while read -r antigo; do log "expirado $(basename "$antigo")"; done
else
  log "retencao NAO executada: $falhas banco(s) falharam"
  exit 1
fi

log "concluido"
