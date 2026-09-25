import { useEffect, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { Conversation, PatientListItem } from '@crm-lab/shared';
import { Button, Chip, SearchInput, Tooltip, cn } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { ConversationItem } from '@/components/conversation';
import { NewConversationModal } from './NewConversationModal';
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
 *
 * No topo, o "+" de **Nova conversa** (CRMLAB-50, D-175), padrão WhatsApp Web,
 * também no atalho Ctrl+Alt+N. O modal cuida do envio; aqui só se abre e, no
 * fim, a conversa criada/reaproveitada é selecionada pelo mesmo `onSelect` do
 * clique na fila.
 */

/**
 * Chip ligado na coluna. `mine`/`unassigned`/`all` são o `scope` de
 * `ListConversationsQuery` sobre as ATIVAS (`all` = nenhum chip ligado);
 * `closed` é a lista das encerradas (D-174), `?status=closed`.
 */
export type ConversationScope = 'mine' | 'unassigned' | 'all' | 'closed';

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
  /** Fixar/desafixar (Onda 8 §2.3) — recebe o estado NOVO. */
  onTogglePin: (id: string, pinned: boolean) => void;
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
  onTogglePin,
  patients,
  patientsLoading,
  patientsError,
}: ConversationListProps) {
  /** Clicar no chip ligado desliga o filtro (volta a ver tudo). */
  const toggle = (next: Exclude<ConversationScope, 'all'>) =>
    onScopeChange(scope === next ? 'all' : next);

  const [newConversationOpen, setNewConversationOpen] = useState(false);

  /** Ctrl+Alt+N abre a Nova conversa de qualquer ponto da tela. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.altKey) return;
      if (event.code !== 'KeyN' && event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      setNewConversationOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-md border-b border-neutral-300 px-lg py-lg">
        <div className="flex items-center justify-between gap-sm">
          <h2 className="font-heading text-body font-semibold text-text">Conversas</h2>
          <Tooltip content="Nova conversa (Ctrl+Alt+N)" placement="bottom">
            <button
              type="button"
              aria-label="Nova conversa"
              aria-keyshortcuts="Control+Alt+N"
              onClick={() => setNewConversationOpen(true)}
              className={cn(
                'flex h-[32px] w-[32px] cursor-pointer items-center justify-center',
                'rounded-pill border-none bg-transparent text-neutral-700',
                'hover:bg-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500',
              )}
            >
              <MessageSquarePlus size={20} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-sm overflow-x-auto">
          {/*
            O tom SEGUE a seleção: filtro ligado fica colorido, desligado fica
            cinza (`inactive` é, por definição do Chip, "filtro desligado").
            Antes o tom era fixo — "Minhas" nascia colorida e "Não atribuídas"
            cinza o tempo todo, então trocar de aba não mudava nada na tela e a
            aba desligada parecia a ligada.
          */}
          <Chip
            tone={scope === 'mine' ? 'attention' : 'inactive'}
            selected={scope === 'mine'}
            onClick={() => toggle('mine')}
            title="Conversas atribuídas a você"
          >
            {`Minhas ${counts?.mine ?? 0}`}
          </Chip>
          <Chip
            tone={scope === 'unassigned' ? 'attention' : 'inactive'}
            selected={scope === 'unassigned'}
            onClick={() => toggle('unassigned')}
            title="Fila livre — ninguém assumiu ainda"
          >
            {`Não atribuídas ${counts?.unassigned ?? 0}`}
          </Chip>
          {/* Sem número: o chip existe para ACHAR uma encerrada, não para medir fila. */}
          <Chip
            tone={scope === 'closed' ? 'attention' : 'inactive'}
            selected={scope === 'closed'}
            onClick={() => toggle('closed')}
            title="Atendimentos encerrados — voltam para a fila quando o paciente escreve"
          >
            Encerradas
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
              onTogglePin={onTogglePin}
            />
          ))}
      </div>

      <PatientResults
        term={searchTerm}
        patients={patients}
        isLoading={patientsLoading}
        isError={patientsError}
      />

      {newConversationOpen && (
        <NewConversationModal onClose={() => setNewConversationOpen(false)} onStarted={onSelect} />
      )}
    </div>
  );
}
