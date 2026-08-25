import type { Conversation, PatientListItem } from '@crm-lab/shared';
import { Button, Chip, SearchInput } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { ConversationItem } from '@/components/conversation';
import { PatientResults } from './PatientResults';

/**
 * Coluna 1 do inbox (336px) — PAGES.md §2.
 *
 * Filtros em chips + busca em pílula + lista de `ConversationItem`.
 * As contagens vêm de `counts` da resposta (`ListConversationsResponse`):
 * derivadas no servidor, nunca contadas no cliente
 * (FRONTEND_BACKEND.md §5).
 *
 * A MESMA busca alimenta duas listas (D-079): as conversas (`GET /conversations`)
 * e os pacientes (`GET /patients`, §2c — "a tela chega aqui pela busca do
 * inbox"). Sem termo digitado o bloco de pacientes não existe.
 */

/** `scope` de `ListConversationsQuery`. `all` = nenhum chip ligado. */
export type ConversationScope = 'mine' | 'unassigned' | 'all';

export interface ConversationListProps {
  conversations: Conversation[];
  counts: { mine: number; unassigned: number } | undefined;
  scope: ConversationScope;
  onScopeChange: (scope: ConversationScope) => void;
  onSearch: (term: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Termo em vigor — o bloco de pacientes só aparece quando há busca. */
  searchTerm: string;
  patients: PatientListItem[];
  patientsLoading: boolean;
  patientsError: boolean;
}

export function ConversationList({
  conversations,
  counts,
  scope,
  onScopeChange,
  onSearch,
  selectedId,
  onSelect,
  isLoading,
  isError,
  onRetry,
  searchTerm,
  patients,
  patientsLoading,
  patientsError,
}: ConversationListProps) {
  /** Clicar no chip ligado desliga o filtro (volta a ver tudo). */
  const toggle = (next: Exclude<ConversationScope, 'all'>) =>
    onScopeChange(scope === next ? 'all' : next);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-md border-b border-neutral-300 px-lg py-lg">
        <div className="flex items-center gap-sm overflow-x-auto">
          <Chip
            tone="attention"
            selected={scope === 'mine'}
            onClick={() => toggle('mine')}
            title="Conversas atribuídas a você"
          >
            {`Minhas ${counts?.mine ?? 0}`}
          </Chip>
          <Chip
            tone="inactive"
            selected={scope === 'unassigned'}
            onClick={() => toggle('unassigned')}
            title="Fila livre — ninguém assumiu ainda"
          >
            {`Não atribuídas ${counts?.unassigned ?? 0}`}
          </Chip>
        </div>

        <SearchInput
          placeholder="Buscar paciente, telefone ou exame"
          aria-label="Buscar paciente, telefone ou exame"
          onSearch={onSearch}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-xs overflow-y-auto px-sm py-sm">
        {isLoading && (
          <p role="status" className="px-lg py-lg text-center text-caption text-neutral-600">
            Carregando conversas…
          </p>
        )}

        {!isLoading && isError && (
          <EmptyState
            message="Não foi possível carregar as conversas"
            hint="Verifique a conexão e tente de novo."
            action={
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Tentar novamente
              </Button>
            }
          />
        )}

        {!isLoading && !isError && conversations.length === 0 && (
          <EmptyState
            message="Nenhuma conversa por aqui"
            hint="Ajuste os filtros ou aguarde a próxima mensagem."
          />
        )}

        {!isLoading &&
          !isError &&
          conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedId}
              onClick={onSelect}
            />
          ))}
      </div>

      <PatientResults
        term={searchTerm}
        patients={patients}
        isLoading={patientsLoading}
        isError={patientsError}
      />
    </div>
  );
}
