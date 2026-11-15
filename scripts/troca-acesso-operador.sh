#!/usr/bin/env bash
#
# Troca o e-mail e a senha do operador da plataforma (CRMLAB-157, D-323).
#
# Por que existe: o operador nao tem tela de "trocar senha" (`/users/*` recusa
# `platform_operator`, D-118) e o `cria-operador-plataforma.sh` e idempotente
# de proposito — nunca altera quem ja existe. Este script e o par dele.
#
# Uso (de dentro de /opt/crm-lab ou /opt/crm-lab-homolog, num terminal DE
# VERDADE — `ssh -t crm-vps`; a senha e lida com `read -s` e nao passa por
# argumento, historico do shell, nem por quem montou o comando):
#   ./scripts/troca-acesso-operador.sh --email-novo pessoa@exemplo.com
#
# O que faz, numa transacao so:
#   1. troca e-mail e `password_hash` (bcrypt cost 12, o mesmo do backend);
#   2. revoga TODAS as sessoes (refresh tokens) do operador — o access token
#      ainda vivo expira sozinho em ate 15 min (JWT_ACCESS_TTL=900);
#   3. grava audit log `update_platform_operator_credentials`, sem a senha.
#
# Igual ao `cria-operador-plataforma.sh`: o script fica no repo mas NAO no
# clone da VPS (arvore suja aborta o deploy.sh) — copiar, rodar e apagar.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
MIN_SENHA=14

msg()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
erro() { printf '\n\033[1;31mABORTADO: %s\033[0m\n\n' "$*" >&2; exit 1; }

EMAIL_NOVO=''
while (( $# )); do
  case "$1" in
    --email-novo) EMAIL_NOVO="${2:?--email-novo precisa de um valor}"; shift 2 ;;
    *) erro "argumento desconhecido: $1" ;;
  esac
done
[[ -n "$EMAIL_NOVO" ]] || erro 'informe --email-novo'
[[ "$EMAIL_NOVO" == *@*.* ]] || erro "--email-novo nao parece um e-mail: $EMAIL_NOVO"
EMAIL_NOVO="${EMAIL_NOVO,,}"
[[ -t 0 ]] || erro 'sem terminal: rode por `ssh -t crm-vps` (a senha e digitada, nao passada)'

cd "$PROJECT_DIR"

# --- 1. Identidade do ambiente (mesmo criterio do deploy.sh) ----------------
[[ -f .env ]] || erro "nao achei $PROJECT_DIR/.env"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${APP_ENV:?APP_ENV nao definido no .env}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME nao definido no .env}"
: "${POSTGRES_USER:?POSTGRES_USER nao definido no .env}"
: "${POSTGRES_DB:?POSTGRES_DB nao definido no .env}"
case "$APP_ENV" in
  production)  PROJETO_ESPERADO='crm-lab-prod';    DIR_ESPERADO='/opt/crm-lab';         ROTULO='PRODUCAO' ;;
  homologacao) PROJETO_ESPERADO='crm-lab-homolog'; DIR_ESPERADO='/opt/crm-lab-homolog'; ROTULO='homologacao' ;;
  *) erro "APP_ENV='$APP_ENV' invalido" ;;
esac
[[ "$COMPOSE_PROJECT_NAME" == "$PROJETO_ESPERADO" ]] || erro "COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME' != $PROJETO_ESPERADO"
[[ "$PROJECT_DIR" == "$DIR_ESPERADO" ]] || erro "APP_ENV='$APP_ENV' mas o script esta em $PROJECT_DIR"
msg "Ambiente: $ROTULO  ($COMPOSE_PROJECT_NAME em $PROJECT_DIR)"

dc() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"; }
psql_q() { dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -qtAX "$@"; }

# --- 2. Exatamente um operador ----------------------------------------------
msg 'Operador atual'
ATUAL="$(psql_q -c "SELECT email FROM users WHERE role = 'platform_operator';" </dev/null)"
QTD="$(grep -c . <<< "$ATUAL" || true)"
[[ "$QTD" == 1 ]] || erro "esperava 1 operador, achei $QTD — resolva a mao"
info "$ATUAL  ->  $EMAIL_NOVO"
DONO="$(psql_q -v e="$EMAIL_NOVO" <<'SQL'
SELECT count(*) FROM users WHERE lower(email) = lower(:'e') AND role <> 'platform_operator';
SQL
)"
[[ "$DONO" == 0 ]] || erro "o e-mail $EMAIL_NOVO ja pertence a outro usuario"

# --- 3. Senha nova, digitada duas vezes -------------------------------------
read -rsp "Senha nova (${MIN_SENHA}+ caracteres): " SENHA; echo
read -rsp 'Repita a senha: ' SENHA2; echo
[[ "$SENHA" == "$SENHA2" ]] || erro 'as senhas nao conferem'
unset SENHA2
(( ${#SENHA} >= MIN_SENHA )) || erro "a senha precisa de ao menos $MIN_SENHA caracteres"

if [[ "$APP_ENV" == 'production' ]]; then
  printf '\n\033[1;33mIsto troca o acesso do operador em PRODUCAO.\033[0m\nDigite PRODUCAO para confirmar: '
  read -r resposta
  [[ "$resposta" == 'PRODUCAO' ]] || erro 'confirmacao nao conferiu'
fi

msg 'Gerando hash bcrypt (cost 12, o mesmo do backend)'
# `exec` no backend que JA esta rodando, nao `run`: o `run` usa o IMAGE_TAG do
# .env, que pode estar velho e sem a imagem local — e ai tenta puxar do GHCR
# (15/11/2026: tag antiga, "error from registry: denied").
HASH="$(dc exec -T -e SENHA="$SENHA" backend \
          node -e 'process.stdout.write(require("bcryptjs").hashSync(process.env.SENHA, 12))' </dev/null)"
unset SENHA
[[ "$HASH" == \$2* ]] || erro 'hash bcrypt invalido'

# --- 4. Troca + revogacao + auditoria, numa transacao -----------------------
msg 'Gravando'
dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -qtAX \
  -v email="$EMAIL_NOVO" -v hash="$HASH" <<'SQL'
BEGIN;
WITH antes AS (
  SELECT id, tenant_id, email FROM users WHERE role = 'platform_operator' FOR UPDATE
), troca AS (
  UPDATE users u SET email = :'email', password_hash = :'hash', updated_at = NOW()
    FROM antes a WHERE u.id = a.id
  RETURNING u.id
), sessoes AS (
  UPDATE refresh_tokens r SET revoked_at = NOW(), revoked_reason = 'security'
    FROM antes a WHERE r.user_id = a.id AND r.revoked_at IS NULL
  RETURNING r.id
)
INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_values, new_values, user_agent)
SELECT a.tenant_id, NULL, 'update_platform_operator_credentials', 'user', a.id,
       jsonb_build_object('email', a.email),
       jsonb_build_object('email', :'email', 'password', 'trocada',
                          'sessoes_revogadas', (SELECT count(*) FROM sessoes),
                          'linhas', (SELECT count(*) FROM troca)),
       'scripts/troca-acesso-operador.sh'
  FROM antes a;
COMMIT;
SQL

# --- 5. Conferencia ----------------------------------------------------------
msg 'Conferindo'
psql_q -c "SELECT u.email || '  |  sessoes ativas: ' ||
                  (SELECT count(*) FROM refresh_tokens r WHERE r.user_id = u.id AND r.revoked_at IS NULL)
             FROM users u WHERE u.role = 'platform_operator';" </dev/null | while IFS= read -r l; do info "$l"; done
printf '\n\033[1;32mAcesso do operador trocado em %s.\033[0m Entre com o e-mail novo e guarde a senha no gerenciador.\n\n' "$ROTULO"
