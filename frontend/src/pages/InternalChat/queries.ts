import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InternalMessage } from '@crm-lab/shared';
import { api, queryKeys } from '@/api';

/**
 * Opções de query do Chat Interno — um único lugar, para que a tela e o
 * "carregar anteriores" nunca usem chaves diferentes.
 *
 * ── Paginação (D-069 · PAGES.md §9) ────────────────────────────────────────
 * `GET /internal-chat/channels/:id/messages` pagina **do fim**: `page=1` é a
 * fatia das mensagens MAIS RECENTES, com os itens em ordem cronológica
 * crescente dentro dela; `page=2` é o bloco imediatamente anterior. Abrir um
 * canal no estado útil custa UM request — o `fetchTail` de dois requests (ler
 * `totalPages`, depois buscar a última página) da Onda 5 deixou de existir
 * junto com a implementação que fatiava do começo.
 *
 * Por isso "carregar anteriores" é `pageCount + 1`, e as páginas carregadas
 * são concatenadas da MAIS ANTIGA para a mais recente (`page` decrescente):
 * a lista renderizada segue cronológica de cima para baixo.
 *
 * A chave é `[...queryKeys.internalMessages(id), pageCount]`: continua
 * derivada de `api/query-keys.ts` e continua sendo invalidada pelo evento WS
 * `internal_chat.new_message`, que invalida o PREFIXO
 * `['internal-chat', 'messages', id]`.
 */

/** Mensagens por página. O servidor aceita no máximo 100. */
export const MESSAGE_PAGE_SIZE = 50;

export interface InternalMessagesPage {
  messages: InternalMessage[];
  /** Ainda existe página anterior (mais antiga) no servidor. */
  hasOlder: boolean;
}

/**
 * Lê as `pageCount` fatias mais recentes do histórico. `pageCount = 1` (o caso
 * de abrir o canal) é exatamente um request.
 */
export async function fetchRecentPages(
  channelId: string,
  pageCount: number,
): Promise<InternalMessagesPage> {
  const wanted: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) wanted.push(page);

  const pages = await Promise.all(
    wanted.map((page) =>
      api.internalChat.messages(channelId, { page, limit: MESSAGE_PAGE_SIZE }),
    ),
  );

  const totalPages = pages[0]?.pagination.totalPages ?? 0;

  return {
    // `page=1` é o FIM da conversa: para renderizar em ordem cronológica, a
    // página de maior número (a mais antiga carregada) vem primeiro.
    messages: [...pages].reverse().flatMap((result) => result.messages),
    hasOlder: pageCount < totalPages,
  };
}

export function internalMessagesOptions(channelId: string, pageCount: number) {
  return {
    queryKey: [...queryKeys.internalMessages(channelId), pageCount] as const,
    queryFn: () => fetchRecentPages(channelId, pageCount),
  };
}

/**
 * `markChannelRead` — PAGES.md §9 ("Estado de leitura do canal", D-068).
 *
 * `POST /internal-chat/channels/:id/read` PRIMEIRO, invalidação da lista de
 * canais DEPOIS: invalidar antes traria de volta o `unreadCount` velho e o
 * badge não desceria. Mesma sequência do `useMarkAsRead` do inbox.
 */
export function useMarkChannelRead(): (channelId: string) => Promise<void> {
  const queryClient = useQueryClient();

  return useCallback(
    async (channelId: string) => {
      await api.internalChat.markRead(channelId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
    },
    [queryClient],
  );
}
