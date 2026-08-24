import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, queryKeys, queryScopes, staleTimes } from '@/api';

/**
 * Opções de query da tela de Atendimento — um único lugar, para que a leitura
 * do painel e o `markAsRead` NUNCA usem chaves diferentes (seriam dois
 * requests para o mesmo dado).
 *
 * A chave do detalhe é `[...queryKeys.conversation(id), messageLimit]`:
 * continua derivada de `api/query-keys.ts` e continua sendo invalidada pelo
 * evento WS `conversation.new_message`, que invalida o PREFIXO
 * `['conversation', id]`.
 */

/** Mensagens carregadas por vez (`GET /conversations/:id?limit=`). */
export const MESSAGE_PAGE_SIZE = 50;

export function conversationDetailOptions(id: string, messageLimit: number) {
  return {
    queryKey: [...queryKeys.conversation(id), messageLimit] as const,
    queryFn: () => api.conversations.get(id, { limit: messageLimit }),
    staleTime: staleTimes.conversations,
  };
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
      await queryClient.fetchQuery(conversationDetailOptions(conversationId, MESSAGE_PAGE_SIZE));
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    },
    [queryClient],
  );
}
