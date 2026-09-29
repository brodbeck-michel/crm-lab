# Diário — CRMLAB-69 [D] Anexos com prévia, legenda, vários arquivos, Ctrl+V e arrastar

Worktree `../CRM Lab-69` · branch `feature/CRMLAB-69-anexos-previa` (de `integ/epic-65`).
Faixas: decisões D-231…D-233 · migração 044 (não vai ser usada — sem mudança de banco).

## ▶️ Retomado em 2026-09-29 (merge de `origin/integ/epic-65` feito: conflito só em COMPONENTS.md, linha do Composer unindo `→ void | Promise` do 63 e `onPickFiles/onAttachClick`)

### Pronto (etapa 1 — docs, Regra Zero)
- [x] Leitura: CLAUDE.md, AGENTS.md, plano do épico, card no Jira, diários 66/71, D-169/181/182,
      D-220..D-223, D-237..D-239, CRMLAB-31 (allow-list, 15 MiB).
- [x] `docs/DECISIONS.md`: D-231 (caption; áudio descarta legenda; `content` = legenda; vídeo sai
      `mediatype: 'video'` sem mudar `MessageType`), D-232 (prévia: entradas, validação no cliente,
      cobre lista+composer sem desmontar, object URL, Esc), D-233 (envio sequencial, erro por
      arquivo, prévia fecha ao enviar, **só o 1º arquivo cita**, destino lido no clique).
- [x] `API_CONTRACTS.md` §2 attachments (`caption` 0..1024, vídeo), `COMPONENTS.md` (Composer
      `onPickFiles`/`onAttachClick`, `AttachmentPreview` novo), `PAGES.md` §2 (anexos com prévia).

### Etapas 2–3 (shared + backend) prontas; specs attachments/evolution-client/webhook-media/reactions-quotes verdes. `MAX_CAPTION_LENGTH = 1024` também em shared.

### Falta (checklist)
- [x] shared: `CreateAttachmentRequest.caption?: string | null`; mover `MAX_MEDIA_BYTES`
      (15 MiB) para `shared/types/media.types.ts` e o `backend/src/services/media.service.ts`
      reexportar (`attachments.spec.ts` e `evolution-webhook-media.spec.ts` importam de lá).
- [x] backend: zod `caption: z.string().trim().max(1024).nullish()` em `createAttachmentSchema`
      (`conversation.routes.ts`) e repassar em `createAttachment`; `OutboundAttachmentInput.caption`
      + `content = caption || fileName` (áudio: ignora) em `message.service.ts`
      `createAttachmentFromAgent`; `OutboundMedia.caption` em `whatsapp.service.ts` (Evolution
      driver repassa; mock grava); `EvolutionMediaPayload.caption` + `evolutionMediaType` com
      `video/*` → `'video'` e `caption` no corpo do `sendMedia` (não no `sendWhatsAppAudio`).
- [x] testes backend (+ `reactions-quotes.spec` legenda chega ao driver mock): `tests/conversations/attachments.spec.ts` (legenda em content, áudio sem
      legenda, >1024 = 400) e `evolution-client.spec` (caption no corpo; vídeo `video`; áudio sem caption).
- [ ] frontend: `components/conversation/attachment-draft.ts` (`createAttachmentDraft`,
      `validateAttachment`, `formatBytes`, `DOCUMENT_ACCEPT`), `AttachmentPreview.tsx`
      (hook `useObjectUrl(file)` que revoga no cleanup), Composer (menu do clipe com 2 inputs
      `multiple`, `onPaste` com arquivos), ConversationPanel (estado da prévia por conversa,
      overlay sobre lista+composer, drag enter/over/leave/drop com contador e "Solte o arquivo
      aqui", `onSendAttachments(items, quotedId)`), `pages/Attendance/index.tsx`
      (`handleSendAttachments` sequencial, toast por arquivo, cita só o 1º; tirar o `<input>`
      escondido e o `pendingQuoteRef`).
- [ ] testes frontend: Composer (menu, paste imagem × texto), AttachmentPreview (3 miniaturas,
      remover, legenda, ×, inválido, revoke), ConversationPanel (drop, Esc, citação só no 1º),
      Attendance (sequência na ordem, erro de um não para os outros). Ajustar
      `ConversationPanel.reply.spec.tsx` ("anexo com resposta leva o quotedMessageId"),
      `ConversationPanel.spec.tsx`/`ConversationReading.spec.tsx` (prop `onAttach` → nova),
      `Composer.spec.tsx` (botão Anexar com `onPickFiles`).
- [ ] typecheck back/front/shared (`*.wt.json`) e specs afetados, com flock e `--maxWorkers=3`.

## Decisões escritas
D-231, D-232, D-233.

## Próximo passo exato
Frontend: `attachment-draft.ts` → `AttachmentPreview.tsx` → Composer → ConversationPanel → Attendance.
Notas: não existe status "enviando" (relógio) — a mensagem aparece pelo WS quando o servidor grava;
o ícone de relógio é do CRMLAB-67 [B] (registrado em D-233 item 3).
