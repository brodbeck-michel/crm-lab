#!/usr/bin/env bash
#
# Simula o webhook do gateway Evolution em HOMOLOGACAO — imagem, PDF, audio,
# video, os descartes e o arquivo grande demais — SEM parear numero nenhum.
#
# ---------------------------------------------------------------------------
# Por que isto funciona sem WhatsApp
# ---------------------------------------------------------------------------
# A midia do Evolution vem em BASE64 dentro do proprio corpo do webhook
# (`base64: true`, ver `backend/src/lib/evolution-client.ts`). O backend NAO
# baixa nada do gateway. Entao um POST com o payload certo reproduz o caminho
# INTEIRO de recebimento: parser -> `MediaService.storeInbound` -> mensagem ->
# `attachmentUrl: /api/v1/media/<id>` -> tela do atendente.
#
# O que ele NAO prova: que o gateway v2.3.7 poe o base64 exatamente onde este
# parser procura. Essa verificacao (spec Onda 8 §7.4) continua exigindo um
# numero real — o comentario de `webhook.routes.ts` diz que o campo nunca foi
# conferido contra um payload de verdade. Por isso existem DOIS casos de
# imagem: `imagem` (base64 dentro do submessage) e `imagem-base64-no-topo`
# (base64 no nivel do `message`) — as duas posicoes que o parser tolera.
#
# ---------------------------------------------------------------------------
# Por que o POST vai direto no backend, e nao na porta do host
# ---------------------------------------------------------------------------
# `EVOLUTION_WEBHOOK_BASE_URL=http://backend:3000`: o gateway roda na rede
# interna do compose e posta DIRETO no backend, sem passar pelo nginx do
# frontend. Simular pela porta publica passaria por um proxy que o gateway
# nunca atravessa — e mudaria o resultado do caso `grande` (o nginx tem
# `client_max_body_size` default de 1 MiB e cortaria antes com 413).
#
# ---------------------------------------------------------------------------
# Por que a conferencia e no banco, e nao na resposta HTTP
# ---------------------------------------------------------------------------
# O webhook responde SEMPRE `200 {"received: true"}`, de proposito: token
# errado, tenant desconhecido e payload lixo respondem igual, para a rota nao
# virar oraculo de enumeracao (SECURITY.md). Logo, "deu 200" nao significa
# nada. Cada caso aqui grava um `external_message_id` unico e depois PROCURA
# essa linha no banco — e isso que distingue funcionou de sumiu em silencio.
#
# Uso (na VPS):
#   ./simula-webhook-evolution.sh                 # todos os casos
#   ./simula-webhook-evolution.sh imagem pdf      # so os escolhidos
#   ./simula-webhook-evolution.sh --listar
#   ./simula-webhook-evolution.sh --limpar        # apaga o que a simulacao criou
#
set -Eeuo pipefail

PROJECT_DIR="${CRM_HML_DIR:-/opt/crm-lab-homolog}"
PROJETO_HML='crm-lab-homolog'

# Telefone dedicado a simulacao: nao existe, nao colide com paciente vindo do
# dump de producao e e o que o `--limpar` usa para achar o que apagar.
TELEFONE_SIMULADO="${TELEFONE_SIMULADO:-5548900000001}"
NOME_SIMULADO='Paciente Simulado (hml)'

msg()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    \033[1;32mOK\033[0m   %s\n' "$*"; }
falha(){ printf '    \033[1;31mFALHA\033[0m %s\n' "$*"; FALHAS=$((FALHAS + 1)); }
erro() { printf '\n\033[1;31mABORTADO: %s\033[0m\n\n' "$*" >&2; exit 1; }

FALHAS=0

# ---------------------------------------------------------------------------
# 1. Provar que o alvo e homologacao
#
# Mesma disciplina de `homolog-sincroniza-dados.sh`: este script ESCREVE
# mensagem de paciente no banco. Apontado para producao, sujaria a caixa de
# entrada real do laboratorio com paciente fantasma.
# ---------------------------------------------------------------------------
[[ -f "$PROJECT_DIR/.env" ]] || erro "nao achei $PROJECT_DIR/.env"
set -a
# shellcheck disable=SC1090,SC1091
. "$PROJECT_DIR/.env"
set +a

[[ "${APP_ENV:-}" == 'homologacao' ]] \
  || erro "APP_ENV='${APP_ENV:-vazio}' — este script SO roda em homologacao."
[[ "${COMPOSE_PROJECT_NAME:-}" == "$PROJETO_HML" ]] \
  || erro "COMPOSE_PROJECT_NAME='${COMPOSE_PROJECT_NAME:-vazio}' != $PROJETO_HML (.env de producao?)"
: "${POSTGRES_USER:?POSTGRES_USER nao definido}"
: "${POSTGRES_DB:?POSTGRES_DB nao definido}"

container_de() {
  docker ps -q \
    --filter "label=com.docker.compose.project=$PROJETO_HML" \
    --filter "label=com.docker.compose.service=$1" | head -1
}

PG="$(container_de postgres)"
BACKEND="$(container_de backend)"
[[ -n "$PG" ]]      || erro "postgres de homologacao nao esta rodando"
[[ -n "$BACKEND" ]] || erro "backend de homologacao nao esta rodando"

projeto_do_alvo="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$PG")"
[[ "$projeto_do_alvo" == "$PROJETO_HML" ]] \
  || erro "container alvo pertence ao projeto '$projeto_do_alvo'"

psql_q() { docker exec -i "$PG" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"; }

# ---------------------------------------------------------------------------
# 2. Pre-condicoes que o webhook exige (authenticateEvolution)
#
# Em ordem: tenant resolvido, canal ativo, token valido. As tres recusam com
# o MESMO 200 — sem conferir aqui, uma falha de configuracao vira "sumiu".
# ---------------------------------------------------------------------------
TENANT_ID="$(psql_q "SELECT id FROM tenants WHERE is_active AND deleted_at IS NULL ORDER BY created_at LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || erro "nenhum tenant ativo no banco de homologacao"

CANAL_ATIVO="$(psql_q "SELECT is_active FROM tenant_channels WHERE tenant_id = '$TENANT_ID' AND channel = 'whatsapp';")"
if [[ "$CANAL_ATIVO" != 't' ]]; then
  erro "canal whatsapp do tenant $TENANT_ID esta inativo — o webhook recusa com
  'evolution.webhook_channel_disabled' e responde 200 do mesmo jeito. Ative com:

    docker exec -i $PG psql -U $POSTGRES_USER -d $POSTGRES_DB -c \\
      \"UPDATE tenant_channels SET is_active = TRUE WHERE tenant_id = '$TENANT_ID' AND channel = 'whatsapp';\"

  (seguro em hml: com EVOLUTION_API_KEY vazia nada consegue SAIR — o driver
  recusa o envio antes de qualquer chamada de rede.)"
fi

[[ -n "${EVOLUTION_WEBHOOK_TOKEN:-}" ]] \
  || erro "EVOLUTION_WEBHOOK_TOKEN vazio em $PROJECT_DIR/.env — 'evolutionTokenValid'
  retorna false direto quando o token esperado e vazio, e TODO webhook e recusado.
  Gere um (openssl rand -hex 32), ponha no .env e recrie o backend:
    docker compose -p $PROJETO_HML -f docker-compose.prod.yml up -d backend"

# O nome da instancia e conferido contra `evolutionInstanceName(tenantId)`
# (`lib/evolution-client.ts`): guarda deliberada contra troca de slug. Payload
# com `instance` errado e recusado ANTES de qualquer escrita, mesmo com token
# valido — entao a simulacao precisa mandar o valor certo.
INSTANCIA="tenant-${TENANT_ID}"

# ---------------------------------------------------------------------------
# 3. Casos
#
# `nome|mime|arquivo|legenda|posicao_do_base64|gerador|esperado`
#   posicao: `submessage` (o que a doc do gateway indica) ou `topo`
#   esperado: `mensagem:<message_type>` ou `descarte:<reason>`
# ---------------------------------------------------------------------------
CASOS=(
  'texto|||Bom dia, chegou meu resultado?|-|texto|mensagem:text'
  'imagem|image/png|pedido-medico.png|Foto do pedido do convenio|submessage|png|mensagem:image'
  'imagem-sem-legenda|image/png|exame.png||submessage|png|mensagem:image'
  'imagem-base64-no-topo|image/png|pedido-medico.png|Mesma imagem, base64 no nivel do message|topo|png|mensagem:image'
  'pdf|application/pdf|guia-tiss.pdf|Guia em PDF|submessage|pdf|mensagem:pdf'
  'audio|audio/wav|recado.wav||submessage|wav|mensagem:audio'
  'video|video/mp4|video-do-paciente.mp4|Video curto|submessage|falso|mensagem:doc'
  'grande|image/png|foto-enorme.png|Acima do teto de 15 MiB|submessage|grande|descarte:midia_recusada'
  'grupo|||Mensagem de grupo|-|grupo|descarte:grupo'
  'from-me|||Resposta pelo celular do laboratorio|-|from_me|descarte:from_me'
)

listar() {
  printf '\n%-24s %s\n' 'CASO' 'O QUE EXERCITA'
  printf '%-24s %s\n' '------------------------' '------------------------------------------------'
  printf '%-24s %s\n' 'texto'                 'caminho base: auth + parser, sem midia'
  printf '%-24s %s\n' 'imagem'                'PNG real com legenda, base64 dentro do submessage'
  printf '%-24s %s\n' 'imagem-sem-legenda'    'sem caption: conteudo cai no fallback do parser'
  printf '%-24s %s\n' 'imagem-base64-no-topo' 'a SEGUNDA posicao de base64 que o parser tolera'
  printf '%-24s %s\n' 'pdf'                   'PDF valido de 1 pagina -> message_type "pdf"'
  printf '%-24s %s\n' 'audio'                 'WAV audivel de 2s -> message_type "audio"'
  printf '%-24s %s\n' 'video'                 'video/mp4 -> vira "doc" (nao ha tipo video)'
  printf '%-24s %s\n' 'grande'                '16 MiB: recusa com log, mensagem NAO criada'
  printf '%-24s %s\n' 'grupo'                 '@g.us -> descarte correto, com rastro no log'
  printf '%-24s %s\n' 'from-me'               'fromMe:true -> descarte correto, com rastro no log'
  printf '\n'
}

# ---------------------------------------------------------------------------
# 4. Gerador do payload
#
# Python3 (o mesmo que `deploy.sh` ja exige) porque montar JSON com base64 de
# 21 MB em bash e receita de citacao quebrada. Os arquivos sao gerados de
# verdade — PNG e WAV validos, para dar para VER e OUVIR na tela em vez de
# so conferir uma linha no banco.
# ---------------------------------------------------------------------------
payload_de() {
  local mime="$1" arquivo="$2" legenda="$3" posicao="$4" gerador="$5" externo="$6"
  MIME="$mime" ARQUIVO="$arquivo" LEGENDA="$legenda" POSICAO="$posicao" \
  GERADOR="$gerador" EXTERNO="$externo" INSTANCIA="$INSTANCIA" \
  TELEFONE="$TELEFONE_SIMULADO" NOME="$NOME_SIMULADO" \
  python3 - <<'PY'
import base64, json, os, struct, zlib

mime     = os.environ['MIME']
arquivo  = os.environ['ARQUIVO']
legenda  = os.environ['LEGENDA']
posicao  = os.environ['POSICAO']
gerador  = os.environ['GERADOR']
externo  = os.environ['EXTERNO']

def png(largura=640, altura=400):
    """PNG valido, em gradiente — so zlib e struct, sem Pillow."""
    linhas = b''
    for y in range(altura):
        linhas += b'\x00'  # filtro None
        for x in range(largura):
            linhas += bytes((x * 255 // largura, y * 255 // altura, 160))
    def bloco(tipo, dados):
        return (struct.pack('>I', len(dados)) + tipo + dados
                + struct.pack('>I', zlib.crc32(tipo + dados) & 0xFFFFFFFF))
    return (b'\x89PNG\r\n\x1a\n'
            + bloco(b'IHDR', struct.pack('>IIBBBBB', largura, altura, 8, 2, 0, 0, 0))
            + bloco(b'IDAT', zlib.compress(linhas, 6))
            + bloco(b'IEND', b''))

def pdf():
    """PDF de 1 pagina com texto — montado a mao, com a xref correta."""
    texto = b'BT /F1 18 Tf 60 700 Td (Guia TISS - simulacao de homologacao) Tj ET'
    objetos = [
        b'<< /Type /Catalog /Pages 2 0 R >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
        b'/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        b'<< /Length ' + str(len(texto)).encode() + b' >>\nstream\n' + texto + b'\nendstream',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    saida, deslocamentos = b'%PDF-1.4\n', []
    for i, obj in enumerate(objetos, start=1):
        deslocamentos.append(len(saida))
        saida += b'%d 0 obj\n' % i + obj + b'\nendobj\n'
    inicio_xref = len(saida)
    saida += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objetos) + 1)
    for d in deslocamentos:
        saida += b'%010d 00000 n \n' % d
    saida += (b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
              % (len(objetos) + 1, inicio_xref))
    return saida

def wav(segundos=2, taxa=8000):
    """WAV de 440 Hz — onda quadrada, para nao depender do modulo math."""
    amostras, periodo = bytearray(), taxa // 440
    for n in range(taxa * segundos):
        amostras.append(200 if (n % periodo) < periodo // 2 else 56)
    dados = bytes(amostras)
    return (b'RIFF' + struct.pack('<I', 36 + len(dados)) + b'WAVEfmt '
            + struct.pack('<IHHIIHH', 16, 1, 1, taxa, taxa, 1, 8)
            + b'data' + struct.pack('<I', len(dados)) + dados)

GERADORES = {
    'png':    png,
    'pdf':    pdf,
    'wav':    wav,
    # Conteudo irrelevante: o backend nunca abre o arquivo, so olha o mimetype.
    'falso':  lambda: b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 2048,
    # 16 MiB > MAX_MEDIA_BYTES (15 MiB). Incompressivel de proposito: zeros
    # atravessariam gzip e nao provariam o teto.
    'grande': lambda: os.urandom(16 * 1024 * 1024),
}

# --- envelope comum ------------------------------------------------------
remote_jid = os.environ['TELEFONE'] + '@s.whatsapp.net'
from_me = False
if gerador == 'grupo':
    remote_jid = '120363000000000000@g.us'
elif gerador == 'from_me':
    from_me = True

chave = {'remoteJid': remote_jid, 'fromMe': from_me, 'id': externo}
mensagem = {}

if gerador in GERADORES:
    bruto = GERADORES[gerador]()
    b64 = base64.b64encode(bruto).decode()
    submensagem = {'mimetype': mime, 'fileName': arquivo}
    if legenda:
        submensagem['caption'] = legenda
    if posicao == 'topo':
        mensagem['base64'] = b64          # segunda posicao tolerada pelo parser
    else:
        submensagem['base64'] = b64
    chave_midia = ('imageMessage'    if mime.startswith('image/') else
                   'audioMessage'    if mime.startswith('audio/') else
                   'videoMessage'    if mime.startswith('video/') else
                   'documentMessage')
    mensagem[chave_midia] = submensagem
else:
    mensagem['conversation'] = legenda or 'mensagem simulada'

print(json.dumps({
    'event': 'messages.upsert',           # minusculo com ponto: o que o v2.3.7 manda
    'instance': os.environ['INSTANCIA'],
    'data': {
        'key': chave,
        'pushName': os.environ['NOME'],
        # So aparece no log de descarte, mas sem ele o log nao diz QUE TIPO
        # de payload o parser recusou — que e a informacao util.
        'messageType': 'mediaMessage' if gerador in GERADORES else 'conversation',
        'message': mensagem,
    },
}))
PY
}

# ---------------------------------------------------------------------------
# 5. Execucao de um caso
# ---------------------------------------------------------------------------
roda_caso() {
  local linha="$1"
  IFS='|' read -r nome mime arquivo legenda posicao gerador esperado <<<"$linha"

  local externo="simulado-${nome}-$(date +%s)-$RANDOM"
  info "caso '$nome' (externalId $externo)"

  # `--data-binary @-` de dentro do backend: mesma posicao de rede do gateway
  # (rede interna do compose, sem nginx no meio) e sem limite de linha de
  # comando para os 21 MB de base64 do caso `grande`.
  # Marca de tempo ANTES do POST: sem ela, `docker logs` acharia o descarte de
  # uma rodada anterior e o caso passaria sem ter provado nada.
  local desde resposta
  desde="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  resposta="$(payload_de "$mime" "$arquivo" "$legenda" "$posicao" "$gerador" "$externo" \
    | docker exec -i "$BACKEND" curl -s -o /dev/null -w '%{http_code}' \
        -X POST "http://localhost:3000/api/v1/webhooks/evolution/${TENANT_ID}" \
        -H 'Content-Type: application/json' \
        -H "x-evolution-webhook-token: ${EVOLUTION_WEBHOOK_TOKEN}" \
        --data-binary @-)"

  [[ "$resposta" == '200' ]] \
    || { falha "HTTP $resposta (o webhook deveria responder 200 SEMPRE)"; return; }

  # O 200 nao diz nada. A verdade esta no banco.
  local encontrada
  encontrada="$(psql_q "
    SELECT m.message_type || '|' || coalesce(m.attachment_url, '-') || '|' ||
           coalesce(mm.byte_size::text, '-') || '|' || coalesce(mm.file_name, '-')
    FROM messages m
    LEFT JOIN message_media mm ON mm.message_id = m.id
    WHERE m.external_message_id = '$externo';")"

  local tipo_esperado="${esperado#*:}"
  if [[ "$esperado" == mensagem:* ]]; then
    [[ -n "$encontrada" ]] || { falha "nenhuma mensagem gravada — veja 'docker logs $BACKEND | grep inbound_discarded'"; return; }
    IFS='|' read -r tipo url bytes nome_arq <<<"$encontrada"
    [[ "$tipo" == "$tipo_esperado" ]] \
      || { falha "message_type '$tipo', esperado '$tipo_esperado'"; return; }
    if [[ "$gerador" == 'texto' ]]; then
      ok "mensagem de texto gravada"
    else
      [[ "$url" != '-' ]] || { falha "mensagem sem attachment_url"; return; }
      # O arquivo mora em disco (MEDIA_DIR), nao no banco: uma linha em
      # message_media sem arquivo do lado de la e anexo que quebra na tela.
      local id_midia="${url##*/}"
      if docker exec "$BACKEND" test -f "/data/media/$id_midia"; then
        ok "$tipo — $nome_arq, $bytes bytes, arquivo em disco, $url"
      else
        falha "linha em message_media mas /data/media/$id_midia nao existe"
      fi
    fi
  else
    if [[ -n "$encontrada" ]]; then
      falha "mensagem foi gravada, mas o esperado era descarte '$tipo_esperado'"
      return
    fi
    # Descarte esperado: o log e a unica prova de que a mensagem existiu.
    #
    # `grep -c`, nao `grep -q`: com `pipefail` ligado, o `-q` sai no primeiro
    # casamento, o `docker logs` morre de SIGPIPE e o pipeline inteiro devolve
    # 141 — o caso falhava EXATAMENTE quando o log estava certo.
    local achou
    achou="$(docker logs --since "$desde" "$BACKEND" 2>&1 | grep -c "$tipo_esperado" || true)"
    if (( achou > 0 )); then
      ok "descartada como '$tipo_esperado', com rastro no log"
    else
      falha "descartada sem log de '$tipo_esperado' — mensagem sumiu em silencio"
    fi
  fi
}

# ---------------------------------------------------------------------------
# 6. Limpeza
# ---------------------------------------------------------------------------
limpar() {
  msg "Apagando o que a simulacao criou (telefone $TELEFONE_SIMULADO)"
  # ON DELETE CASCADE de conversations -> messages -> message_media faz o
  # resto. Os arquivos em MEDIA_DIR ficam orfaos de proposito: apagar por
  # padrao de nome arriscaria levar junto anexo vindo do dump de producao.
  psql_q "
    DELETE FROM conversations WHERE patient_id IN (
      SELECT id FROM patients WHERE phone = '$TELEFONE_SIMULADO');
    DELETE FROM patients WHERE phone = '$TELEFONE_SIMULADO';" >/dev/null
  info "paciente, conversa e mensagens removidos"
  info "arquivos em /data/media ficaram — hml e descartavel, e apagar por padrao"
  info "de nome poderia levar junto anexo vindo do dump de producao"
}

# ---------------------------------------------------------------------------
# 7. Main
# ---------------------------------------------------------------------------
case "${1:-}" in
  --listar) listar; exit 0 ;;
  --limpar) limpar; exit 0 ;;
esac

escolhidos=("$@")
msg "Simulando webhook do Evolution em homologacao"
info "tenant   $TENANT_ID"
info "instance $INSTANCIA"
info "destino  http://localhost:3000/api/v1/webhooks/evolution/$TENANT_ID (de dentro do backend)"

for caso in "${CASOS[@]}"; do
  nome="${caso%%|*}"
  if (( ${#escolhidos[@]} )); then
    encontrado=0
    for e in "${escolhidos[@]}"; do [[ "$e" == "$nome" ]] && encontrado=1; done
    (( encontrado )) || continue
  fi
  roda_caso "$caso"
done

msg "Resultado"
if (( FALHAS )); then
  info "$FALHAS caso(s) falharam"
  info "logs: docker logs --since 5m $BACKEND | grep -E 'evolution|media'"
  exit 1
fi
info "todos os casos passaram"
info "veja na tela: https://homolog.vitrocrm.cloud — conversa de '$NOME_SIMULADO'"
info "para limpar: $0 --limpar"
