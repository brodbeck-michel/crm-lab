#!/usr/bin/env bash
#
# Recarrega o banco de HOMOLOGACAO com uma copia do dado de PRODUCAO.
#
# Direcao unica, por desenho: producao -> homologacao. Producao e acessada
# SOMENTE por `pg_dump` (leitura); nada neste script escreve no banco de
# producao, e nao existe flag que inverta o sentido.
#
# Uso (de dentro de /opt/crm-lab-homolog):
#   ./scripts/homolog-sincroniza-dados.sh              # dump novo de producao
#   ./scripts/homolog-sincroniza-dados.sh --do-backup  # usa o ultimo dump noturno
#
# ATENCAO/LGPD: isto traz dado real de paciente (nome, telefone, conversas e
# os ARQUIVOS de midia — foto de pedido medico, audio de recado)
# para um ambiente de teste. Por isso homologacao fica atras de senha na borda
# (basic auth do Caddy) e os canais de WhatsApp sao DESATIVADOS ao final —
# homologacao com credencial de canal ativa manda mensagem real para paciente
# real. Ver docs/guides/ENVIRONMENTS.md.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

PROJETO_HML='crm-lab-homolog'
PROJETO_PROD='crm-lab-prod'
BACKUPS_PROD='/opt/crm-lab/backups'

msg()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
erro() { printf '\n\033[1;31mABORTADO: %s\033[0m\n\n' "$*" >&2; exit 1; }

USAR_BACKUP=0
while (( $# )); do
  case "$1" in
    --do-backup) USAR_BACKUP=1; shift ;;
    *) erro "argumento desconhecido: $1" ;;
  esac
done

cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# 1. Provar que o DESTINO e homologacao — quatro vezes
#
# Este e o script com maior potencial de estrago do repositorio: ele roda
# `pg_restore --clean`, que DERRUBA as tabelas do destino antes de recriar.
# Apontado para producao, apaga producao. Entao ele nao confia em nada:
# confere .env, diretorio, nome de projeto e o LABEL do container que vai
# receber o restore.
# ---------------------------------------------------------------------------
[[ -f .env ]] || erro "nao achei $PROJECT_DIR/.env"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[[ "${APP_ENV:-}" == 'homologacao' ]] \
  || erro "APP_ENV='${APP_ENV:-vazio}' — este script SO roda em homologacao."
[[ "${COMPOSE_PROJECT_NAME:-}" == "$PROJETO_HML" ]] \
  || erro "COMPOSE_PROJECT_NAME='${COMPOSE_PROJECT_NAME:-vazio}' != $PROJETO_HML (.env copiado de producao?)"
[[ "$PROJECT_DIR" == '/opt/crm-lab-homolog' ]] \
  || erro "este script espera /opt/crm-lab-homolog, esta em $PROJECT_DIR"
: "${POSTGRES_USER:?POSTGRES_USER nao definido}"
: "${POSTGRES_DB:?POSTGRES_DB nao definido}"

container_de() {                  # $1 = projeto, $2 = servico
  docker ps -q \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.service=$2" | head -1
}

PG_HML="$(container_de "$PROJETO_HML" postgres)"
[[ -n "$PG_HML" ]] || erro "postgres de homologacao nao esta rodando (suba com ./scripts/deploy.sh)"

# Quarta trava: o label do container ALVO, lido do proprio docker. Se por
# qualquer motivo isto apontar para o projeto de producao, para aqui.
projeto_do_alvo="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG_HML")"
[[ "$projeto_do_alvo" == "$PROJETO_HML" ]] \
  || erro "container alvo pertence ao projeto '$projeto_do_alvo'"

info "destino: $PROJETO_HML / $POSTGRES_DB (container ${PG_HML:0:12})"

# ---------------------------------------------------------------------------
# 2. Origem: dump de producao (LEITURA)
# ---------------------------------------------------------------------------
mkdir -p "$PROJECT_DIR/backups"
DUMP=''

if (( USAR_BACKUP )); then
  DUMP="$(ls -1t "$BACKUPS_PROD"/crm_lab-*.dump 2>/dev/null | head -1 || true)"
  [[ -n "$DUMP" ]] || erro "nenhum dump em $BACKUPS_PROD"
  info "usando dump noturno: $(basename "$DUMP") ($(date -r "$DUMP" '+%F %H:%M'))"
else
  PG_PROD="$(container_de "$PROJETO_PROD" postgres)"
  [[ -n "$PG_PROD" ]] || erro "postgres de producao nao encontrado"
  # Usuario do banco de producao lido do PROPRIO container: assim este script
  # nao precisa (nem pode) ler o .env de producao.
  USER_PROD="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PG_PROD" \
    | sed -n 's/^POSTGRES_USER=//p' | head -1)"
  DB_PROD="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PG_PROD" \
    | sed -n 's/^POSTGRES_DB=//p' | head -1)"
  : "${USER_PROD:?nao consegui descobrir POSTGRES_USER de producao}"
  DUMP="$PROJECT_DIR/backups/de-producao-$(date +%F-%H%M).dump"
  msg "Dump de producao (somente leitura: pg_dump)"
  docker exec -i "$PG_PROD" pg_dump -U "$USER_PROD" -Fc "${DB_PROD:-crm_lab}" > "$DUMP.partial"
  mv "$DUMP.partial" "$DUMP"
  info "$(basename "$DUMP") ($(du -h "$DUMP" | cut -f1))"
fi

# ---------------------------------------------------------------------------
# 3. Rede de seguranca: o estado ATUAL de homologacao antes de sobrescrever
#
# Serve para o caso banal: alguem passou a tarde montando um cenario de teste
# em homologacao e outra pessoa roda este script.
# ---------------------------------------------------------------------------
ANTES="$PROJECT_DIR/backups/homolog-antes-$(date +%F-%H%M).dump"
msg "Salvando o homologacao atual em $(basename "$ANTES")"
docker exec -i "$PG_HML" pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$ANTES" || \
  info "(sem dump previo — banco vazio/novo, segue)"

# ---------------------------------------------------------------------------
# 4. Restore
#
# `--clean --if-exists` derruba os objetos antes de recriar; `--no-owner`
# porque o dono das tabelas em producao pode nao existir aqui.
# ---------------------------------------------------------------------------
msg "Restaurando em homologacao"
docker exec -i "$PG_HML" pg_restore \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --clean --if-exists --no-owner --no-privileges \
  < "$DUMP" 2> >(grep -v 'does not exist, skipping' >&2 || true) \
  || info "(pg_restore terminou com avisos — normal com --clean; conferindo abaixo)"

# ---------------------------------------------------------------------------
# 4.5. Arquivos de midia (o dump NAO os carrega)
#
# `message_media` viaja no dump, mas o ARQUIVO mora num volume proprio de cada
# ambiente (`<projeto>_media-data`). Sem esta copia, toda foto e audio vindos
# de producao aparecem como "nao foi possivel carregar" em homologacao — que
# foi exatamente o que pareceu bug de tela em 19/09.
#
# Producao entra como :ro; a copia nunca sobrescreve o que hml gerou (ids sao
# UUID, nao colidem). `cp -a /p/*` de proposito: o `-n` do busybox nao copia
# nada e ainda sai com rc=0.
# ---------------------------------------------------------------------------
msg "Copiando arquivos de midia de producao (leitura)"
docker run --rm \
  -v "${PROJETO_PROD}_media-data:/p:ro" \
  -v "${PROJETO_HML}_media-data:/h" \
  alpine sh -c 'cp -a /p/* /h/ 2>/dev/null; ls /h | wc -l' \
  | xargs -I{} info "{} arquivos de midia em homologacao"

# ---------------------------------------------------------------------------
# 5. Neutralizar o que pode VAZAR PARA FORA de homologacao
#
# Canal ativo + token valido = homologacao mandando WhatsApp para paciente de
# verdade. O token vem cifrado com a CHANNEL_SECRET_KEY de producao e nem
# decifraria aqui, mas "nem decifraria" nao e uma garantia: e um acidente
# esperando por uma variavel copiada.
# ---------------------------------------------------------------------------
msg "Desativando canais de mensagem (nada sai de homologacao)"
docker exec -i "$PG_HML" psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
UPDATE tenant_channels
   SET is_active = FALSE, api_token = NULL, webhook_secret = NULL, connected_at = NULL;
SQL

msg "Conferindo"
docker exec -i "$PG_HML" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT (SELECT count(*) FROM tenants)       AS tenants,
         (SELECT count(*) FROM users)         AS usuarios,
         (SELECT count(*) FROM patients)      AS pacientes,
         (SELECT count(*) FROM conversations) AS conversas,
         (SELECT count(*) FROM tenant_channels WHERE is_active) AS canais_ativos;"

msg "Homologacao agora tem o dado de producao. Reinicie o backend para limpar cache:"
info "docker compose -p $PROJETO_HML -f docker-compose.prod.yml restart backend"
