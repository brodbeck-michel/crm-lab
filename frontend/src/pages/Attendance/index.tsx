import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListConversationsQuery, ListPatientsQuery } from '@crm-lab/shared';
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

/** Mínimo de caracteres para a busca de paciente sair (ver `patientsQuery`). */
const PATIENT_SEARCH_MIN = 2;
/** A coluna tem 336px: mais que isto vira rolagem sem ajudar a achar ninguém. */
const PATIENT_RESULT_LIMIT = 5;

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

  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      api.conversations.assign(selectedId as string, userId),
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
          onSend={(content) => sendMessage.mutate(content)}
          sending={sendMessage.isPending}
          assignees={assigneesQuery.data?.assignees ?? []}
          onAssign={(userId) => assign.mutate(userId)}
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
