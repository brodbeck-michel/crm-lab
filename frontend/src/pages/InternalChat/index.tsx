import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError, queryKeys } from '@/api';
import { InboxLayout } from '@/components/layout';
import type { RecordedAudio } from '@/components/conversation';
import { useToast } from '@/components/ui';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore, selectUser } from '@/stores';
import { ChannelList } from './ChannelList';
import { MessagePanel } from './MessagePanel';
import { UserSearch } from './UserSearch';
import { internalMessagesOptions, useMarkChannelRead } from './queries';

/**
 * Chat Interno (`/internal-chat`) — PAGES.md §9 e WORKFLOWS.md §6.
 *
 * Duas colunas: canais + DMs à esquerda, mensagens à direita. Em `#aprovacoes`
 * o post do sistema traz a proposta anexada com [Aprovar] / [Rejeitar]
 * (WORKFLOWS.md §3) — a decisão é do BACKEND, a tela só oferece a UX.
 *
 * Abrir um canal É marcá-lo como lido (PAGES.md §9 / D-068): o clique chama
 * `POST /internal-chat/channels/:id/read` e só então invalida a lista de
 * canais, para o `unreadCount` do badge descer. Rolar o histórico para trás
 * NÃO marca nada — `GET .../messages` não tem efeito colateral.
 *
 * Nenhum dado de servidor sai daqui para o Zustand: canais, mensagens e a
 * proposta anexada vivem no TanStack Query, com as chaves de
 * `api/query-keys.ts`. Os eventos `internal_chat.new_message`,
 * `approval.requested` e `approval.decided` já invalidam essas MESMAS chaves
 * em `api/ws.ts` — a tela não faz patch manual de cache nem escuta o socket.
 */

/** Erros de sessão: o `handleApiError` manda para o login — não adianta seguir enviando. */
const SESSION_ERRORS: ReadonlySet<string> = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'UNAUTHORIZED',
]);

function readFileAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function InternalChat() {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const currentUser = useAuthStore(selectUser);
  const markChannelRead = useMarkChannelRead();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(1);

  const channelsQuery = useQuery({
    queryKey: queryKeys.internalChannels(),
    queryFn: () => api.internalChat.channels(),
  });

  const channels = useMemo(() => channelsQuery.data?.channels ?? [], [channelsQuery.data]);

  const directoryQuery = useQuery({
    queryKey: queryKeys.internalChatDirectory(),
    queryFn: () => api.internalChat.directory(),
  });
  const directoryUsers = useMemo(() => directoryQuery.data?.users ?? [], [directoryQuery.data]);

  /**
   * Clicar num usuário abre (ou cria, na primeira vez) a DM — get-or-create
   * idempotente (D-101). A tela seleciona o canal devolvido, mesmo comportamento
   * de clicar num canal já existente na lista.
   */
  const startDm = useMutation({
    mutationFn: (userId: string) => api.internalChat.startDirectChannel({ userId }),
    onSuccess: async (channel) => {
      setSelectedId(channel.id);
      setPageCount(1);
      await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
    },
    onError: handleApiError,
  });

  /**
   * Na PRIMEIRA carga, sem canal escolhido, abre o primeiro da lista. Depois
   * disso, `selectedId === null` é escolha de quem fechou pelo × (CRMLAB-109):
   * fica o estado vazio, sem reselecionar. Canal aberto que sumiu da lista
   * continua caindo no primeiro.
   */
  const autoSelected = useRef(false);
  useEffect(() => {
    if (channels.length === 0) return;
    if (selectedId === null && autoSelected.current) return;
    autoSelected.current = true;
    const stillExists = channels.some((channel) => channel.id === selectedId);
    if (!stillExists) {
      setSelectedId(channels[0]?.id ?? null);
      setPageCount(1);
    }
  }, [channels, selectedId]);

  /**
   * Abrir um canal É marcá-lo como lido (`useMarkChannelRead` em `queries.ts`).
   *
   * Fica no CLIQUE, e não num efeito sobre `selectedId`, por dois motivos:
   *
   * 1. O primeiro canal da lista é selecionado pela TELA, não pelo usuário
   *    (o efeito de auto-seleção abaixo). Zerar o badge de um canal que
   *    ninguém pediu para abrir apagaria justamente o aviso que a pessoa
   *    precisava ver ao entrar — e `#aprovacoes` é o primeiro da ordem fixa
   *    (`kind ASC, key ASC`), ou seja, seria sempre ele.
   * 2. Um efeito aqui se realimentaria: `markChannelRead` invalida
   *    `internalChannels`, a lista volta do servidor e o efeito rodaria de
   *    novo. No clique não existe esse laço.
   */
  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setPageCount(1);
      void markChannelRead(id).catch(handleApiError);
    },
    [markChannelRead, handleApiError],
  );

  const messagesQuery = useQuery({
    ...internalMessagesOptions(selectedId ?? '', pageCount),
    enabled: selectedId !== null,
  });

  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;

  const sendMessage = useMutation({
    mutationFn: (content: string) => api.internalChat.send(selectedId as string, { content }),
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

  /**
   * Anexos da prévia (CRMLAB-101, D-271): um POST por arquivo, EM SEQUÊNCIA, com a
   * legenda como `content` — mesmo fluxo do atendimento (D-233). Canal lido no
   * clique; erro é por arquivo (avisa com o nome e segue), menos sessão caída.
   */
  const [sendingFiles, setSendingFiles] = useState(false);
  async function handleSendAttachments(items: { file: File; caption: string }[]): Promise<void> {
    const channelId = selectedId;
    if (!channelId) return;
    setSendingFiles(true);
    try {
      for (const { file, caption } of items) {
        try {
          const contentBase64 = await readFileAsBase64(file);
          await api.internalChat.sendAttachment(channelId, {
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            contentBase64,
            ...(caption ? { content: caption } : {}),
          });
        } catch (error: unknown) {
          if (isApiError(error) && SESSION_ERRORS.has(error.code)) {
            handleApiError(error);
            break;
          }
          const reason = error instanceof Error ? error.message : 'erro inesperado';
          toast(`Não foi possível enviar "${file.name}": ${reason}`, { tone: 'attention' });
        }
      }
    } finally {
      setSendingFiles(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.internalMessages(channelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() }),
      ]);
    }
  }

  /**
   * Recado de voz (CRMLAB-109): o MESMO `POST .../attachments` do clipe, como o
   * atendimento faz (D-181). Rejeitar mantém a prévia no Composer para tentar de
   * novo; o aviso sai pelo `handleApiError`.
   */
  async function handleSendAudio(audio: RecordedAudio): Promise<void> {
    const channelId = selectedId;
    if (!channelId) return;
    try {
      const contentBase64 = await readFileAsBase64(audio.blob);
      await api.internalChat.sendAttachment(channelId, {
        fileName: audio.fileName,
        mimeType: audio.mimeType,
        contentBase64,
      });
    } catch (error: unknown) {
      handleApiError(error);
      throw error;
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.internalMessages(channelId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() }),
    ]);
  }

  return (
    <InboxLayout
      contextOpen={false}
      listLabel="Canais e conversas diretas"
      list={
        <>
          <UserSearch
            users={directoryUsers}
            onSelectUser={(userId) => startDm.mutate(userId)}
            isLoading={directoryQuery.isPending}
            isError={directoryQuery.isError}
          />
          <ChannelList
            channels={channels}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={channelsQuery.isPending}
            isError={channelsQuery.isError}
            onRetry={() => void channelsQuery.refetch()}
          />
        </>
      }
      conversation={
        <MessagePanel
          channel={selectedChannel}
          messages={messagesQuery.data?.messages ?? []}
          isLoading={selectedId !== null && messagesQuery.isPending}
          isError={messagesQuery.isError}
          onRetry={() => void messagesQuery.refetch()}
          onSend={(content) => sendMessage.mutateAsync(content)}
          sending={sendMessage.isPending || sendingFiles}
          onSendAttachments={handleSendAttachments}
          onSendAudio={handleSendAudio}
          onClose={() => setSelectedId(null)}
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
