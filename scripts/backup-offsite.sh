#!/usr/bin/env bash
#
# Copia CIFRADA dos backups do CRM Lab para fora da VPS (GitHub Releases).
#
# Roda no HOST, logo depois de `backup-postgres.sh`, pelo mesmo
# `crm-lab-backup.service` (segundo ExecStart=). Idempotente: rodar duas vezes
# no mesmo dia re-sobe os mesmos assets (`--clobber`), nao duplica release.
#
# POR QUE ESTE SCRIPT EXISTE
#   Ate a auditoria de 2026-09-19 o backup diario funcionava, mas os dumps
#   ficavam SO em /opt/crm-lab/backups — no mesmo disco da VPS. Falha da
#   Hostinger, comprometimento do host ou um `rm` errado levava o backup junto
#   com o dado. Backup que mora no mesmo disco do banco nao e backup, e copia.
#
# POR QUE E UM ARQUIVO SEPARADO DE `backup-postgres.sh`
#   Sao dois dominios de falha diferentes. O dump local so depende do Postgres
#   estar de pe; o envio externo depende de rede, do `gh` autenticado e da
#   chave de cifragem. Misturar os dois faria uma falha de rede abortar (ou
#   pior, mascarar) o backup local, que e a ultima linha de defesa. Separados,
#   o systemd roda o local primeiro: se ele falhar, o envio nem comeca; se so
#   o envio falhar, o dump do dia ja esta salvo em disco.
#
# POR QUE GITHUB RELEASES E NAO COMMITS
#   Git nunca esquece. Commit diario de ~5 MB (dois dumps + tar da midia)
#   cresce para sempre e so encolhe reescrevendo historico. Release e
#   armazenamento de artefato: apagar release vencida libera espaco de verdade.
#
# POR QUE CIFRAR ANTES DE SUBIR (nao e opcional)
#   Os dumps tem nome de paciente, telefone, conversa e midia (foto de pedido
#   medico, audio). Mandar isso em claro para um terceiro nao passa em LGPD,
#   mesmo em repositorio privado. O script RECUSA subir sem chave configurada.
#
#   Preferencia por `age` com DESTINATARIO (chave publica): a VPS guarda so a
#   publica, entao quem comprometer o host cifra novos backups mas NAO decifra
#   os antigos. Com gpg simetrico a mesma senha cifra e decifra, e ela precisa
#   morar no .env do host — por isso e o plano B.
#
#   >>> CHAVE PERDIDA = BACKUP INUTIL. Nao ha recuperacao. <<<
#   A chave privada mora FORA da VPS e fora do repositorio, com o Michel.
#   Ver "Backup e restore" em docs/guides/DEPLOYMENT.md.
#
# Configuracao (em /opt/crm-lab/.env, que ja e chmod 600 — nunca no repo):
#   BACKUP_OFFSITE_REPO      owner/repo privado de destino  (obrigatorio)
#   GH_TOKEN                 PAT com escopo `repo`          (obrigatorio)
#   BACKUP_AGE_RECIPIENT     chave publica age (age1...)    (preferido)
#   BACKUP_GPG_PASSPHRASE    senha simetrica                (alternativa)
#   BACKUP_REMOTE_RETENTION_DAYS   default 30 (local e 14)
#
# Ensaio sem tocar em nada externo: BACKUP_OFFSITE_DRYRUN=1 ./backup-offsite.sh
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/crm-lab}"
BACKUP_DIR="${BACKUP_DIR:-/opt/crm-lab/backups}"
MEDIA_VOLUME="${MEDIA_VOLUME:-crm-lab-prod_media-data}"
DRYRUN="${BACKUP_OFFSITE_DRYRUN:-0}"

log() { printf '%s backup-offsite: %s\n' "$(date -Is)" "$*" >&2; }

# O .env de producao traz o destino e a chave. Lido aqui e nao passado pelo
# systemd para que o script continue rodavel a mao, do mesmo jeito que o
# `backup-postgres.sh`.
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

RETENCAO_REMOTA="${BACKUP_REMOTE_RETENTION_DAYS:-30}"
: "${BACKUP_OFFSITE_REPO:?BACKUP_OFFSITE_REPO nao definido (.env de producao): owner/repo privado de destino}"

# ---------------------------------------------------------------------------
# 1. Escolher o metodo de cifragem — e recusar se nao houver nenhum
#
# Falhar aqui, cedo e alto, e melhor do que subir dado de paciente em claro.
# O `OnFailure=` do service transforma esta saida em alerta.
# ---------------------------------------------------------------------------
if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null || { log "BACKUP_AGE_RECIPIENT definido mas 'age' nao esta instalado"; exit 1; }
  METODO='age'; EXT='age'
elif [[ -n "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
  command -v gpg >/dev/null || { log "BACKUP_GPG_PASSPHRASE definido mas 'gpg' nao esta instalado"; exit 1; }
  METODO='gpg'; EXT='gpg'
else
  log "RECUSANDO: nenhuma chave de cifragem configurada (BACKUP_AGE_RECIPIENT ou BACKUP_GPG_PASSPHRASE)."
  log "Os dumps tem dado de paciente; subir em claro para um terceiro nao passa em LGPD."
  exit 1
fi

command -v gh >/dev/null || { log "'gh' nao esta instalado/no PATH"; exit 1; }

hoje="$(date +%F)"
tag="backup-${hoje}"

# Diretorio de trabalho proprio: os artefatos cifrados sao intermediarios e nao
# devem se misturar aos `.dump` que a retencao local enxerga.
trabalho="$(mktemp -d "${TMPDIR:-/tmp}/crm-lab-offsite.XXXXXX")"
trap 'rm -rf "$trabalho"' EXIT

# ---------------------------------------------------------------------------
# 2. Juntar o que sobe: os dumps DO DIA + um tar do volume de midia
#
# A midia nao viaja no dump. `message_media` referencia o arquivo, mas o
# arquivo mora no volume `crm-lab-prod_media-data`. Restaurar so o banco deixa
# toda foto de pedido medico e todo audio como "nao foi possivel carregar" —
# exatamente o sintoma que em 19/09 pareceu bug de tela em homologacao.
# ---------------------------------------------------------------------------
mapfile -t dumps < <(find "$BACKUP_DIR" -maxdepth 1 -name "*-${hoje}-*.dump" -type f | sort)
if (( ${#dumps[@]} == 0 )); then
  log "nenhum dump de hoje ($hoje) em $BACKUP_DIR — o backup local rodou?"
  exit 1
fi
log "${#dumps[@]} dump(s) de hoje: $(printf '%s ' "${dumps[@]##*/}")"

midia="$trabalho/media-${hoje}.tar.gz"
# `:ro` no volume de producao e o padrao do projeto: um backup jamais escreve
# no dado que esta copiando. O tar sai pelo stdout do container para o host,
# em `.partial`, e so vira o nome final se o tar retornar 0 — mesma disciplina
# de escrita atomica do `backup-postgres.sh`.
if (( DRYRUN )); then
  log "[dry-run] pularia: docker run --rm -v ${MEDIA_VOLUME}:/m:ro alpine tar czf - -C /m ."
  tar czf "${midia}.partial" -C "$trabalho" . 2>/dev/null || true
  mv "${midia}.partial" "$midia"
else
  docker run --rm -v "${MEDIA_VOLUME}:/m:ro" alpine \
    tar czf - -C /m . > "${midia}.partial"
  mv "${midia}.partial" "$midia"
fi
log "midia empacotada: $(basename "$midia") ($(du -h "$midia" | cut -f1))"

# ---------------------------------------------------------------------------
# 3. Cifrar TUDO antes de qualquer byte sair da VPS
# ---------------------------------------------------------------------------
cifrar() {
  local origem="$1" destino="$2"
  case "$METODO" in
    age)
      age -r "$BACKUP_AGE_RECIPIENT" -o "${destino}.partial" "$origem"
      ;;
    gpg)
      # --batch/--yes: sem TTY no systemd. `--passphrase-fd 0` em vez de
      # `--passphrase`: argumento de linha de comando aparece em `ps`.
      printf '%s' "$BACKUP_GPG_PASSPHRASE" | gpg --batch --yes --quiet \
        --passphrase-fd 0 --pinentry-mode loopback \
        --symmetric --cipher-algo AES256 \
        --output "${destino}.partial" "$origem"
      ;;
  esac
  mv "${destino}.partial" "$destino"
}

assets=()
for origem in "${dumps[@]}" "$midia"; do
  destino="$trabalho/$(basename "$origem").${EXT}"
  cifrar "$origem" "$destino"
  assets+=("$destino")
done
log "${#assets[@]} arquivo(s) cifrado(s) com $METODO"

# ---------------------------------------------------------------------------
# 4. Publicar a release do dia
#
# `create` falha se a tag ja existe (rodou duas vezes no mesmo dia, ou
# reexecucao manual apos falha parcial). Nesse caso so re-sobe os assets com
# `--clobber`, que e o comportamento idempotente que queremos.
# ---------------------------------------------------------------------------
gh_() { if (( DRYRUN )); then log "[dry-run] gh $*"; else gh "$@"; fi; }

if (( DRYRUN )) || ! gh release view "$tag" --repo "$BACKUP_OFFSITE_REPO" >/dev/null 2>&1; then
  gh_ release create "$tag" --repo "$BACKUP_OFFSITE_REPO" \
    --title "Backup $hoje" \
    --notes "Backup automatico do CRM Lab em $hoje. Conteudo CIFRADO ($METODO). Restore: docs/guides/DEPLOYMENT.md" \
    || log "release $tag ja existia; seguindo para o upload"
fi
gh_ release upload "$tag" "${assets[@]}" --repo "$BACKUP_OFFSITE_REPO" --clobber
log "release $tag publicada em $BACKUP_OFFSITE_REPO"

# ---------------------------------------------------------------------------
# 5. Conferir que os assets chegaram — nao confiar no rc do upload
#
# Upload que devolve 0 com asset de 0 byte ja aconteceu com a API do GitHub.
# A conferencia e contar os assets da release recem-publicada.
# ---------------------------------------------------------------------------
if ! (( DRYRUN )); then
  publicados="$(gh release view "$tag" --repo "$BACKUP_OFFSITE_REPO" \
    --json assets --jq '[.assets[] | select(.size > 0)] | length')"
  if (( publicados < ${#assets[@]} )); then
    log "FALHOU conferencia: esperava ${#assets[@]} assets nao-vazios, a release tem $publicados"
    exit 1
  fi
  log "conferido: $publicados asset(s) nao-vazios na release"
fi

# ---------------------------------------------------------------------------
# 6. Retencao remota — 30 dias, independente dos 14 locais
#
# Remoto guarda mais tempo de proposito: o cenario que justifica o offsite e
# "perdi a VPS", e nesse cenario ninguem descobre o problema no mesmo dia.
#
# Igual ao local: a retencao so roda depois que o envio de hoje deu certo.
# Apagar release velha logo depois de falhar em subir a nova e a melhor forma
# de ficar sem nenhuma. Como este bloco esta depois de toda a verificacao e o
# script e `set -e`, isso e garantido pela ordem.
# ---------------------------------------------------------------------------
limite="$(date -d "-${RETENCAO_REMOTA} days" +%F)"
if (( DRYRUN )); then
  log "[dry-run] apagaria releases 'backup-*' anteriores a $limite"
else
  # Ordena lexicograficamente: com `backup-YYYY-MM-DD`, a comparacao de string
  # e a comparacao de data. `--limit 200` cobre com folga 30 dias de retencao.
  while read -r velha; do
    [[ -n "$velha" ]] || continue
    gh release delete "$velha" --repo "$BACKUP_OFFSITE_REPO" --yes --cleanup-tag \
      && log "expirada $velha" \
      || log "AVISO: nao consegui apagar $velha (o backup de hoje esta salvo)"
  done < <(gh release list --repo "$BACKUP_OFFSITE_REPO" --limit 200 \
             --json tagName --jq ".[].tagName | select(startswith(\"backup-\")) | select(. < \"backup-${limite}\")")
fi

log "concluido"
