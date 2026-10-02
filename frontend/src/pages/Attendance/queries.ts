import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { GetConversationResponse, Message } from '@crm-lab/shared';
import { api, queryKeys, queryScopes, staleTimes } from '@/api';

/**
 * Opções de query da tela de Atendimento — um único lugar, para que a leitura
 * do painel e o `markAsRead` NUNCA usem chaves diferentes (seriam dois
 * requests para o mesmo dado).
 *
 * O detalhe é uma query INFINITA (D-238): a primeira página é a mais recente
 * (sem cursor) e cada página seguinte é MAIS ANTIGA, pedida com
 * `before=cursors.before` (D-237). A chave `[...queryKeys.conversation(id),
 * 'messages']` continua derivada de `api/query-keys.ts` e continua sendo
 * invalidada pelo evento WS `conversation.new_message`, que invalida o PREFIXO
 * `['conversation', id]` — o TanStack v5 refaz as páginas carregadas
 * recalculando cada cursor a partir da página que acabou de voltar.
 */

/** Mensagens carregadas por vez (`GET /conversations/:id?messageLimit=`). */
export const MESSAGE_PAGE_SIZE = 50;

/**
 * Cursor de uma página (D-237/D-230). `null` = a página mais recente; `around`
 * só na PRIMEIRA página de uma conversa aberta numa mensagem (busca).
 */
export type MessagePageParam = { before: string } | { after: string } | { around: string } | null;

/**
 * Aberta numa mensagem (`around`, D-230), a chave ganha um 4º elemento — e
 * continua sob o prefixo `['conversation', id]` que o WS invalida.
 */
export function conversationDetailKey(id: string, around?: string) {
  return around
    ? ([...queryKeys.conversation(id), 'messages', { around }] as const)
    : ([...queryKeys.conversation(id), 'messages'] as const);
}

export function conversationDetailOptions(id: string, around?: string) {
  return {
    queryKey: conversationDetailKey(id, around),
    queryFn: ({ pageParam }: { pageParam: MessagePageParam }) =>
      api.conversations.get(id, { messageLimit: MESSAGE_PAGE_SIZE, ...(pageParam ?? {}) }),
    initialPageParam: (around ? { around } : null) as MessagePageParam,
    /** "Próxima" é a mais antiga; `null` = começo da conversa, nada a pedir. */
    getNextPageParam: (last: GetConversationResponse): MessagePageParam =>
      last.cursors.before !== null ? { before: last.cursors.before } : null,
    /** "Anterior" é a mais NOVA (D-230); a página da ponta volta `after: null`. */
    getPreviousPageParam: (first: GetConversationResponse): MessagePageParam =>
      first.cursors.after !== null ? { after: first.cursors.after } : null,
    staleTime: staleTimes.conversations,
  };
}

/**
 * Páginas → lista em ordem crescente (cada página já vem crescente). A
 * primeira página é a mais nova: `fetchPreviousPage` põe as mais novas na
 * frente, `fetchNextPage` as mais antigas no fim.
 */
export function flattenMessages(data: { pages: GetConversationResponse[] } | undefined): Message[] {
  if (!data) return [];
  return [...data.pages].reverse().flatMap((page) => page.messages);
}

/**
 * `markAsRead` — PAGES.md §2 ("Ao abrir: markAsRead").
 *
 * Não existe endpoint dedicado: `GET /conversations/:id` é quem zera o
 * contador no servidor (API_CONTRACTS.md §2 mostra `unreadCount: 0` e
 * `status: "read"` na resposta do detalhe, com a mesma conversa listada com
 * `unreadCount: 3`). Então abrir a conversa É marcar como lida; o que falta é
 * refazer a listagem para o badge e as contagens sumirem. Aberta numa
 * mensagem (`around`), usa as MESMAS opções da tela — continua um GET só.
 *
 * Ordem importa: busca o detalhe PRIMEIRO (servidor marca), invalida a lista
 * DEPOIS — invalidar antes traria de volta o contador antigo.
 */
export function useMarkAsRead(): (conversationId: string, around?: string) => Promise<void> {
  const queryClient = useQueryClient();

  return useCallback(
    async (conversationId: string, around?: string) => {
      await queryClient.fetchInfiniteQuery(conversationDetailOptions(conversationId, around));
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    },
    [queryClient],
  );
}
