#!/usr/bin/env bash
#
# Deploy do CRM Lab — UM script para os DOIS ambientes.
#
#   /opt/crm-lab           -> producao    (projeto crm-lab-prod,    porta 8080)
#   /opt/crm-lab-homolog   -> homologacao (projeto crm-lab-homolog, porta 8081)
#
# Nao existe flag `--ambiente`: o ambiente vem de ONDE o script esta, cruzado
# com o `.env` daquele diretorio. Uma flag e uma coisa a mais para digitar
# errado as 23h de um dia ruim; o diretorio voce ja escolheu quando entrou
# nele. Ver docs/guides/ENVIRONMENTS.md.
#
# Uso:
#   ./scripts/deploy.sh                 # deploy de origin/main
#   ./scripts/deploy.sh --ref <ref>     # branch/tag/sha (so homologacao)
#   ./scripts/deploy.sh --sim           # sem a confirmacao digitada (producao)
#
# O que este script NUNCA faz, por desenho: `docker compose down`, qualquer
# `-v`, `volume rm`, `system prune`. Derrubar e apagar volume sao operacoes
# manuais e conscientes — nao passam por script de deploy.
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"

msg()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
erro() { printf '\n\033[1;31mABORTADO: %s\033[0m\n\n' "$*" >&2; exit 1; }

REF=''
CONFIRMADO=0
while (( $# )); do
  case "$1" in
    --ref) REF="${2:?--ref precisa de um valor}"; shift 2 ;;
    --sim|--yes) CONFIRMADO=1; shift ;;
    *) erro "argumento desconhecido: $1" ;;
  esac
done

cd "$PROJECT_DIR"

# ---------------------------------------------------------------------------
# 1. Identidade do ambiente — tres fontes que TEM que concordar
#
# Por que tres: cada uma pega um descuido diferente.
#   diretorio        -> pega `.env` de producao copiado para homologacao
#                       (o copiar traz APP_ENV e COMPOSE_PROJECT_NAME juntos,
#                        entao o par abaixo concordaria e o deploy de "homolog"
#                        reconstruiria PRODUCAO em cima do volume de producao)
#   APP_ENV          -> rotulo legivel, e o que vira selo na tela
#   COMPOSE_PROJECT_NAME -> e o que REALMENTE decide containers e VOLUMES
# ---------------------------------------------------------------------------
[[ -f .env ]] || erro "nao achei $PROJECT_DIR/.env"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

: "${APP_ENV:?APP_ENV nao definido no .env (production|homologacao)}"
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME nao definido no .env}"
: "${HTTP_PORT:?HTTP_PORT nao definido no .env}"

case "$APP_ENV" in
  production)
    PROJETO_ESPERADO='crm-lab-prod'
    DIR_ESPERADO='/opt/crm-lab'
    PREFIXO_TAG=''
    REF_PADRAO='origin/main'
    ;;
  homologacao)
    PROJETO_ESPERADO='crm-lab-homolog'
    DIR_ESPERADO='/opt/crm-lab-homolog'
    PREFIXO_TAG='hml-'
    REF_PADRAO='origin/main'
    ;;
  *) erro "APP_ENV='$APP_ENV' invalido (esperado: production ou homologacao)" ;;
esac

if [[ "$COMPOSE_PROJECT_NAME" != "$PROJETO_ESPERADO" ]]; then
  erro "$(printf '.env inconsistente: APP_ENV=%s exige COMPOSE_PROJECT_NAME=%s, mas esta %s.\n           Isso e sintoma de .env copiado entre ambientes — corrija ANTES de subir.' \
    "$APP_ENV" "$PROJETO_ESPERADO" "$COMPOSE_PROJECT_NAME")"
fi

if [[ "$PROJECT_DIR" != "$DIR_ESPERADO" && "${CRM_PERMITIR_DIR_DIFERENTE:-0}" != '1' ]]; then
  erro "$(printf 'APP_ENV=%s deveria morar em %s, mas este clone esta em %s.\n           Se o caminho mudou de verdade: CRM_PERMITIR_DIR_DIFERENTE=1 %s' \
    "$APP_ENV" "$DIR_ESPERADO" "$PROJECT_DIR" "$0")"
fi

# `-p` explicito em TODA chamada: um COMPOSE_PROJECT_NAME exportado na sessao
# vence o do `.env` e redirecionaria a stack inteira para o outro projeto.
dc() { docker compose -p "$PROJETO_ESPERADO" -f "$COMPOSE_FILE" "$@"; }

nome_resolvido="$(dc config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
[[ "$nome_resolvido" == "$PROJETO_ESPERADO" ]] \
  || erro "compose resolveu o projeto como '$nome_resolvido' e nao '$PROJETO_ESPERADO'"

# ---------------------------------------------------------------------------
# 2. Codigo
# ---------------------------------------------------------------------------
if [[ -n "$REF" && "$APP_ENV" == 'production' ]]; then
  erro "--ref e so para homologacao. Producao sobe o que esta em origin/main, revisado e mergeado."
fi
REF="${REF:-$REF_PADRAO}"

if [[ -n "$(git status --porcelain)" ]]; then
  git status --short
  erro "arvore suja neste clone. Imagem construida de codigo nao versionado e imagem que ninguem consegue reproduzir."
fi

msg "Buscando codigo ($REF)"
git fetch --prune --tags origin
git checkout --detach --quiet "$REF"          # detached: este clone nunca "tem branch" para divergir
SHA="$(git rev-parse --short HEAD)"
export IMAGE_TAG="${PREFIXO_TAG}${SHA}"
VERSAO="$(python3 -c 'import json;print(json.load(open("package.json"))["version"])')"
info "commit  $SHA"
info "versao  v$VERSAO (package.json da raiz — e o numero que aparece na tela)"
info "imagens ${IMAGE_REGISTRY:-}crm-lab-{backend,frontend}:$IMAGE_TAG"

# ---------------------------------------------------------------------------
# 3. Producao: checagem de versao/tag + confirmacao digitada
#
# A versao na tela e BUILD-TIME. Subir sem bump faz a tela mentir: ela mostra
# o numero antigo para codigo novo, e ai nao ha como saber o que esta no ar.
# ---------------------------------------------------------------------------
if [[ "$APP_ENV" == 'production' ]]; then
  if tag_exata="$(git describe --exact-match --tags HEAD 2>/dev/null)"; then
    info "tag     $tag_exata"
    [[ "$tag_exata" == "v$VERSAO" ]] \
      || erro "tag $tag_exata != versao v$VERSAO do package.json. Um dos dois esta errado."
  else
    printf '\n\033[1;33mAVISO: HEAD (%s) nao tem tag.\033[0m\n' "$SHA"
    info "O fluxo acordado e: bump do package.json -> commit -> tag vX.Y.Z -> push --follow-tags -> deploy."
    info "Sem isso a tela vai mostrar v$VERSAO para um codigo que nao e a v$VERSAO."
    CONFIRMADO=0
  fi

  if (( ! CONFIRMADO )); then
    printf '\n\033[1;31mVoce esta a um passo de reconstruir PRODUCAO (%s).\033[0m\n' "${CORS_ORIGIN:-?}"
    printf 'Digite PRODUCAO para continuar: '
    read -r resposta
    [[ "$resposta" == 'PRODUCAO' ]] || erro "confirmacao nao digitada"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Imagem -> migrate -> up -> limpeza
#
# CRMLAB-36: o CI publica `backend`/`frontend` no GHCR a cada push em `main`
# (job `docker`, `.github/workflows/ci.yml`) — o normal agora e' `pull`, nao
# `build` na propria VPS (que ocupava os 2 vCPU por ~10 min e deixava o outro
# ambiente lento). `IMAGE_REGISTRY` vem do `.env` do ambiente; sem ele, cai no
# fallback documentado (build local — ver docs/guides/DEPLOYMENT.md §2).
# ---------------------------------------------------------------------------
if [[ -n "${IMAGE_REGISTRY:-}" ]]; then
  msg "Pull das imagens ($APP_ENV, GHCR)"
  info "registry $IMAGE_REGISTRY"
  dc pull
else
  printf '\n\033[1;33mAVISO: IMAGE_REGISTRY nao definido no .env — build LOCAL (~10 min nos 2 vCPU).\033[0m\n'
  info "Defina IMAGE_REGISTRY=ghcr.io/<owner>/ no .env para usar as imagens ja publicadas pelo CI."
  msg "Build ($APP_ENV, ~10 min nos 2 vCPU)"
  dc build
fi

msg "Migrations"
dc run --rm migrate

msg "Subindo"
dc up -d

# Limpeza (CRMLAB-36): sem isso, imagem antiga + cache de build acumulam
# indefinidamente no disco (33 imagens / 3,4 GB de cache medidos na auditoria
# de 19/09). `until=336h` (14 dias) nunca alcanca a imagem que acabou de subir
# — so descarta o que ja envelheceu. Falha aqui NAO aborta o deploy: a stack
# ja esta de pe nesse ponto, faxina e' best-effort.
msg "Limpeza de imagens e cache antigos"
docker image prune -af --filter 'until=336h' || info "prune de imagens falhou (nao critico)"
docker builder prune -f --filter 'until=168h' || info "prune de build cache falhou (nao critico)"

# ---------------------------------------------------------------------------
# 5. Verificacao
# ---------------------------------------------------------------------------
porta="${HTTP_PORT##*:}"

# O health que vale e o do BACKEND (`/api/v1/health`, CRMLAB-29), nao o
# `/healthz` do nginx.
#
# `/healthz` e um `return 200 "ok"` do proprio nginx: responde mesmo com o
# backend morto, com o Postgres fora e com o Redis fora. Ate 19/09/2026 era
# ele que este passo consultava — ou seja, o deploy declarava "no ar" sem ter
# tocado em uma linha de codigo da aplicacao. Duas rajadas de 5xx no log do
# Caddy passaram por deploys "bem-sucedidos".
#
# `/api/v1/health` atravessa o proxy ate o backend, faz `SELECT 1` e `PING`, e
# devolve 503 (que o `-f` do curl reprova) quando uma dependencia esta fora.
SAUDE="http://127.0.0.1:${porta}/api/v1/health"
msg "Healthcheck real em $SAUDE"
for tentativa in $(seq 1 30); do
  if curl -fsS --max-time 10 "$SAUDE" >/dev/null 2>&1; then
    info "OK na tentativa $tentativa (backend, Postgres e Redis responderam)"
    dc ps --format 'table {{.Service}}\t{{.Status}}'
    msg "$APP_ENV no ar — $IMAGE_TAG (v$VERSAO)"
    exit 0
  fi
  sleep 2
done

dc ps
# O corpo do 503 diz QUAL dependencia caiu — imprimir aqui poupa a primeira
# rodada de investigacao as 23h.
printf '\nUltima resposta de %s:\n' "$SAUDE"
curl -sS --max-time 10 "$SAUDE" || true
printf '\n'
erro "nao respondeu 200 em $SAUDE em 60s. Se o /healthz do nginx responde e este nao, o nginx subiu e o BACKEND nao. A stack ANTERIOR pode ter sido substituida — investigue com 'docker compose -p $PROJETO_ESPERADO logs backend'."
