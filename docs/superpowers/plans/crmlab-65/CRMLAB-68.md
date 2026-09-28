# Diário — CRMLAB-68 [C] Busca nas mensagens, busca na conversa, "Não lidas" e marcar como não lida

Worktree `../CRM Lab-68` · branch `feature/CRMLAB-68-busca-nao-lidas` (de `integ/epic-65` @ 97a3e19).
Faixas: decisões D-228…D-230 · migração 043.

## ⏸️ PAUSADO em 28/09/2026 17:21 (pedido do Michel: computador vai ser desligado)

**Nenhum arquivo de código ou doc de contrato foi alterado ainda.** Só a leitura foi feita,
e o desenho abaixo ficou pronto para começar a implementação.

### Pronto
- [x] Leitura: CLAUDE.md, AGENTS.md, plano do épico, card no Jira (critérios de aceite abaixo),
      diários 66/71/72, D-220, D-237..D-241.
- [x] Leitura do código: `conversation.repository.ts` (list/visibilidade/markAsRead),
      `message.repository.ts` (listByConversation com `before`), `message.service.ts`
      (listByConversation/cursors), `conversation.service.ts` (canSee/toCriteria),
      `conversation.routes.ts`, `shared/types/conversation.types.ts`, API_CONTRACTS §2;
      frontend `Attendance/{index.tsx,queries.ts,ConversationList.tsx,ConversationPanel.tsx,
      useConversationScroll.ts,scroll-to-message.ts}`, `ConversationItem.tsx`,
      `hooks/useNewMessageAlerts.ts`, `api/conversations.ts`, `api/query-keys.ts`.

### Pela metade
- Nada começado em arquivo. Falta ainda conferir se o PGlite tem `unaccent`: o plano é **não
  depender dele** (ver D-228 abaixo).

### Desenho planejado (escrever como D-228..D-230 ANTES de codar — Regra Zero)
- **D-228 · Busca pelo conteúdo:** migração 043 cria a função `IMMUTABLE` `crm_unaccent(text)`
  (via `translate()`, sem extensão: funciona no PGlite e no Postgres sem superusuário) e o índice
  GIN `to_tsvector('portuguese', crm_unaccent(content))` em `messages`, **parcial** `WHERE
  deleted_at IS NULL`. Consulta: tokens do termo com `:*` (prefixo), unidos por `&`, passados
  por `crm_unaccent`. Filtros: `deleted_at IS NULL` (mensagem apagada **nunca** aparece, D-220),
  `sender_type <> 'system'`, visibilidade igual à da lista (`assigned_to = eu OR IS NULL` para
  atendente; gestor/admin: todas), todos os status. Ordem `created_at DESC, id DESC`.
  Rotas: `GET /conversations/search/messages?q=&page=&limit=` (registrar ANTES de `/:id`) e
  `GET /conversations/:id/messages?q=` (404 se a conversa não é visível). Resposta:
  `{ results: MessageSearchHit[], pagination }` com `messageId, conversationId, patientName,
  patientPhone, senderType, createdAt, content`. O trecho e o destaque são montados no frontend
  (função pura, sem acento), não com `ts_headline`, que traria HTML e não destaca palavra
  acentuada quando o termo vem sem acento.
- **D-229 · Não lidas:** o contador continua **por conversa** (`unread_count`, como já é).
  `POST /conversations/:id/unread` → `unread_count = GREATEST(unread_count, 1)`, sem mexer em
  `last_message_at` e sem emitir WS. Por isso o aviso do 72 **não** dispara:
  `detectNewMessages` exige que o `lastMessageAt` também mude (escrever teste disso em
  `useNewMessageAlerts.spec.tsx`). Listagem: `?unread=true` e `counts.unread` (opcional no tipo)
  saindo do mesmo `COUNT(*) FILTER`. Chip "Não lidas N" exclusivo, como os outros
  (`ConversationScope` ganha `'unread'`). Marcar a conversa **aberta** como não lida fecha o
  painel (senão o refetch do detalhe zera de novo). Menu no `ConversationItem`: clique direito
  e botão "⋯" com "Marcar como não lida" (só aparece quando `unreadCount === 0`).
- **D-230 · Ir até a mensagem:** `GET /conversations/:id?around=<messageId>` (metade antes,
  metade depois) e `?after=<messageId>` (as `messageLimit` mais novas). `around`, `after`,
  `before` e `page` são excludentes entre si. `cursors.after` não nulo = existem mensagens mais
  novas que a mais nova da página (vale para todo modo: página mais recente → `null`; página
  `before` → id da mais nova). Mensagem de outra conversa ou de outro tenant → `NOT_FOUND`.
  Frontend: `pageParam` vira `{ before } | { after } | { around } | null`,
  `getPreviousPageParam = first.cursors.after`. Com `around`, a chave ganha um 4º elemento
  `[...conversation(id), 'messages', { around }]` (continua sob o prefixo do WS e do hook do 72),
  com `placeholderData` só da mesma conversa. Rolar perto do fim com `cursors.after` carrega as
  mais novas (`fetchPreviousPage`), com âncora (não pode descer sozinho). Botão ↓ com mais
  novas não carregadas volta para a chave da ponta (sem `around`) e rola ao fim.
  `useMarkAsRead(id, around?)` usa as mesmas opções: abrir continua sendo um GET só. Abrir por
  resultado de busca não mostra a faixa de não lidas (`unreadAtOpen = 0`).
  `scrollToMessage` ganha o parâmetro opcional `behavior` (aditivo).

### Próximo passo exato
1. `git pull` na branch; conferir `git status` limpo.
2. Escrever D-228..D-230 em `docs/DECISIONS.md` (fim do arquivo, antes do "Template"),
   API_CONTRACTS §2 (as 3 rotas novas, `around`/`after`, `unread`, `counts.unread`),
   SCHEMA.md (migração 043), PAGES.md §2, COMPONENTS.md; tipos em
   `shared/types/conversation.types.ts`. Commit "docs".
3. Migração `backend/migrations/043_message_search.sql` → repositório/service/rotas → inventário
   `backend/tests/kernel/route-tenant-isolation.spec.ts` (76 → 79) → specs de backend
   (busca, apagada não aparece, visibilidade, tenant, acento, around/after nas bordas, unread,
   volume de alguns milhares no PGlite).
4. Frontend: queries/scroll/panel/lista/item/busca na conversa + specs com o formato real do
   cache (`{ pages, pageParams }` e `cursors`).

## Critérios de aceite (do card)
- [ ] Palavra só dentro de uma mensagem acha a conversa e mostra o trecho.
- [ ] Clicar no resultado abre a conversa na mensagem certa, mesmo antiga.
- [ ] Busca dentro da conversa navega com ↑ ↓.
- [ ] Ignora maiúscula e acento ("glicose"→"Glicose"; "orcamento"→"orçamento").
- [ ] Chip "Não lidas" mostra só as com não lida.
- [ ] Marcar como não lida devolve a bolinha, que some ao abrir de novo.
- [ ] Outro tenant nunca aparece; atendente só vê o que veria na fila.
- [ ] Rápido com alguns milhares de mensagens.
- [ ] Testes de repositório (PGlite) e de tela, typecheck verdes.

## Decisões escritas
Nenhuma ainda (D-228..D-230 reservadas, desenho acima).

## Arquivos com risco de conflito (previstos)
`ConversationPanel.tsx` (lupa no cabeçalho — 67 mexe no cabeçalho, 69 no drop),
`useConversationScroll.ts`, `queries.ts`, `index.tsx`, `conversation.routes.ts`,
`message.repository.ts`, `shared/types/conversation.types.ts`, `route-tenant-isolation.spec.ts`,
`docs/DECISIONS.md` (fim).
