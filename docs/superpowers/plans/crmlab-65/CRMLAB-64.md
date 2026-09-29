# Diário — CRMLAB-64 Setas no lightbox da imagem (padrão WhatsApp Web)

Worktree `../CRM Lab-64` · branch `feature/CRMLAB-64-setas-lightbox` (de `integ/epic-65`, com a
main v1.24.0). Faixa: D-244 … D-245 · sem migração. Só frontend.

## Estado

🔄 docs prontos (29/09/2026). Próximo: código.

## Leitura
- [x] CLAUDE.md, AGENTS.md, plano do épico, card no Jira, diários 71 (páginas do
  `useInfiniteQuery`, `flattenMessages`) e 68 (`around`, janela com chave própria).
- Legenda: a API grava `content = legenda`; sem legenda, `content = fileName` (D-231 e webhook
  Evolution) ou `[image]` (Cloud API). O lightbox esconde esses dois casos (D-244 item 5).
- Figurinha: hoje é `image` (`image/webp`), sem como distinguir — entra na navegação até o
  CRMLAB-70 criar o tipo `sticker` (a lista filtra por `messageType === 'image'`, então sai sozinha
  na integração). Não criei o tipo.

## Plano
1. [x] Docs (Regra Zero): D-244 (navegação), D-245 (blob compartilhado por URL), COMPONENTS
   (`MessageBubble.onOpenImage`, `ImageLightbox` novas props), PAGES §2.
2. [ ] `useAuthenticatedMedia` com cache por URL e contagem de referências (+ spec).
3. [ ] `ImageLightbox`: setas, ← →, cabeçalho, legenda, carregando/erro, preload (+ spec).
4. [ ] `pages/Attendance/useConversationImages.ts` (lista, cabeçalho, legenda) +
   `ConversationImageViewer.tsx`; `ConversationPanel` com o estado por id; `MessageBubble` só no
   trecho da imagem.
5. [ ] Specs: lightbox, hook de mídia, lista, painel (WS não pula; apagada fecha), bubble.
6. [ ] tsc shared/front, eslint dos arquivos mexidos.

## Arquivos compartilhados que toco (conflito com 70/73)
- `MessageBubble.tsx`: só o trecho da imagem (tirar `ImageLightbox`, `onOpenImage`) + prop nova.
- `ConversationPanel.tsx`: estado do lightbox, `bubbleActions`, `BubbleActions` e o viewer.
- `docs/DECISIONS.md` (fim), `COMPONENTS.md`, `PAGES.md` §2.
