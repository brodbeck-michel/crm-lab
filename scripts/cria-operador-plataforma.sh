#!/usr/bin/env bash
#
# Cria o operador da plataforma — o unico cadastro que NAO tem tela.
#
# Por que este script existe: o console da plataforma (`/platform/tenants`) e
# quem cadastra laboratorio novo, e so `platform_operator` entra la. Mas esse
# papel nao e atribuivel por admin de laboratorio (D-118: "a UI esconde, o
# servidor recusa") e o onboarding do primeiro operador nao passa por lugar
# nenhum da aplicacao. Alguem tem que nascer operador — e e aqui, uma vez por
# ambiente. Depois disso, TODO laboratorio novo entra pela tela.
#
# O operador mora no PROPRIO tenant (`plataforma`), sem exame, conversa ou
# proposta: `users.tenant_id` e NOT NULL, e e assim que SCHEMA.md modela o
# perfil. O console opera via `withoutTenant`, entao esse tenant nunca guarda
# dado de laboratorio.
#
# Uso (de dentro de /opt/crm-lab-homolog ou /opt/crm-lab):
#   ./scripts/cria-operador-plataforma.sh --email operador@vitrocrm.com.br
#   ./scripts/cria-operador-plataforma.sh --email x@y --nome "Michel" --senha '...'
#
# IDEMPOTENTE: se ja existir um `platform_operator`, o script informa quem e e
# sai sem tocar em nada. Rodar duas vezes por engano nao cria operador duplo.
#
# O que este script NUNCA faz: UPDATE, DELETE, ou qualquer escrita fora das
# duas linhas do operador. Ele nao mexe em laboratorio existente.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

msg()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
erro() { printf '\n\033[1;31mABORTADO: %s\033[0m\n\n' "$*" >&2; exit 1; }

EMAIL=''
NOME='Operador da Plataforma'
SENHA=''
CONFIRMADO=0
while (( $# )); do
  case "$1" in
    --email) EMAIL="${2:?--email precisa de um valor}"; shift 2 ;;
    --nome)  NOME="${2:?--nome precisa de um valor}";   shift 2 ;;
    --senha) SENHA="${2:?--senha precisa de um valor}"; shift 2 ;;
    --sim|--yes) CONFIRMADO=1; shift ;;
    *) erro "argumento desconhecido: $1" ;;
  esac
done

[[ -n "$EMAIL" ]] || erro "informe --email"
[[ "$EMAIL" == *@*.* ]] || erro "--email nao parece um e-mail: $EMAIL"

cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# 1. Identidade do ambiente — mesmo criterio do deploy.sh
#
# Nao existe flag `--ambiente`: o ambiente vem de ONDE o script esta, cruzado
# com o `.env` daquele diretorio. Aqui as tres fontes tambem tem que concordar,
# porque a diferenca entre criar um operador em homologacao e cria-lo em
# producao e exatamente um diretorio.
# ---------------------------------------------------------------------------
[[ -f .env ]] || erro "nao achei $PROJECT_DIR/.env"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${APP_ENV:?APP_ENV nao definido no .env (production|homologacao)}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME nao definido no .env}"
: "${POSTGRES_USER:?POSTGRES_USER nao definido no .env}"
: "${POSTGRES_DB:?POSTGRES_DB nao definido no .env}"

case "$APP_ENV" in
  production)
    PROJETO_ESPERADO='crm-lab-prod'
    DIR_ESPERADO='/opt/crm-lab'
    ROTULO='PRODUCAO'
    ;;
  homologacao)
    PROJETO_ESPERADO='crm-lab-homolog'
    DIR_ESPERADO='/opt/crm-lab-homolog'
    ROTULO='homologacao'
    ;;
  *) erro "APP_ENV='$APP_ENV' invalido (esperado: production ou homologacao)" ;;
esac

[[ "$COMPOSE_PROJECT_NAME" == "$PROJETO_ESPERADO" ]] \
  || erro "COMPOSE_PROJECT_NAME='$COMPOSE_PROJECT_NAME' != $PROJETO_ESPERADO (.env trocado?)"
[[ "$PROJECT_DIR" == "$DIR_ESPERADO" ]] \
  || erro "APP_ENV='$APP_ENV' mas o script esta em $PROJECT_DIR (esperado $DIR_ESPERADO)"

msg "Ambiente: $ROTULO  ($COMPOSE_PROJECT_NAME em $PROJECT_DIR)"

dc() { docker compose -p "$COMPOSE_PROJECT_NAME" -f "$COMPOSE_FILE" "$@"; }
psql_q() {
  dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -v ON_ERROR_STOP=1 -qtAX "$@"
}

# ---------------------------------------------------------------------------
# 2. Ja existe operador? Entao nao ha nada a fazer.
#
# A checagem vem ANTES da confirmacao de producao de proposito: rodar o script
# so para descobrir se o operador existe nao deve exigir digitar PRODUCAO.
# ---------------------------------------------------------------------------
msg 'Procurando operador da plataforma ja cadastrado'
EXISTENTE="$(psql_q -c "SELECT email FROM users WHERE role = 'platform_operator' ORDER BY created_at;")"

if [[ -n "$EXISTENTE" ]]; then
  info 'Ja existe operador da plataforma neste ambiente:'
  while IFS= read -r linha; do info "  - $linha"; done <<< "$EXISTENTE"
  printf '\nNada a fazer. Use o console em /platform/tenants.\n\n'
  exit 0
fi
info 'nenhum — seguindo com a criacao'

# ---------------------------------------------------------------------------
# 3. Producao pede confirmacao digitada
# ---------------------------------------------------------------------------
if [[ "$APP_ENV" == 'production' && "$CONFIRMADO" -eq 0 ]]; then
  printf '\n\033[1;33mIsto vai criar um usuario em PRODUCAO.\033[0m\n'
  printf 'Digite PRODUCAO para confirmar: '
  read -r resposta
  [[ "$resposta" == 'PRODUCAO' ]] || erro 'confirmacao nao conferiu'
fi

# ---------------------------------------------------------------------------
# 4. Senha e hash
#
# O hash e gerado pelo MESMO bcrypt do backend (`lib/password.ts`, cost 12),
# rodando dentro da imagem da API — nao por uma reimplementacao no banco. Se a
# senha viesse de `crypt()` do Postgres, o formato poderia divergir do que o
# login verifica, e o erro so apareceria na tela de login.
#
# `--no-deps` porque este container e descartavel e nao precisa subir mais
# nada; o Postgres ja esta de pe (o passo 2 falou com ele).
# ---------------------------------------------------------------------------
if [[ -z "$SENHA" ]]; then
  SENHA="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  SENHA_GERADA=1
else
  SENHA_GERADA=0
fi
(( ${#SENHA} >= 8 )) || erro 'a senha precisa de ao menos 8 caracteres (MIN_PASSWORD_LENGTH)'

msg 'Gerando hash bcrypt (cost 12, o mesmo do backend)'
HASH="$(dc run --rm --no-deps -T -e SENHA="$SENHA" backend \
          node -e 'process.stdout.write(require("bcryptjs").hashSync(process.env.SENHA, 12))')"
[[ "$HASH" == \$2* ]] || erro "hash bcrypt invalido: $HASH"
info 'ok'

# ---------------------------------------------------------------------------
# 5. Insere tenant da plataforma + operador, numa transacao so
#
# O hash viaja por `-v` (variavel do psql) e nao interpolado no SQL: bcrypt
# comeca com `$2a$` e `$` dentro de heredoc vira expansao de shell.
#
# `ON CONFLICT (slug) DO NOTHING` no tenant cobre o caso de o tenant
# `plataforma` ja existir sem operador (criacao interrompida no meio).
# ---------------------------------------------------------------------------
msg 'Criando tenant `plataforma` e o usuario operador'
dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -qtAX \
  -v email="$EMAIL" -v nome="$NOME" -v hash="$HASH" <<'SQL'
BEGIN;

INSERT INTO tenants (name, slug, is_active, subscription_plan, subscription_until)
VALUES ('Plataforma CRM Lab', 'plataforma', TRUE, 'enterprise', NULL)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (tenant_id, email, password_hash, name, role,
                   discount_limit_percent, is_active)
SELECT t.id, :'email', :'hash', :'nome', 'platform_operator', 0, TRUE
  FROM tenants t
 WHERE t.slug = 'plataforma';

COMMIT;
SQL

# ---------------------------------------------------------------------------
# 6. Confere o que ficou gravado
# ---------------------------------------------------------------------------
msg 'Conferindo'
psql_q -c "SELECT u.email || '  |  ' || u.role || '  |  tenant=' || t.slug
             FROM users u JOIN tenants t ON t.id = u.tenant_id
            WHERE u.role = 'platform_operator';" | while IFS= read -r l; do info "$l"; done

printf '\n\033[1;32mOperador criado em %s.\033[0m\n' "$ROTULO"
printf '    E-mail: %s\n' "$EMAIL"
if (( SENHA_GERADA )); then
  printf '    Senha:  %s\n' "$SENHA"
  printf '\n    Esta senha nao fica gravada em lugar nenhum — anote agora.\n'
fi
printf '\nEntre no sistema com ela: o login leva direto a /platform/tenants.\n\n'
