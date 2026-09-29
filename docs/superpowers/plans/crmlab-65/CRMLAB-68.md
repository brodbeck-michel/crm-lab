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

### Próximo passo exato
1. Inventário `route-tenant-isolation.spec.ts` (+3 rotas) → specs de backend.
3. Frontend: `lib/search-snippet.ts`, queries/scroll/panel/lista/item/busca + specs.

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
- D-228 busca pelo conteúdo (função `crm_unaccent`, GIN parcial, rotas, trecho no frontend).
- D-229 não lidas por conversa, `POST /:id/unread`, `?unread=true`, `counts.unread`.
- D-230 `around`/`after`, `cursors.after`, rolagem até a mensagem e busca na conversa.

## Arquivos com risco de conflito (previstos)
`ConversationPanel.tsx` (lupa no cabeçalho — 67 mexe no cabeçalho, 69 no drop),
`useConversationScroll.ts`, `queries.ts`, `index.tsx`, `conversation.routes.ts`,
`message.repository.ts`, `shared/types/conversation.types.ts`, `route-tenant-isolation.spec.ts`,
`docs/DECISIONS.md` (fim).
