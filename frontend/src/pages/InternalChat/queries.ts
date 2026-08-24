import type { InternalMessage } from '@crm-lab/shared';
import { api, queryKeys } from '@/api';

/**
 * Opções de query do Chat Interno — um único lugar, para que a tela e o
 * "carregar anteriores" nunca usem chaves diferentes.
 *
 * ── Por que existe `fetchTail` ──────────────────────────────────────────────
 * `GET /internal-chat/channels/:id/messages` ordena por `created_at ASC` com
 * `page`/`limit` por OFFSET (backend `internal-chat.repository.ts`). Ou seja:
 * página 1 são as mensagens MAIS ANTIGAS. Um chat abre nas mais RECENTES, que
 * ficam na ÚLTIMA página — daí `fetchTail`, que descobre `totalPages` e lê da
 * cauda para trás. Divergência doc × implementação registrada no relatório
 * (o contrato não define cursor nem ordem descendente).
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

export async function fetchTail(
  channelId: string,
  pageCount: number,
): Promise<InternalMessagesPage> {
  const head = await api.internalChat.messages(channelId, {
    page: 1,
    limit: MESSAGE_PAGE_SIZE,
  });

  const totalPages = head.pagination.totalPages;
  if (totalPages <= 1) return { messages: head.messages, hasOlder: false };

  const firstWanted = Math.max(1, totalPages - pageCount + 1);
  const wanted: number[] = [];
  for (let page = firstWanted; page <= totalPages; page += 1) wanted.push(page);

  const pages = await Promise.all(
    wanted.map((page) =>
      page === 1
        ? Promise.resolve(head)
        : api.internalChat.messages(channelId, { page, limit: MESSAGE_PAGE_SIZE }),
    ),
  );

  return {
    messages: pages.flatMap((result) => result.messages),
    hasOlder: firstWanted > 1,
  };
}

export function internalMessagesOptions(channelId: string, pageCount: number) {
  return {
    queryKey: [...queryKeys.internalMessages(channelId), pageCount] as const,
    queryFn: () => fetchTail(channelId, pageCount),
  };
}
