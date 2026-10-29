import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { InternalChannelReadState, InternalMessage } from '@crm-lab/shared';
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
  /**
   * Quem já leu o canal (CRMLAB-123, D-300) — da página 1, a mais fresca. `null`
   * com servidor antigo. Refeito pelo WS `internal_chat.channel_read`.
   */
  readState: InternalChannelReadState | null;
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
    readState: pages[0]?.readState ?? null,
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

/**
 * Janela que junta as leituras automáticas do canal aberto (D-301): uma rajada
 * de mensagens vira UM `POST .../read`, não um por mensagem — cada POST que
 * avança gera um `internal_chat.channel_read` para o tenant inteiro.
 */
export const MARK_READ_WHILE_OPEN_DEBOUNCE_MS = 1500;

/**
 * Canal ABERTO pela pessoa, aba visível: mensagem nova de OUTRA pessoa que chega
 * pelo WS conta como lida (CRMLAB-123, D-301) — como no WhatsApp. Sem isso o ✓✓
 * de quem escreveu só viraria quando a leitora clicasse de novo no canal.
 *
 * `channelId` só vem preenchido quando a PESSOA abriu o canal (clique ou deep
 * link) — o canal auto-selecionado na entrada continua sem marcar (D-068). A
 * primeira carga depois de abrir vira só a linha de base: o clique já marcou.
 * Aba escondida não marca; ao voltar a ficar visível, marca o que chegou.
 * Sem polling: só reage ao que o cache trouxe. As marcações são agrupadas em
 * `MARK_READ_WHILE_OPEN_DEBOUNCE_MS`; trocar de canal ou sair da tela dispara
 * na hora a que estava pendente. Sem laço: o `channel_read` que o POST gera não
 * mexe nas mensagens (vai para o store), então não chega aqui.
 */
export function useMarkReadWhileOpen(
  channelId: string | null,
  messages: InternalMessage[] | undefined,
  currentUserId: string | null,
  markRead: (channelId: string) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  const baseline = useRef<{ channelId: string; lastId: string | null } | null>(null);
  const pending = useRef<{ channelId: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const latestHandlers = useRef({ markRead, onError });
  latestHandlers.current = { markRead, onError };
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );

  useEffect(() => {
    const onChange = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const flush = useCallback((): void => {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timer);
    pending.current = null;
    const { markRead: mark, onError: fail } = latestHandlers.current;
    void mark(current.channelId).catch(fail);
  }, []);

  // Trocou de canal (ou saiu da tela): a leitura pendente sai na hora.
  useEffect(() => flush, [channelId, flush]);

  useEffect(() => {
    if (channelId === null || messages === undefined) {
      if (channelId === null) baseline.current = null;
      return;
    }
    const latest = messages.at(-1) ?? null;
    if (latest !== null && latest.channelId !== channelId) return;
    if (baseline.current?.channelId !== channelId) {
      baseline.current = { channelId, lastId: latest?.id ?? null };
      return;
    }
    if (latest === null || latest.id === baseline.current.lastId || !visible) return;

    const start = messages.findIndex((message) => message.id === baseline.current?.lastId);
    const arrived = messages.slice(start + 1);
    baseline.current = { channelId, lastId: latest.id };
    if (!arrived.some((message) => message.senderId !== currentUserId)) return;
    if (pending.current?.channelId === channelId) return; // já agendada: a rajada vira um POST
    flush();
    pending.current = {
      channelId,
      timer: setTimeout(flush, MARK_READ_WHILE_OPEN_DEBOUNCE_MS),
    };
  }, [channelId, messages, visible, currentUserId, flush]);
}
