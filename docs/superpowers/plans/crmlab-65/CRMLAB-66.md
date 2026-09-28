# Diário — CRMLAB-66 [A] Responder citando, reagir, menu e apagada/editada

Worktree `../CRM Lab-66` · branch `feature/CRMLAB-66-responder-reagir-apagada` (de `integ/epic-65`).
Faixas: decisões D-220…D-224 · migrações 040, 041.

## Estado: 🔄 backend

## Feito
- Docs (Regra Zero): D-220 (esconder, não apagar), D-221 (citação), D-222 (reação por lado),
  D-223 (eventos do Evolution em constante + reaplicação automática); API_CONTRACTS §2/§2b,
  SCHEMA §4/§33/§34, COMPONENTS (MessageBubble/Composer), FRONTEND_BACKEND (WS
  `conversation.message_updated`), SERVICES §3/§16; tipos em `shared/` (Message com campos
  novos OPCIONAIS no tipo, `QuotedMessageSummary`, `MessageReaction`, `QUICK_REACTIONS`,
  `SetMessageReactionRequest`, `CreateAttachmentRequest.quotedMessageId`).

## Falta
- [x] Migração 040 (colunas em messages + message_reactions + message_edits + RLS). 041 não usada (arquivo único, sem backfill).
- [ ] Backend: evolution-client (constante de eventos, setWebhook, sendReaction, quoted),
      drivers (quoted, sendReaction), message.repository/service, rotas de reação, webhook
      (stanzaId, reactionMessage, protocolMessage REVOKE/EDIT, MESSAGES_EDITED, MESSAGES_DELETE),
      syncEvolutionWebhooks no boot, prévia/timeline escondendo apagada.
- [ ] Frontend: MessageBubble (menu, citação, reações, apagada/editada, data-message-id),
      Composer (faixa "Respondendo a"), ConversationPanel (estado replyTo, scrollToMessage),
      Attendance (envio com quotedMessageId, reação), ws.ts (message_updated).
- [ ] Testes: webhook com payloads reais, reação/citação isolamento, RLS, frontend.
- [ ] Typecheck + specs afetados verdes.

## Decisões escritas
D-220, D-221, D-222, D-223 (D-224 livre).

## Fora de escopo / pendências
- Encaminhar: fora desta história (opcional no card).
- Miniatura real no bloco citado: usa rótulo ("📷 Foto") em vez de buscar a imagem.

## Próximo passo exato
Backend: começar por `lib/evolution-client.ts` (EVOLUTION_WEBHOOK_EVENTS, setWebhook, sendReaction, quoted).
