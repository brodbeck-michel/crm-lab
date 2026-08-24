import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListConversationsQuery } from '@crm-lab/shared';
import { api, queryKeys, queryScopes, staleTimes } from '@/api';
import { useToast } from '@/components/ui';
import { InboxLayout } from '@/components/layout';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore, useUIStore, selectUser } from '@/stores';
import { ConversationList } from './ConversationList';
import type { ConversationScope } from './ConversationList';
import { ConversationPanel } from './ConversationPanel';
import { PatientContext } from './PatientContext';
import { MESSAGE_PAGE_SIZE, conversationDetailOptions, useMarkAsRead } from './queries';

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

export function Attendance() {
  const navigate = useNavigate();
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
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);

  const filters = useMemo<ListConversationsQuery>(
    () => ({
      status: 'active',
      scope,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
    }),
    [scope, search],
  );

  const listQuery = useQuery({
    queryKey: queryKeys.conversations(filters),
    queryFn: () => api.conversations.list(filters),
    staleTime: staleTimes.conversations,
  });

  const detailQuery = useQuery({
    ...conversationDetailOptions(selectedId ?? '', messageLimit),
    enabled: selectedId !== null,
  });

  const proposalsFilters = useMemo(
    () => ({ conversationId: selectedId ?? '' }),
    [selectedId],
  );

  const proposalsQuery = useQuery({
    queryKey: queryKeys.proposals(proposalsFilters),
    queryFn: () => api.proposals.list(proposalsFilters),
    enabled: selectedId !== null,
  });

  const conversation = detailQuery.data?.conversation ?? null;
  const messages = detailQuery.data?.messages ?? [];
  const loadedAll = (detailQuery.data?.pagination.total ?? 0) <= messages.length;

  /** Abrir a conversa É marcar como lida (ver `queries.ts`). */
  const handleSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMessageLimit(MESSAGE_PAGE_SIZE);
      void markAsRead(id).catch(handleApiError);
    },
    [markAsRead, handleApiError],
  );

  const invalidateConversation = useCallback(async () => {
    if (!selectedId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.conversation(selectedId) }),
      queryClient.invalidateQueries({ queryKey: queryScopes.conversations }),
    ]);
  }, [queryClient, selectedId]);

  const sendMessage = useMutation({
    mutationFn: (content: string) =>
      api.conversations.sendMessage(selectedId as string, { content, messageType: 'text' }),
    onSuccess: invalidateConversation,
    onError: handleApiError,
  });

  const archive = useMutation({
    mutationFn: () => api.conversations.archive(selectedId as string),
    onSuccess: async () => {
      toast('Conversa arquivada.', { tone: 'positive' });
      setSelectedId(null);
      await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    },
    onError: handleApiError,
  });

  /**
   * "Transferir" na distribuição manual (PAGES.md §10) é devolver a conversa
   * para a fila livre — de lá qualquer atendente assume. Quando a conversa JÁ
   * está na fila, o mesmo botão vira "Assumir".
   */
  const isMine = conversation?.assignedTo != null && conversation.assignedTo === currentUser?.id;
  const transfer = useMutation({
    mutationFn: () =>
      api.conversations.assign(selectedId as string, isMine ? null : (currentUser?.id ?? null)),
    onSuccess: async () => {
      toast(isMine ? 'Conversa devolvida à fila.' : 'Conversa atribuída a você.', {
        tone: 'positive',
      });
      await invalidateConversation();
    },
    onError: handleApiError,
  });

  return (
    <InboxLayout
      list={
        <ConversationList
          conversations={listQuery.data?.conversations ?? []}
          counts={listQuery.data?.counts}
          scope={scope}
          onScopeChange={setScope}
          onSearch={setSearch}
          selectedId={selectedId}
          onSelect={handleSelect}
          isLoading={listQuery.isPending}
          isError={listQuery.isError}
          onRetry={() => void listQuery.refetch()}
        />
      }
      conversation={
        <ConversationPanel
          conversation={conversation}
          messages={messages}
          isLoading={selectedId !== null && detailQuery.isPending}
          isError={detailQuery.isError}
          onRetry={() => void detailQuery.refetch()}
          onSend={(content) => sendMessage.mutate(content)}
          sending={sendMessage.isPending}
          onTransfer={() => transfer.mutate()}
          transferLabel={isMine ? 'Transferir' : 'Assumir'}
          onNewBudget={() => navigate(`/budget/new?conversationId=${selectedId ?? ''}`)}
          onArchive={() => archive.mutate()}
          onToggleContext={toggleContextPanel}
          onAttach={() =>
            toast('Anexos chegam com a integração de mídia do WhatsApp.', { tone: 'neutral' })
          }
          contextOpen={contextOpen}
          hasOlderMessages={!loadedAll}
          onLoadOlder={() => setMessageLimit((limit) => limit + MESSAGE_PAGE_SIZE)}
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
    />
  );
}

export default Attendance;
