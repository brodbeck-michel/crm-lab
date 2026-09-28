# Diário — CRMLAB-66 [A] Responder citando, reagir, menu e apagada/editada

Worktree `../CRM Lab-66` · branch `feature/CRMLAB-66-responder-reagir-apagada` (de `integ/epic-65`).
Faixas: decisões D-220…D-224 · migrações 040, 041.

## Estado: 🔄 frontend

## Feito
- Docs (Regra Zero): D-220 (esconder, não apagar), D-221 (citação), D-222 (reação por lado),
  D-223 (eventos do Evolution em constante + reaplicação automática); API_CONTRACTS §2/§2b,
  SCHEMA §4/§33/§34, COMPONENTS (MessageBubble/Composer), FRONTEND_BACKEND (WS
  `conversation.message_updated`), SERVICES §3/§16; tipos em `shared/` (Message com campos
  novos OPCIONAIS no tipo, `QuotedMessageSummary`, `MessageReaction`, `QUICK_REACTIONS`,
  `SetMessageReactionRequest`, `CreateAttachmentRequest.quotedMessageId`).

## Falta
- [x] Migração 040 (colunas em messages + message_reactions + message_edits + RLS). 041 não usada (arquivo único, sem backfill).
- [x] Backend: evolution-client (EVOLUTION_WEBHOOK_EVENTS, setWebhook, sendReaction, quoted),
      drivers (quoted, sendReaction opcional no WhatsAppDriver), message.repository/service
      (findRef, upsert/deleteReaction, markDeleted, applyEdit, setAgentReaction,
      applyInboundReaction, applySenderDelete, applySenderEdit), rotas
      PUT|DELETE /conversations/:id/messages/:messageId/reaction, webhook (stanzaId,
      reactionMessage, protocolMessage REVOKE/EDIT, MESSAGES_EDITED, MESSAGES_DELETE),
      syncEvolutionWebhooks no boot (main.ts), prévia/timeline escondendo apagada.
      Testes de shape atualizados (list/messages/evolution-client).
- [ ] Frontend: MessageBubble (menu, citação, reações, apagada/editada, data-message-id),
      Composer (faixa "Respondendo a"), ConversationPanel (estado replyTo, scrollToMessage),
      Attendance (envio com quotedMessageId, reação), ws.ts (message_updated).
- [x] Testes backend: `tests/webhooks/evolution-crmlab66.spec.ts` (16, payloads Evolution v2:
      contextInfo.stanzaId no topo e no extendedTextMessage, reactionMessage set/troca/remove,
      fromMe, protocolMessage REVOKE, messages.delete, messages.edited REVOKE/MESSAGE_EDIT,
      editedMessage wrapper, cross-tenant, instance errada), `tests/messages/reactions-quotes.spec.ts`
      (12), `tests/db/rls-crmlab66.spec.ts` (8), `tests/whatsapp/evolution-webhook-sync.spec.ts` (4),
      +5 em evolution-client.spec; inventário de rotas 74 → 76.
- [ ] Testes frontend.
- [ ] Typecheck + specs afetados verdes.

## Integração
- 28/09: merge de `origin/integ/epic-65` (CRMLAB-71 e 72 já integrados). Único conflito: fim do
  `DECISIONS.md` — mantidos os dois lados (D-220..D-223 + D-237..D-241). O detalhe da conversa
  agora é `useInfiniteQuery` (`[...queryKeys.conversation(id), 'messages']`, `pages[0]` = mais
  recente) e `GetConversationResponse.cursors` é obrigatório; a lista envolve cada bolha em
  `<div data-anchor-id>` — o `data-message-id` do 66 fica no balão, dentro dela. O 66 só
  INVALIDA por `queryKeys.conversation(id)` (não faz `setQueryData`), então o formato novo não
  exige adaptação no cache.

## Decisões escritas
D-220, D-221, D-222, D-223 (D-224 livre).

## Fora de escopo / pendências
- Encaminhar: fora desta história (opcional no card).
- Miniatura real no bloco citado: usa rótulo ("📷 Foto") em vez de buscar a imagem.

## Próximo passo exato
Frontend: `ws.ts` (conversation.message_updated), `api/conversations.ts` (setReaction/removeReaction, quotedMessageId), MessageBubble (menu/citação/reações/apagada/editada), Composer (faixa replyTo), ConversationPanel + scroll-to-message.ts, Attendance/index.tsx.
