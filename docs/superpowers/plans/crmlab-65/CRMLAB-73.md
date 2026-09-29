# Diário — CRMLAB-73 [H] Texto da conversa: rascunho, links, formatação e emoji

Worktree `../CRM Lab-73` · branch `feature/CRMLAB-73-texto-rascunho` (de `integ/epic-65`, com a
main v1.24.0). Faixa: D-242…D-243 · sem migração · só frontend.

## Etapa 1 — docs (Regra Zero) ✅
- Lido: CLAUDE.md, AGENTS.md, plano do épico, card no Jira, D-183, diário do 69, Composer,
  MessageBubble, EmojiPicker, ConversationItem, ConversationPanel.
- `DECISIONS.md`: D-242 (parser/links/ênfase/linhas) e D-243 (rascunho + emoji estático).
- `COMPONENTS.md`: ConversationItem (Rascunho), MessageBubble (formatação), Composer (atalhos,
  `draftId`), EmojiPicker, `WhatsAppText` novo.

## Plano (arquivos)
- `lib/whatsapp-format.ts` — `parseWhatsApp` (sai `splitBold`) + spec.
- `components/conversation/WhatsAppText.tsx` — desenha a árvore.
- `MessageBubble.tsx` — só o `<p>` do texto troca para `WhatsAppText` (70/64 mexem no resto).
- `stores/drafts.store.ts` + spec; `Composer.tsx` (`draftId`, Ctrl+I, Ctrl+Shift+X) + spec.
- `ConversationPanel.tsx` — uma prop (`draftId={conversation.id}`).
- `ConversationItem.tsx` — "Rascunho: …" + limpeza de encerrada.
- `EmojiPicker.tsx` + `emoji-data.ts` + spec.

## Perguntas em aberto (regra de negócio)
- Sair do sistema apaga todos os rascunhos do navegador (leitura restritiva, D-243 item 4c).
  Confirmar com o Michel se prefere manter entre sessões (só escopados por usuário).
- Prazo de 7 dias para descartar rascunho esquecido (D-243 item 4b): valor escolhido, confirmar.

## Etapa 2 — parser e bolha ✅
- `parseWhatsApp` + `plainText` em `lib/whatsapp-format.ts` (sai `splitBold`); `WhatsAppText`
  novo; `MessageBubble` troca só o miolo do `<p>` do texto (import + 2 linhas).
- Bug achado pelo teste: a crase de fechamento de ```` ``` ```` casava com a do `` `código` ``
  seguinte. Correção: cada passada de literais procura no texto com os anteriores mascarados.
- Specs: `whatsapp-format.spec.ts` 37 ✓, `WhatsAppText.spec.tsx` 4 ✓, MessageBubble (3 arquivos) 43 ✓.

## Etapa 3 — rascunho ✅ (lista pendente)
- `stores/drafts.store.ts` (+ barril): chave `userId:conversationId`, `StateStorage` com
  try/catch, `merge` com `pruneDrafts` (formato + 7 dias), `clearSession` apaga tudo.
- `Composer`: `draftId`, semente `initialValue ?? rascunho`, cursor no fim ao montar, efeito
  grava a cada mudança; `wrapSelection(marker)` com Ctrl+B / Ctrl+I / Ctrl+Shift+X.
- `ConversationPanel`: só `draftId={conversation.id}` no Composer.
- Specs: `drafts.store.spec.ts` 10 ✓, `Composer*.spec.tsx` (5 arquivos, inclui o novo
  `Composer.format-draft.spec.tsx`) 56 ✓.
