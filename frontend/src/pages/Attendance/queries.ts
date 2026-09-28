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

export function conversationDetailOptions(id: string) {
  return {
    queryKey: [...queryKeys.conversation(id), 'messages'] as const,
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      api.conversations.get(id, {
        messageLimit: MESSAGE_PAGE_SIZE,
        ...(pageParam !== null ? { before: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    /** "Próxima" é a mais antiga; `null` = começo da conversa, nada a pedir. */
    getNextPageParam: (last: GetConversationResponse): string | null => last.cursors.before,
    staleTime: staleTimes.conversations,
  };
}

/** Páginas → lista em ordem crescente (cada página já vem crescente). */
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
 * refazer a listagem para o badge e as contagens sumirem.
 *
 * Ordem importa: busca o detalhe PRIMEIRO (servidor marca), invalida a lista
 * DEPOIS — invalidar antes traria de volta o contador antigo.
 */
export function useMarkAsRead(): (conversationId: string) => Promise<void> {
  const queryClient = useQueryClient();

  return useCallback(
    async (conversationId: string) => {
      await queryClient.fetchInfiniteQuery(conversationDetailOptions(conversationId));
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    },
    [queryClient],
  );
}
