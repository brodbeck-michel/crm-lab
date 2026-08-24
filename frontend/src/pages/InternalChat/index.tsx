import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, queryKeys } from '@/api';
import { InboxLayout } from '@/components/layout';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore, selectUser } from '@/stores';
import { ChannelList } from './ChannelList';
import { MessagePanel } from './MessagePanel';
import { internalMessagesOptions } from './queries';

/**
 * Chat Interno (`/internal-chat`) — PAGES.md §9 e WORKFLOWS.md §6.
 *
 * Duas colunas: canais + DMs à esquerda, mensagens à direita. Em `#aprovacoes`
 * o post do sistema traz a proposta anexada com [Aprovar] / [Rejeitar]
 * (WORKFLOWS.md §3) — a decisão é do BACKEND, a tela só oferece a UX.
 *
 * Nenhum dado de servidor sai daqui para o Zustand: canais, mensagens e a
 * proposta anexada vivem no TanStack Query, com as chaves de
 * `api/query-keys.ts`. Os eventos `internal_chat.new_message`,
 * `approval.requested` e `approval.decided` já invalidam essas MESMAS chaves
 * em `api/ws.ts` — a tela não faz patch manual de cache nem escuta o socket.
 */

export function InternalChat() {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const currentUser = useAuthStore(selectUser);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(1);

  const channelsQuery = useQuery({
    queryKey: queryKeys.internalChannels(),
    queryFn: () => api.internalChat.channels(),
  });

  const channels = useMemo(() => channelsQuery.data?.channels ?? [], [channelsQuery.data]);

  /** Sem canal escolhido, abre o primeiro da lista (normalmente `#geral`). */
  useEffect(() => {
    if (channels.length === 0) return;
    const stillExists = channels.some((channel) => channel.id === selectedId);
    if (!stillExists) {
      setSelectedId(channels[0]?.id ?? null);
      setPageCount(1);
    }
  }, [channels, selectedId]);

  const messagesQuery = useQuery({
    ...internalMessagesOptions(selectedId ?? '', pageCount),
    enabled: selectedId !== null,
  });

  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;

  const sendMessage = useMutation({
    mutationFn: (content: string) =>
      api.internalChat.send(selectedId as string, { content }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.internalMessages(selectedId as string),
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() }),
      ]);
    },
    onError: handleApiError,
  });

  return (
    <InboxLayout
      contextOpen={false}
      listLabel="Canais e conversas diretas"
      list={
        <ChannelList
          channels={channels}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setPageCount(1);
          }}
          isLoading={channelsQuery.isPending}
          isError={channelsQuery.isError}
          onRetry={() => void channelsQuery.refetch()}
        />
      }
      conversation={
        <MessagePanel
          channel={selectedChannel}
          messages={messagesQuery.data?.messages ?? []}
          isLoading={selectedId !== null && messagesQuery.isPending}
          isError={messagesQuery.isError}
          onRetry={() => void messagesQuery.refetch()}
          onSend={(content) => sendMessage.mutate(content)}
          sending={sendMessage.isPending}
          currentUserId={currentUser?.id ?? null}
          currentUserRole={currentUser?.role ?? null}
          hasOlderMessages={messagesQuery.data?.hasOlder ?? false}
          onLoadOlder={() => setPageCount((count) => count + 1)}
        />
      }
    />
  );
}

export default InternalChat;
