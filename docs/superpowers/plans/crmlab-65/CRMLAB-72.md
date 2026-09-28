# CRMLAB-72 [G] — Aviso de mensagem nova (diário do card)

Branch `feature/CRMLAB-72-aviso-mensagem-nova` · worktree `../CRM Lab-72` · faixa D-240…D-241 · sem migração.

## Estado: ✅ pronto para integração

## Feito
- [x] Leitura de CLAUDE.md, AGENTS.md, plano do épico e card no Jira.
- [x] Docs (Regra Zero): D-240 (notificação sem prévia) e D-241 (quem é avisado, onde vive,
      contador, som, preferências) em `docs/DECISIONS.md`; PAGES.md §2 "Aviso de mensagem nova";
      COMPONENTS.md (Sidebar menu, InboxLayout `listBanner`, AppShell, EnableNotificationsBanner,
      useNewMessageAlerts).
- [x] `stores/message-alerts.store.ts` (preferências em localStorage com try/catch + conversa aberta)
- [x] `lib/notification-sound.ts` (tom WebAudio sintético, sem arquivo)
- [x] `hooks/useNewMessageAlerts.ts`, montado no `AppShell` (todas as telas do laboratório)
- [x] `EnableNotificationsBanner` + `InboxLayout.listBanner`; Attendance publica a conversa aberta
      e relê `?conversationId=` a cada navegação (`location.key`)
- [x] Toggles "Som de mensagem nova" / "Notificações do navegador" no menu do usuário (Sidebar)
- [x] Specs: `hooks/useNewMessageAlerts.spec.tsx` (18), `pages/Attendance/EnableNotificationsBanner.spec.tsx` (6),
      `pages/Attendance/Attendance.alerts.spec.tsx` (3), `Sidebar.spec.tsx` (+2)
- [x] Typecheck do frontend verde; specs afetados verdes (14 arquivos, 645 testes: Attendance,
      layout, hooks, stores, ws, varreduras de token)

## Decisões escritas
- D-240, D-241 (ver DECISIONS.md, seção "2026-09-28 — Aviso de mensagem nova").

## Notas técnicas
- Payload WS `conversation.new_message` = `{ conversationId, messageId }` só; sinal de "mensagem
  do paciente" é o `unreadCount` subir (servidor só incrementa em `createFromPatient`). Nada mudou
  no backend nem no `shared/`.
- CSP `nginx/security-headers.conf` (Report-Only) já tem `media-src 'self' blob:`; som é WebAudio,
  não precisa de mudança de infra.
- Query própria do aviso: `['conversations', { status:'active', scope:'all', sortBy:'unreadCount',
  order:'desc', limit:100 }]` — invalidada pelo mesmo WS.

## Pendências / limitações (declaradas em D-241)
- Várias abas abertas: som toca em cada uma (a notificação se sobrepõe pela `tag`).
- Conversa aberta com a aba escondida é marcada lida no servidor pelo refetch do detalhe
  (comportamento anterior ao card).
- Favicon com bolinha (opcional no card) não foi feito.

## Risco de conflito na integração
- `frontend/src/pages/Attendance/index.tsx` (imports, efeito do deep link, prop `listBanner`) — CRMLAB-71.
- `docs/DECISIONS.md` (seção nova antes do template), `docs/frontend/PAGES.md` §2, `COMPONENTS.md`.
- `frontend/src/stores/index.ts`, `hooks/index.ts` (uma linha de export cada).

## Próximo passo exato
Nenhum no card. Orquestrador: mergear na `integ/epic-65` e validar na hml (aba em segundo plano,
permissão, som, título).
