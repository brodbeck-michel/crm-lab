# Diário — CRMLAB-71 [F] Leitura da conversa

Worktree `../CRM Lab-71`, branch `feature/CRMLAB-71-leitura-conversa` (de `integ/epic-65`).
Faixa: D-237…D-239 · migração 046 (não usada — o índice da 001 já serve o cursor).

## Estado

🔄 docs prontos — próximo: backend.

## Feito

- [x] Docs (Regra Zero): D-237 (cursor `before=<messageId>`), D-238 (`useInfiniteQuery` +
  rolagem que carrega sozinha), D-239 (separador, faixa de não lidas, botão ↓);
  API_CONTRACTS §2 (`GET /conversations/:id` com `before` e `cursors`), SERVICES §3,
  ARCHITECTURE (tabela de rotas), PAGES §2 + tabela de chaves, COMPONENTS (`DateSeparator`).

## Falta

- [ ] shared: `GetConversationQuery`, `MessageCursors`, `GetConversationResponse.cursors`
- [ ] backend: zod `before` (uuid, excludente com `page`), service + repository (limit+1,
  `(created_at,id) < (SELECT ...)`, 404 `message`), testes em `backend/tests/conversations/list.spec.ts`
- [ ] frontend: `DateSeparator` (+ spec), `queries.ts` com opções infinitas, `index.tsx` com
  `useInfiniteQuery` e `unreadAtOpen`, `useConversationScroll.ts`, `ConversationPanel.tsx`
  (separador, faixa, botão ↓, carregamento no topo, sem botão antigo), specs de tela
- [ ] typecheck (wt configs) + specs afetados verdes; diário ✅

## Decisões escritas

- D-237, D-238, D-239 em `docs/DECISIONS.md`.

## Notas para quem retomar

- Cursor no fio é o **id da mensagem**, não o texto `createdAt,id`: coluna `TIMESTAMP` tem
  microssegundos e o fio tem milissegundos (ver D-237). Desvio consciente do "before=<createdAt,id>"
  do prompt; a ordem continua `(created_at, id)`.
- Consumidores do endpoint: só a tela de Atendimento no front; e2e `flow-15`, `flow-19`,
  `flow-isolation` chamam sem parâmetro (continua igual).

## Próximo passo exato

Editar `shared/types/conversation.types.ts` (tipos acima) e seguir para o backend.
