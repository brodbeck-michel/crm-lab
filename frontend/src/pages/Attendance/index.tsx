import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateAttachmentRequest,
  ListConversationsQuery,
  ListPatientsQuery,
} from '@crm-lab/shared';
import { api, isApiError, queryKeys, queryScopes, staleTimes } from '@/api';
import { useQuickReplyList } from '@/api/quick-replies';
import { useEffectiveFunnelRules } from '@/api/funnel-rules';
import { useToast } from '@/components/ui';
import { InboxLayout } from '@/components/layout';
import type { RecordedAudio } from '@/components/conversation';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore, useMessageAlertsStore, useUIStore, selectUser } from '@/stores';
import { ConversationList } from './ConversationList';
import type { ConversationScope } from './ConversationList';
import { ConversationPanel } from './ConversationPanel';
import { EnableNotificationsBanner } from './EnableNotificationsBanner';
import { PatientContext } from './PatientContext';
import { conversationDetailOptions, flattenMessages, useMarkAsRead } from './queries';

/**
 * Atendimento (`/attendance`) — TELA PRINCIPAL (PAGES.md §2).
 *
 * Inbox de 3 colunas: fila · conversa · contexto do paciente. A sidebar recolhe
 * sozinha para atendente nesta rota (o próprio `Sidebar` faz isso).
 *
 * Nenhum dado de servidor sai daqui para o Zustand: lista, detalhe e propostas
 * vivem no TanStack Query, com as chaves de `api/query-keys.ts`. O evento WS
 * `conversation.new_message` invalida essas chaves — a tela não faz patch
 * manual de cache.
 */

/** Erros de sessão: o `handleApiError` manda para o login — não adianta seguir enviando. */
const SESSION_ERRORS: ReadonlySet<string> = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'REFRESH_TOKEN_INVALID',
  'UNAUTHORIZED',
]);

/** Mínimo de caracteres para a busca de paciente sair (ver `patientsQuery`). */
const PATIENT_SEARCH_MIN = 2;
/** A coluna tem 336px: mais que isto vira rolagem sem ajudar a achar ninguém. */
const PATIENT_RESULT_LIMIT = 5;

export function Attendance() {
  const navigate = useNavigate();
  // D-193: "Novo Orçamento" some quando as Regras desligam a criação manual.
  const manualProposals = useEffectiveFunnelRules().origin.manualInCrm;
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();
  const currentUser = useAuthStore(selectUser);
  const contextOpen = useUIStore((state) => state.contextPanelOpen);
  const toggleContextPanel = useUIStore((state) => state.toggleContextPanel);
  const openModal = useUIStore((state) => state.openModal);
  const markAsRead = useMarkAsRead();

  const [scope, setScope] = useState<ConversationScope>('mine');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** `unreadCount` da lista no clique — o GET do detalhe zera o contador (D-239). */
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);

  const showClosed = scope === 'closed';
  const searchFilter = useMemo(
    () => (search.trim().length > 0 ? { search: search.trim() } : {}),
    [search],
  );

  /**
   * A fila (ATIVAS) roda sempre: é dela que saem os números de "Minhas" e "Não
   * atribuídas", inclusive com o chip "Encerradas" ligado — os counts do
   * servidor seguem o `status` pedido, e mostrar contagem de encerradas nos
   * chips da fila seria mentir sobre quem está esperando.
   */
  const filters = useMemo<ListConversationsQuery>(
    () => ({ status: 'active', scope: showClosed ? 'all' : scope, ...searchFilter }),
    [scope, showClosed, searchFilter],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.conversations(filters),
    queryFn: () => api.conversations.list(filters),
    staleTime: staleTimes.conversations,
  });

  const closedFilters = useMemo<ListConversationsQuery>(
    () => ({ status: 'closed', ...searchFilter }),
    [searchFilter],
  );

  const closedQuery = useQuery({
    queryKey: queryKeys.conversations(closedFilters),
    queryFn: () => api.conversations.list(closedFilters),
    staleTime: staleTimes.conversations,
    enabled: showClosed,
  });

  const shownList = showClosed ? closedQuery : listQuery;

  /**
   * A mesma busca também procura PACIENTE (D-079) — é o consumidor de
   * `GET /patients` e a porta de entrada da Ficha (API_CONTRACTS.md §2c: "a
   * tela chega aqui pela busca do inbox ou por link direto").
   *
   * Só dispara com 2+ caracteres: um caractere casaria com meio laboratório e
   * gastaria uma busca full-text por tecla. O servidor já aplica o recorte por
   * papel (D-060), então o atendente nunca recebe cadastro que não poderia
   * abrir.
   */
  const patientTerm = search.trim();
  const patientFilters = useMemo<ListPatientsQuery>(
    () => ({ search: patientTerm, limit: PATIENT_RESULT_LIMIT }),
    [patientTerm],
  );

  const patientsQuery = useQuery({
    queryKey: queryKeys.patients(patientFilters),
    queryFn: () => api.patients.list(patientFilters),
    enabled: patientTerm.length >= PATIENT_SEARCH_MIN,
    staleTime: staleTimes.patients,
  });

  const detailQuery = useInfiniteQuery({
    ...conversationDetailOptions(selectedId ?? ''),
    enabled: selectedId !== null,
  });

  const proposalsFilters = useMemo(() => ({ conversationId: selectedId ?? '' }), [selectedId]);

  const proposalsQuery = useQuery({
    queryKey: queryKeys.proposals(proposalsFilters),
    queryFn: () => api.proposals.list(proposalsFilters),
    enabled: selectedId !== null,
  });

  // A primeira página é a mais recente: é dela que vem a conversa atualizada.
  const conversation = detailQuery.data?.pages[0]?.conversation ?? null;
  const messages = useMemo(() => flattenMessages(detailQuery.data), [detailQuery.data]);

  /**
   * Página anterior (D-238): uma de cada vez e nunca durante um refetch — o
   * `fetchNextPage` do TanStack cancelaria a busca em voo e pediria de novo.
   */
  const { hasNextPage, isFetching, fetchNextPage } = detailQuery;
  const loadOlder = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);

  /** Lido ANTES de abrir: é o N da faixa de não lidas (D-239). */
  const listedConversations = shownList.data?.conversations;

  /** Abrir a conversa É marcar como lida (ver `queries.ts`). */
  const handleSelect = useCallback(
    (id: string) => {
      setUnreadAtOpen(listedConversations?.find((item) => item.id === id)?.unreadCount ?? 0);
      setSelectedId(id);
      void markAsRead(id).catch(handleApiError);
    },
    [markAsRead, handleApiError, listedConversations],
  );

  /**
   * Deep link de "Enviar orçamento" (`ProposalModal`): `/attendance
   * ?conversationId=…&draft=…` chega aqui já com a conversa e a mensagem
   * prontas. Só roda no MOUNT — depois disso a navegação normal (clique na
   * fila) manda em `selectedId`.
   */
  const initialConversationId = searchParams.get('conversationId');
  const initialDraft = searchParams.get('draft') ?? undefined;
  // CRMLAB-72 (D-240): clicar na notificação navega para cá com
  // `?conversationId=` — inclusive já estando nesta tela. Por isso relê a cada
  // NAVEGAÇÃO (`location.key`), não só no mount; o clique na fila não navega,
  // então continua mandando em `selectedId`. O projeto não tem
  // eslint-plugin-react-hooks configurado (ver eslint.config.js).
  const location = useLocation();
  useEffect(() => {
    if (initialConversationId) handleSelect(initialConversationId);
  }, [location.key]);

  // CRMLAB-72 (D-241 item 3): a conversa aberta não gera aviso com a aba em foco.
  const setOpenConversationId = useMessageAlertsStore((s) => s.setOpenConversationId);
  useEffect(() => {
    setOpenConversationId(selectedId);
    return () => setOpenConversationId(null);
  }, [selectedId, setOpenConversationId]);

  const invalidateConversation = useCallback(async () => {
    if (!selectedId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.conversation(selectedId) }),
      queryClient.invalidateQueries({ queryKey: queryScopes.conversations }),
    ]);
  }, [queryClient, selectedId]);

  const sendMessage = useMutation({
    mutationFn: ({ content, quotedMessageId }: { content: string; quotedMessageId?: string }) =>
      api.conversations.sendMessage(selectedId as string, {
        content,
        messageType: 'text',
        ...(quotedMessageId ? { quotedMessageId } : {}),
      }),
    onSuccess: invalidateConversation,
    onError: handleApiError,
  });

  /**
   * Reação do laboratório (CRMLAB-66, D-222). Só invalida: o WS
   * `conversation.message_updated` faz o mesmo nas outras abas.
   */
  const react = useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string | null }) => {
      if (emoji === null) await api.conversations.removeReaction(selectedId as string, messageId);
      else await api.conversations.setReaction(selectedId as string, messageId, { emoji });
    },
    onSuccess: invalidateConversation,
    onError: handleApiError,
  });

  /**
   * "Tentar de novo" (CRMLAB-67, D-227): reenvia a mesma mensagem. Falhou de
   * novo → `handleApiError` avisa; nos dois casos a conversa é refeita.
   */
  const retryMessage = useMutation({
    mutationFn: (messageId: string) => api.conversations.retryMessage(selectedId as string, messageId),
    onSettled: invalidateConversation,
    onError: handleApiError,
  });

  /** Presença da atendente (D-226/D-227): best-effort, erro não incomoda ninguém. */
  const sendPresence = useCallback(
    (presence: 'paused' | 'composing') => {
      if (!selectedId) return;
      api.conversations.sendPresence(selectedId, { presence }).catch(() => undefined);
    },
    [selectedId],
  );
  /**
   * `conversationId` vem de quem chama, lido ANTES de ler o arquivo: entre o
   * clique e o POST há o `FileReader`, e trocar de conversa nessa janela
   * mandava o anexo/recado para o paciente errado (revisão do CRMLAB-24).
   */
  const sendAttachment = useMutation({
    mutationFn: ({ conversationId, ...file }: CreateAttachmentRequest & { conversationId: string }) =>
      api.conversations.sendAttachment(conversationId, file),
    onSuccess: (_message, { conversationId }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversationId) }),
        queryClient.invalidateQueries({ queryKey: queryScopes.conversations }),
      ]),
    onError: handleApiError,
  });

  function readFileAsBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(file);
    });
  }

  /**
   * Anexos da prévia (CRMLAB-69, D-233): um POST por arquivo, EM SEQUÊNCIA, na
   * ordem da faixa. Destino lido no clique (antes de qualquer `FileReader`).
   * Só o PRIMEIRO leva a citação. Erro é por arquivo: avisa com o nome e segue
   * — menos sessão caída, que manda para o login e para o resto.
   */
  async function handleSendAttachments(
    items: { file: File; caption: string }[],
    quotedMessageId?: string,
  ): Promise<void> {
    const conversationId = selectedId;
    if (!conversationId) return;
    for (const [index, { file, caption }] of items.entries()) {
      try {
        const contentBase64 = await readFileAsBase64(file);
        await api.conversations.sendAttachment(conversationId, {
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          contentBase64,
          ...(caption ? { caption } : {}),
          ...(index === 0 && quotedMessageId ? { quotedMessageId } : {}),
        });
      } catch (error: unknown) {
        // MESSAGE_SEND_FAILED: gravou como falha e a bolha já mostra — mesmo
        // aviso de hoje. Sessão caída: o handler manda para o login e para.
        if (isApiError(error) && error.code === 'MESSAGE_SEND_FAILED') {
          handleApiError(error);
        } else if (isApiError(error) && SESSION_ERRORS.has(error.code)) {
          handleApiError(error);
          break;
        } else {
          const reason = error instanceof Error ? error.message : 'erro inesperado';
          toast(`Não foi possível enviar "${file.name}": ${reason}`, { tone: 'attention' });
        }
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.conversation(conversationId) }),
          queryClient.invalidateQueries({ queryKey: queryScopes.conversations }),
        ]);
      }
    }
  }

  /**
   * Recado de voz do compositor (CRMLAB-24, D-181): o MESMO endpoint do clipe.
   * `mutateAsync` para o Composer saber se foi — falhou, a prévia fica e o
   * erro já saiu pelo `handleApiError` do `onError`.
   */
  async function handleSendAudio(audio: RecordedAudio, quotedMessageId?: string): Promise<void> {
    const conversationId = selectedId;
    if (!conversationId) return;
    const contentBase64 = await readFileAsBase64(audio.blob);
    await sendAttachment.mutateAsync({
      conversationId,
      fileName: audio.fileName,
      mimeType: audio.mimeType,
      contentBase64,
      ...(quotedMessageId ? { quotedMessageId } : {}),
    });
  }

  /**
   * Fixar é PESSOAL e não muda os counts (Onda 8 §2.3): basta reconsultar a
   * listagem, que já devolve `pinned` do usuário e as fixadas primeiro.
   */
  const togglePin = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      api.conversations.setPinned(id, pinned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryScopes.conversations }),
    onError: handleApiError,
  });

  const closeAttendance = useMutation({
    mutationFn: () => api.conversations.close(selectedId as string),
    onSuccess: async () => {
      toast('Atendimento encerrado.', { tone: 'positive' });
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    },
    onError: handleApiError,
  });

  /**
   * Transferir (spec Onda 8 §2.1): o botão abre o menu com as colegas e com
   * "Devolver para a fila" (`assignedTo: null`). Os dois caminhos são o MESMO
   * `PATCH /conversations/:id` — quem valida alçada e gera a mensagem de
   * sistema é o backend.
   */
  const assigneesQuery = useQuery({
    queryKey: queryKeys.conversationAssignees(),
    queryFn: () => api.conversations.assignees(),
    staleTime: staleTimes.patients,
  });

  /**
   * Macros do laboratório (Onda 8 §3.4). A lista inteira, uma vez: o Composer
   * filtra em memória enquanto se digita depois da `/` — uma busca por request
   * a cada tecla seria uma ida ao servidor por caractere.
   */
  const quickRepliesQuery = useQuickReplyList();

  const assign = useMutation({
    mutationFn: (userId: string | null) => api.conversations.assign(selectedId as string, userId),
    onSuccess: async (_data, userId) => {
      const name = assigneesQuery.data?.assignees.find((a) => a.id === userId)?.name;
      toast(
        userId === null
          ? 'Conversa devolvida à fila.'
          : userId === currentUser?.id
            ? 'Conversa atribuída a você.'
            : `Conversa transferida para ${name ?? 'a colega escolhida'}.`,
        { tone: 'positive' },
      );
      await invalidateConversation();
    },
    onError: handleApiError,
  });

  return (
    <>
      <InboxLayout
        list={
          <ConversationList
            conversations={shownList.data?.conversations ?? []}
            counts={listQuery.data?.counts}
            scope={scope}
            onScopeChange={setScope}
            onSearch={setSearch}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={shownList.isPending}
            isError={shownList.isError}
            onRetry={() => void shownList.refetch()}
            onTogglePin={(id, pinned) => togglePin.mutate({ id, pinned })}
            searchTerm={patientTerm.length >= PATIENT_SEARCH_MIN ? patientTerm : ''}
            patients={patientsQuery.data?.patients ?? []}
            patientsLoading={patientsQuery.isPending}
            patientsError={patientsQuery.isError}
          />
        }
        conversation={
          <ConversationPanel
            conversation={conversation}
            messages={messages}
            isLoading={selectedId !== null && detailQuery.isPending}
            isError={detailQuery.isError}
            onRetry={() => void detailQuery.refetch()}
            onSend={(content, quotedMessageId) =>
              sendMessage
                .mutateAsync({ content, ...(quotedMessageId ? { quotedMessageId } : {}) })
                .catch((error: unknown) => {
                  // MESSAGE_SEND_FAILED: a mensagem FOI gravada (como falha) e já está
                  // na conversa. Devolver o texto ao campo convidaria a mandar de novo
                  // e duplicar (CRMLAB-63). Só volta quando nada foi gravado.
                  if (isApiError(error) && error.code === 'MESSAGE_SEND_FAILED') return;
                  throw error;
                })
            }
            onReact={(messageId, emoji) => react.mutate({ messageId, emoji })}
            onRetryMessage={(messageId) => retryMessage.mutate(messageId)}
            onPresence={sendPresence}
            onQuoteUnavailable={() =>
              toast('A mensagem original não está carregada — role para cima para vê-la.', {
                tone: 'attention',
              })
            }
            sending={sendMessage.isPending}
            assignees={assigneesQuery.data?.assignees ?? []}
            onAssign={(userId) => assign.mutate(userId)}
            onNewBudget={
              manualProposals
                ? () => navigate(`/budget/new?conversationId=${selectedId ?? ''}`)
                : undefined
            }
            onCloseAttendance={() => closeAttendance.mutate()}
            canCloseAttendance={
              currentUser?.role === 'manager' ||
              currentUser?.role === 'admin' ||
              (conversation !== null && conversation.assignedTo === currentUser?.id)
            }
            onToggleContext={toggleContextPanel}
            onClose={() => setSelectedId(null)}
            onSendAttachments={(items, quotedMessageId) =>
              void handleSendAttachments(items, quotedMessageId)
            }
            onSendAudio={handleSendAudio}
            quickReplies={quickRepliesQuery.data?.quickReplies ?? []}
            contextOpen={contextOpen}
            hasOlderMessages={hasNextPage}
            loadingOlder={detailQuery.isFetchingNextPage}
            onLoadOlder={loadOlder}
            unreadAtOpen={unreadAtOpen}
            draftMessage={selectedId === initialConversationId ? initialDraft : undefined}
          />
        }
        context={
          <PatientContext
            conversation={conversation}
            proposals={proposalsQuery.data?.proposals ?? []}
            isLoading={selectedId !== null && proposalsQuery.isPending}
            isError={proposalsQuery.isError}
            onOpenProposal={(id) => openModal({ kind: 'proposal', id })}
          />
        }
        listBanner={<EnableNotificationsBanner />}
      />
    </>
  );
}

export default Attendance;
