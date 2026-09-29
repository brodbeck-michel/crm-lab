# Diário — CRMLAB-68 [C] Busca nas mensagens, busca na conversa, "Não lidas" e marcar como não lida

Worktree `../CRM Lab-68` · branch `feature/CRMLAB-68-busca-nao-lidas` (de `integ/epic-65` @ 97a3e19).
Faixas: decisões D-228…D-230 · migração 043.

## Andamento (retomado em 29/09/2026)

### Pronto
- [x] Leitura (28/09): CLAUDE.md, AGENTS.md, plano do épico, card, diários 66/71/72, código.
- [x] Merge de `origin/integ/epic-65` (main + onda 1 + 63 + 74) na branch, sem conflito (a7869c2).
- [x] **Docs (Regra Zero):** D-228..D-230 em DECISIONS.md; API_CONTRACTS §2 (busca global,
      busca na conversa, `POST /:id/unread`, `?unread=true`, `counts.unread`, `after`/`around`,
      `cursors.after`); SCHEMA §4/índices/migrações (043); SERVICES §2/§3; PAGES §2 e tabela de
      chaves; COMPONENTS (`ConversationItem.onMarkUnread`, `ConversationSearch`,
      `MessageResults`, `lib/search-snippet.ts`); tipos em `shared/types/conversation.types.ts`.

- [x] Migração 043 (`crm_unaccent` + `idx_messages_content_search` parcial).
- [x] Backend: `MessageRepository.search`/`toSearchTsQuery`/`after`/`around`/`hasNewer`,
      `ConversationRepository.markAsUnread` + `unread` na lista + `counts.unread`,
      `ConversationService.searchMessages`/`markAsUnread`, `MessageService.search`, rotas
      `GET /search/messages`, `GET /:id/messages`, `POST /:id/unread`. Typecheck verde.

- [x] Specs de backend: `message-search.spec.ts` (shape, acento/caixa/prefixo, apagada/sistema/
      editada, recorte atendente/gestor/tenant, ordem/paginação, validação, 4000 mensagens +
      EXPLAIN usa o GIN parcial), `unread.spec.ts`, `cursor-around.spec.ts`; inventário 76 → 79;
      `cursor.spec`/`list.spec`/`assign.spec` ajustados (`counts.unread`, `cursors.after`).
      `tests/conversations` 104 ✓; `tests/messages` + inventário + migrator + `tests/db` 299 ✓.

- [x] Frontend: `lib/search-snippet.ts`; `SearchSnippet`, `MessageResults`, `ConversationSearch`
      (novos); chip "Não lidas", bloco "Mensagens", menu "⋯"/clique direito no item; `queries.ts`
      (`MessagePageParam`, `getPreviousPageParam`, chave com `{ around }`); rolagem com foco na
      mensagem e carga das mais novas sem descer; ↓ volta à ponta; linha de base do aviso
      (`useNewMessageAlerts`) usa `conversation.lastMessageAt`. Typecheck verde; specs antigos
      de Atendimento/ConversationItem/hooks/tokens 628 ✓.

- [x] Specs de frontend: `lib/search-snippet.spec.ts`, `ConversationItem.spec` (menu "⋯",
      clique direito, Esc, sem menu com não lidas), `ConversationPanel.search.spec.tsx` (foco +
      destaque, ↓ volta à ponta, página de mais novas não desce nem soma, lupa com ↑ ↓ e
      `around` fora do carregado), `Attendance.search.spec.tsx` (chip → `unread: true`, não lida
      fecha o painel, bloco Mensagens → `around`), `useNewMessageAlerts.spec` (não lida não
      avisa; linha de base com `around`). Escopo de frontend 796 ✓; typecheck e eslint verdes.

## ✅ pronto para integração (29/09/2026)
Falta só a suíte completa na `integ/epic-65` (regra do épico). Ver "Dúvidas / observações".

## Dúvidas / observações para o orquestrador
- A bolinha de "Marcar como não lida" é o `Badge` com **1** (o contador é por conversa, D-229),
  não um ponto sem número como no WhatsApp. Abrir a conversa marcada mostra a faixa
  "1 mensagem não lida" na última do paciente. Se o Michel quiser o ponto sem número, é outro
  campo (ex.: `markedUnread`) — não fiz para não mudar o significado do contador.
- "Marcar como não lida" vale para todos que veem a conversa (contador por conversa). Registrado
  em D-229; se o Michel quiser por atendente, é tabela nova.
- Prettier: os arquivos existentes que toquei já estavam fora do Prettier antes do card; formatei
  só os arquivos novos para não gerar diff/conflito com 67/69.

## Critérios de aceite (do card)
- [x] Palavra só dentro de uma mensagem acha a conversa e mostra o trecho.
- [x] Clicar no resultado abre a conversa na mensagem certa, mesmo antiga.
- [x] Busca dentro da conversa navega com ↑ ↓.
- [x] Ignora maiúscula e acento ("glicose"→"Glicose"; "orcamento"→"orçamento").
- [x] Chip "Não lidas" mostra só as com não lida.
- [x] Marcar como não lida devolve a bolinha, que some ao abrir de novo.
- [x] Outro tenant nunca aparece; atendente só vê o que veria na fila.
- [x] Rápido com alguns milhares de mensagens.
- [x] Testes de repositório (PGlite) e de tela, typecheck verdes.

## Decisões escritas
- D-228 busca pelo conteúdo (função `crm_unaccent`, GIN parcial, rotas, trecho no frontend).
- D-229 não lidas por conversa, `POST /:id/unread`, `?unread=true`, `counts.unread`.
- D-230 `around`/`after`, `cursors.after`, rolagem até a mensagem e busca na conversa.

## Arquivos com risco de conflito (reais)
- Backend: `conversation.routes.ts` (schemas + 3 rotas; `getConversationQuerySchema` com
  `after`/`around`), `message.repository.ts` (`listByConversation` reescrito, `search`),
  `message.service.ts` (`listByConversation`, `search`), `conversation.repository.ts` (`list`,
  `markAsUnread`), `conversation.service.ts`, `route-tenant-isolation.spec.ts` (76 → 79; 67/69
  somam por cima), `list.spec`/`assign.spec`/`cursor.spec`.
- Shared: `conversation.types.ts` (`ListConversationsQuery.unread`, `counts.unread`,
  `GetConversationQuery.after/around`, `MessageCursors`, tipos da busca).
- Frontend: `ConversationPanel.tsx` (lupa + barra no cabeçalho, ↓, `beforeReply`),
  `index.tsx`, `queries.ts`, `useConversationScroll.ts`, `scroll-to-message.ts`,
  `ConversationList.tsx`, `ConversationItem.tsx` (alfinete foi para uma coluna com o "⋯"),
  `hooks/useNewMessageAlerts.ts` (linha de base), `api/conversations.ts`, `api/query-keys.ts`.
- Docs: `DECISIONS.md` (fim), `API_CONTRACTS.md` §2, `SCHEMA.md` (§4, índices, lista de
  migrações), `SERVICES.md` §2/§3, `PAGES.md` §2 e tabela de chaves, `COMPONENTS.md`.
