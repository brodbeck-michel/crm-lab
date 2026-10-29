import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import type { InternalMessage } from '@crm-lab/shared';
import { api, isApiError, queryKeys, usePresenceOf } from '@/api';
import { InboxLayout } from '@/components/layout';
import type { RecordedAudio } from '@/components/conversation';
import { useToast } from '@/components/ui';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore, selectUser } from '@/stores';
import { useMessageAlertsStore } from '@/stores/message-alerts.store';
import { mergeReadState, useInternalChatReadsStore } from '@/stores/internal-chat-reads.store';
import { ChannelList } from './ChannelList';
import { MessagePanel } from './MessagePanel';
import { UserSearch } from './UserSearch';
import { internalMessagesOptions, useMarkChannelRead, useMarkReadWhileOpen } from './queries';

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
  /** Último canal aberto PELA PESSOA (clique/deep link) — CRMLAB-123, D-301. */
  const [openedId, setOpenedId] = useState<string | null>(null);
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
      // Recarrega a lista ANTES de selecionar: DM recém-criada ainda não está nela,
      // e o efeito de auto-seleção trocaria a escolha pelo primeiro canal.
      await queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
      setSelectedId(channel.id);
      setPageCount(1);
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
      setOpenedId(id);
      setPageCount(1);
      void markChannelRead(id).catch(handleApiError);
    },
    [markChannelRead, handleApiError],
  );

  /**
   * Deep link da notificação (CRMLAB-116, D-284): `/internal-chat?channelId=…`
   * abre o canal como um clique (marca como lido). Relê a cada NAVEGAÇÃO
   * (`location.key`), não só no mount — o clique pode chegar com a tela já
   * aberta, como o `?conversationId=` do Atendimento.
   */
  const [searchParams] = useSearchParams();
  const linkedChannelId = searchParams.get('channelId');
  const location = useLocation();
  useEffect(() => {
    if (linkedChannelId) {
      autoSelected.current = true;
      handleSelect(linkedChannelId);
    }
  }, [location.key]);

  // D-284: canal aberto com a aba em foco não gera aviso.
  const setOpenInternalChannelId = useMessageAlertsStore((s) => s.setOpenInternalChannelId);
  useEffect(() => {
    setOpenInternalChannelId(selectedId);
    return () => setOpenInternalChannelId(null);
  }, [selectedId, setOpenInternalChannelId]);

  const messagesQuery = useQuery({
    ...internalMessagesOptions(selectedId ?? '', pageCount),
    enabled: selectedId !== null,
  });

  const selectedChannel = channels.find((channel) => channel.id === selectedId) ?? null;

  // CRMLAB-123 (D-301): o ✓✓ ao vivo vem do WS direto no store (sem GET) e é
  // somado ao `readState` do último GET das mensagens.
  const liveReads = useInternalChatReadsStore((state) =>
    selectedId ? state.byChannel[selectedId] : undefined,
  );
  const serverReadState = messagesQuery.data?.readState ?? null;
  const readState = useMemo(
    () => mergeReadState(serverReadState, liveReads),
    [serverReadState, liveReads],
  );

  // CRMLAB-123 (D-301): com o canal aberto, mensagem nova de outra pessoa já é lida.
  useMarkReadWhileOpen(
    selectedId !== null && selectedId === openedId ? selectedId : null,
    messagesQuery.data?.messages,
    currentUser?.id ?? null,
    markChannelRead,
    handleApiError,
  );

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
   * Editar / apagar para todos da autora (CRMLAB-117, D-282). Prazo vencido entre
   * abrir o menu e clicar: aviso próprio e recarrega o canal (o item some). O WS
   * `internal_chat.message_updated` leva a mudança às outras abas e colegas.
   */
  const invalidateChannel = useCallback(
    (channelId: string) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.internalMessages(channelId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() }),
      ]),
    [queryClient],
  );

  const handleMessageActionError = useCallback(
    (action: 'edit' | 'delete', channelId: string, error: unknown) => {
      if (isApiError(error) && error.details?.reason === 'window_expired') {
        const verb = action === 'edit' ? 'editar' : 'apagar';
        toast(`O prazo para ${verb} esta mensagem já passou.`, { tone: 'attention' });
        void invalidateChannel(channelId);
        return;
      }
      handleApiError(error);
    },
    [handleApiError, invalidateChannel, toast],
  );

  const editMessage = useMutation({
    mutationFn: ({ message, content }: { message: InternalMessage; content: string }) =>
      api.internalChat.editMessage(message.channelId, message.id, { content }),
    onSuccess: (_data, { message }) => invalidateChannel(message.channelId),
    onError: (error, { message }) => handleMessageActionError('edit', message.channelId, error),
  });

  const deleteMessage = useMutation({
    mutationFn: (message: InternalMessage) =>
      api.internalChat.deleteMessage(message.channelId, message.id),
    onSuccess: (_data, message) => invalidateChannel(message.channelId),
    onError: (error, message) => handleMessageActionError('delete', message.channelId, error),
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

  // CRMLAB-120 (D-286): status da equipe na busca, nas DMs e no cabeçalho da DM.
  const presenceOf = usePresenceOf();

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
            presenceOf={presenceOf}
          />
          <ChannelList
            channels={channels}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={channelsQuery.isPending}
            isError={channelsQuery.isError}
            onRetry={() => void channelsQuery.refetch()}
            presenceOf={presenceOf}
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
          onEditMessage={(message, content) => editMessage.mutateAsync({ message, content })}
          onDeleteMessage={(message) => deleteMessage.mutate(message)}
          currentUserId={currentUser?.id ?? null}
          currentUserRole={currentUser?.role ?? null}
          hasOlderMessages={messagesQuery.data?.hasOlder ?? false}
          readState={readState}
          onLoadOlder={() => setPageCount((count) => count + 1)}
          presenceOf={presenceOf}
        />
      }
    />
  );
}

export default InternalChat;
