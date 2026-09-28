# CRMLAB-72 [G] — Aviso de mensagem nova (diário do card)

Branch `feature/CRMLAB-72-aviso-mensagem-nova` · worktree `../CRM Lab-72` · faixa D-240…D-241 · sem migração.

## Estado: 🔄 código escrito (typecheck verde), testes em andamento

## Feito
- [x] Leitura de CLAUDE.md, AGENTS.md, plano do épico e card no Jira.
- [x] Docs (Regra Zero): D-240 (notificação sem prévia) e D-241 (quem é avisado, onde vive,
      contador, som, preferências) em `docs/DECISIONS.md`; PAGES.md §2 "Aviso de mensagem nova";
      COMPONENTS.md (Sidebar menu, InboxLayout `listBanner`, AppShell, EnableNotificationsBanner,
      useNewMessageAlerts).

## Falta
- [x] `stores/message-alerts.store.ts` (preferências + conversa aberta)
- [x] `lib/notification-sound.ts` (tom WebAudio)
- [x] `hooks/useNewMessageAlerts.ts` + montar no `AppShell`
- [x] `EnableNotificationsBanner` + `InboxLayout.listBanner` + Attendance publica conversa aberta
      e relê `?conversationId=` a cada navegação
- [x] Toggles no menu do usuário (Sidebar)
- [ ] Specs: hook (quem é avisado, foco, conversa aberta, permissão negada, body sem conteúdo,
      título) + banner + Sidebar toggles
- [ ] Typecheck + specs afetados verdes

## Decisões escritas
- D-240, D-241 (ver DECISIONS.md, seção "2026-09-28 — Aviso de mensagem nova").

## Notas técnicas
- Payload WS `conversation.new_message` = `{ conversationId, messageId }` só; sinal de "mensagem
  do paciente" é o `unreadCount` subir (servidor só incrementa em `createFromPatient`).
- CSP `nginx/security-headers.conf` (Report-Only) já tem `media-src 'self' blob:`; som é WebAudio,
  não precisa de mudança de infra.

## Próximo passo exato
Escrever `frontend/src/hooks/useNewMessageAlerts.spec.tsx` e specs do banner/Sidebar; rodar typecheck + specs afetados (Attendance, InboxLayout, Sidebar).
