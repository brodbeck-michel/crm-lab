---
name: cloud-api-meta
description: Passo a passo testado para ligar um laboratório do CRM Lab na API oficial do WhatsApp (Cloud API da Meta) — portfólio, verificação da empresa, app, usuário do sistema/token, WABA, modelos, webhook, .env de prod, tela de Canais, testes e go/no-go. Use quando o pedido for configurar/conferir a Cloud API de um laboratório (Santé ou outro), diagnosticar mensagem que não chega/não sai pela Meta, ou preparar/executar a troca do QR para a API oficial.
---

# Cloud API da Meta — configurar um laboratório

Roteiro feito e validado em **12/11/2026** (portfólio do Santé, tenant `teste` em prod). Contrato e
plano da troca: `docs/guides/MIGRACAO_SANTE.md` §4 (4.1 checklist, 4.3.2 resultado, 4.4 dia da
troca). Código: `backend/src/services/whatsapp.service.ts`, `backend/src/controllers/webhook.routes.ts`.

**Regras de conduta**
- Segredo (token, App Secret, verify token) **nunca** no chat nem em comando visível: só arquivo
  `chmod 600` e variável de shell com `unset` no fim. Saídas da API passam por filtro que troca o
  token por `<token>`.
- Produção: o Michel confirma antes de mexer no `.env` ou no banco. Nunca `WHATSAPP_CLOUD_API_MOCK` em
  prod. Nunca clicar nos "Agir" da Central de Segurança que removem usuários.
- Telas da Meta: pedir **print antes de cada "Avançar/Enviar"**; o Michel opera, eu confiro.

## Constantes (Santé)

| | |
|---|---|
| Portfólio | "Laboratório Sante" `1784519782770617` (Michel e Milena com acesso total) |
| App | "CRM Lab - Santé" `40949966027927681` |
| Usuário do sistema | `CRMLabSante` |
| WABA de teste / número de teste | `3732004406965190` / `1508225332363199` (+1 555 151-8021) |
| Slugs em prod | Santé `lab-sante` · teste `teste` |
| Segredos locais | `~/.config/crm-lab-meta-sante/{token,app_secret,verify_token}` |
| Graph | `https://graph.facebook.com/v25.0` |

Para outro laboratório: pasta própria `~/.config/crm-lab-meta-<slug>/` e um app por portfólio.

## Fase 1 — Meta (o Michel na tela, eu guiando)

1. **Informações da empresa** (Configurações › Informações da empresa): razão social, endereço com país
   Brasil, telefone, **site**, CNPJ. Falta de nome legal/país/site = erro **131000**.
2. **Verificação da EMPRESA** — Configurações › **Central de Segurança** › card **"Verificação da
   empresa"** › caso de uso "O app exige acesso a permissões no Meta for Developers" › Iniciar.
   Respostas que funcionaram: tipo **Empresa privada** (Ltda); CNPJ só dígitos; nome alternativo = nome
   fantasia; escolher no registro público a entrada **com telefones e site**; confirmar por **e-mail
   @domínio do site** (recomendado). Leva ~2 dias úteis.
   - ⚠️ "Verificação bem-sucedida" em *Autorizações e verificações › verificação individual ou de
     organização* é a de **anunciante** — não serve. A fonte da verdade é a API (Fase 5).
3. **App**: developers.facebook.com › Criar app › caso de uso **"Conectar-se com clientes pelo
   WhatsApp"** › portfólio **do laboratório** (conferir!) › Criar. Não precisa publicar nem virar Tech
   Provider. Em Personalizar › **Etapa 1. Experimente**: a Meta cria a WABA de teste e o número de teste;
   cadastrar o celular de quem vai testar como destinatário. **Nunca** adicionar o número real antes
   do dia da troca (Etapa 2 / "adicionar número" tira o número do celular).
4. **Usuário do sistema**: business.facebook.com/settings/system-users › Adicionar › nome **sem hífen**
   (ex.: `CRMLabSante`) › Admin › **Atribuir ativos** na mesma janela: Apps › o app (acesso total) +
   Contas do WhatsApp › a WABA (Tudo) + Contas de mensagens › Contas vinculadas (total) › Atribuir.
   **Gerar token**: o app · validade **Nunca** · só `whatsapp_business_messaging` e
   `whatsapp_business_management`.
5. **Guardar o token** (pelo `!` do Claude Code `read -rsp` NÃO funciona). O Michel copia o valor e roda
   (digitando o comando, ou copiando o valor de novo antes do Enter):
   ```
   ! mkdir -p ~/.config/crm-lab-meta-sante && chmod 700 ~/.config/crm-lab-meta-sante && powershell.exe -NoProfile -Command Get-Clipboard | tr -d '\r\n ' > ~/.config/crm-lab-meta-sante/token && chmod 600 ~/.config/crm-lab-meta-sante/token && wc -c < ~/.config/crm-lab-meta-sante/token
   ```
   Conferir formato sem exibir: `python3 -c` com `len` e `isalnum()` (token válido ~180–200 chars
   alfanuméricos). Mesmo comando para `app_secret` (Configurações do app › Básico › Chave secreta;
   32 hex). Verify token eu gero: `python3 -c 'import secrets;print(secrets.token_hex(24),end="")'`.
6. **Pagamento** (Billing Hub › conta de mensagens): moeda **BRL** (irreversível), CNPJ, fins comerciais
   = Sim, cartão **do laboratório** (a gestora cadastra). Sem ele: **141006**. A WABA de teste vem com
   pagamento "Índia" — não pôr cartão nela.
7. **Modelos** (Gerenciador do WhatsApp › Modelos › Criar): aba **Utilidade** › Padrão › nome exato ·
   Português (BR) · tipo de variável **Número** · só **Corpo** · amostras · validade padrão. Textos em
   MIGRACAO_SANTE 4.1.1. **Modelo é da WABA**: trocou de WABA, recria.

## Fase 2 — ligar app ⇄ WABA ⇄ CRM pela API (eu faço)

```bash
cd ~/.config/crm-lab-meta-sante; T=$(cat token); APP=40949966027927681; W=<waba_id>; API=https://graph.facebook.com/v25.0
# quem é o token / o número enxerga
curl -sS -H "Authorization: Bearer $T" "$API/me?fields=id,name"
curl -sS -H "Authorization: Bearer $T" "$API/$W/phone_numbers?fields=id,display_phone_number,verified_name"
# inscrever o app na WABA (sem isso nada chega ao CRM)
curl -sS -X POST -H "Authorization: Bearer $T" "$API/$W/subscribed_apps"
# webhook do app (equivale ao "Verificar e salvar"; a Meta faz o GET e exige 200)
S=$(cat app_secret); V=$(cat verify_token)
curl -sS -X POST "$API/$APP/subscriptions" --data-urlencode object=whatsapp_business_account \
  --data-urlencode "callback_url=https://vitrocrm.cloud/api/v1/webhooks/whatsapp/<slug>" \
  --data-urlencode "verify_token=$V" --data-urlencode fields=messages --data-urlencode "access_token=$APP|$S"
unset T S V
```
`debug_token` com o próprio token de usuário do sistema dá "Invalid application ID" — usar `/me`.
Um callback por app: trocar de laboratório = repetir o `subscriptions` com o outro slug (ou callback
por WABA, DEPLOYMENT "mais de um laboratório").

## Fase 3 — servidor de prod (com OK do Michel)

- O que muda: `WHATSAPP_API_URL=https://graph.facebook.com/v25.0`, `WHATSAPP_WEBHOOK_SECRET=<App Secret>`,
  `WHATSAPP_WEBHOOK_VERIFY_TOKEN=<gerado>`. Não afeta laboratório em `qr` (Evolution tem token e driver
  próprios; credenciais da Meta são por laboratório). **Em 12/11/2026 isso já foi aplicado em prod.**
- Aplicar: backup do `.env` em `/home/deploy/crm-lab-env-backups/`, editar por script lendo os valores
  do stdin (`ssh crm-vps` + `python3`, nunca na linha de comando), `chmod 600`. Subir pelo
  `./scripts/deploy.sh` quando `origin/main` estiver numa tag; se não estiver, recriar só o backend com a
  imagem que já roda: `IMAGE_TAG=<sha em execução> docker compose -p crm-lab-prod -f docker-compose.prod.yml up -d --no-deps backend`
  + `restart frontend` (o `IMAGE_TAG` do `.env` de prod é velho — pegar do `docker ps`).
- Conferir: `docker exec crm-lab-prod-backend-1 sh -c 'test -n "$WHATSAPP_WEBHOOK_VERIFY_TOKEN" && echo ok; echo $WHATSAPP_API_URL'`,
  `ffmpeg -version`, site 200, log `evolution.webhook_sync` (QR seguiu de pé).

## Fase 4 — tela do CRM (o Michel, como admin do laboratório)

Configurações › **Canais & Equipe** › WhatsApp. São **dois blocos que salvam separado**:
1. **Conexão de canal**: Canal **ativo**, nome exibido, número, "ID do número no provedor", token
   (`! clip.exe < ~/.config/crm-lab-meta-sante/token` e Ctrl+V), **Segredo do webhook em branco**
   ("Não configurado" = usa o App Secret do servidor) › **Salvar** (não o "Salvar WABA").
2. **Modo do WhatsApp**: API oficial › phone_number_id, waba_id, token › marcar "Entendi" › **Trocar
   para API oficial**.

Conferir no banco (sem token):
```sql
select t.slug, c.connection_mode, c.is_active, c.display_name, c.phone_number, c.phone_number_id, c.waba_id,
       (c.cloud_api_token <> '') tem_token, c.webhook_secret is null segredo_nao_config, c.cloud_api_since
from tenants t join tenant_channels c on c.tenant_id=t.id and c.channel='whatsapp' order by 1;
```
(via `ssh crm-vps 'docker exec -i crm-lab-prod-postgres-1 sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB"' < arquivo.sql`)

Simular a verificação da Meta antes de cadastrar o callback:
`curl -s -o /dev/null -w "%{http_code}" "https://vitrocrm.cloud/api/v1/webhooks/whatsapp/<slug>?hub.mode=subscribe&hub.verify_token=$V&hub.challenge=1"` → 200.
403 = verify token errado; canal inativo ou slug errado também recusam.

## Fase 5 — testes e go/no-go

Roteiro com um celular cadastrado: "oi" → CRM (mesma conversa de antes) · resposta → tiques até lido ·
foto/PDF/áudio nos dois sentidos · CSV recusado · modelo pelo "Enviar modelo" · painel "Uso e custo".

Acompanhar:
```bash
ssh crm-vps 'docker logs --since 10m crm-lab-prod-backend-1 2>&1 | grep -oE "\"msg\":\"whatsapp[^\"]+\"" | sort | uniq -c'
```
Esperado `whatsapp.webhook_processed` (e `status_ignored` ocasional = status atrasado, normal). Alarme:
`webhook_invalid_signature`, `webhook_unknown_tenant`, `webhook_no_phone_number`,
`webhook_phone_number_mismatch`, `inbound_media_fallback`, `send_failed`, `media_upload_refused`.

Mensagem do atendente sem `external_message_id` e status `sent` = **não saiu**: conferir
`conversations.channel` (conversa `direct` não envia — CRMLAB-148).

Status da conta (go/no-go, véspera e dia):
```bash
curl -sS -H "Authorization: Bearer $T" "$API/$W?fields=name,business_verification_status,health_status"
curl -sS -H "Authorization: Bearer $T" "$API/$W/message_templates?fields=name,status,category"
```
Tudo `AVAILABLE` + `verified` = pode virar. `141010` = empresa não verificada · `141006` = sem
pagamento · `131000` = perfil incompleto · `131031` = conta bloqueada para envio.

## Diagnóstico rápido de mídia

Áudio que chega e não toca no iPhone: inspecionar o OGG (`ffprobe` no container, arquivos em
`/data/media/<uuid>`) e testar variantes **direto pela API** (upload `POST /{phone_number_id}/media`,
envio `type: audio` com `{"id": ..., "voice": true}`) antes de mexer no código. Em 12/11 só tocou com
`-page_duration 20000` (1 pacote Opus por página) — CRMLAB-147.

## Dia da troca do Santé (resumo — o detalhe é a 4.4)

Pré: 4.1 toda ✅, CRMLAB-147 em prod, verificação `verified`, WABA de produção com pagamento BRL e os 3
modelos aprovados. Ordem: callback → `/lab-sante` · go/no-go · número real no Gerenciador (nome de
exibição) · gravar `phone_number_id`/WABA/token no Santé **sem** trocar modo · apagar conta do celular
(migração completa) · registrar com PIN · Desconectar QR · **Trocar para API oficial por último** · teste
com celular da equipe · logs 15 min.
