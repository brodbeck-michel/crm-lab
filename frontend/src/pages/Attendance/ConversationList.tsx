import { useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import {
  responseAlertMinutes,
  type Conversation,
  type MessageSearchHit,
  type PatientListItem,
  type ResponseAlertCalendar,
  type ResponseAlertRules,
} from '@crm-lab/shared';
import { Button, Chip, SearchInput, Tooltip, cn } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { ConversationItem } from '@/components/conversation';
import { MessageResults } from './MessageResults';
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
 * Alerta de tempo de resposta (CRMLAB-84, D-254): com a regra ligada e o
 * calendário útil carregado, cada item ganha os minutos ÚTEIS de espera
 * (`responseAlertMinutes`), recalculados num relógio local a cada
 * `RESPONSE_ALERT_TICK_MS` — sem refazer a busca. O chip "Aguardando resposta"
 * conta e filtra NO CLIENTE, sobre a página carregada (decisão do Michel:
 * conversa fora da página não entra); combina com "Minhas"/"Não atribuídas".
 *
 * No topo, o "+" de **Nova conversa** (CRMLAB-50, D-175), padrão WhatsApp Web,
 * também no atalho Ctrl+Alt+N. O modal cuida do envio; aqui só se abre e, no
 * fim, a conversa criada/reaproveitada é selecionada pelo mesmo `onSelect` do
 * clique na fila.
 */

/**
 * Chip ligado na coluna. `mine`/`unassigned`/`all` são o `scope` de
 * `ListConversationsQuery` sobre as ATIVAS (`all` = nenhum chip ligado);
 * `closed` é a lista das encerradas (D-174), `?status=closed`. Sem chip
 * "Não lidas" (D-229 item 5, retirado a pedido do Michel): a API mantém `?unread=true`.
 */
export type ConversationScope = 'mine' | 'unassigned' | 'all' | 'closed';

/** Relógio do alerta de tempo de resposta (D-254). */
export const RESPONSE_ALERT_TICK_MS = 30_000;

/** Regra + calendário do alerta. `calendar: null` = ainda carregando: nada acende. */
export interface ConversationResponseAlert {
  rule: ResponseAlertRules;
  calendar: ResponseAlertCalendar | null;
}

/** `Date` que anda sozinho a cada `intervalMs` enquanto `enabled`. */
function useTickingNow(enabled: boolean, intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}

export interface ConversationListProps {
  conversations: Conversation[];
  counts: { mine: number; unassigned: number; unread?: number } | undefined;
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
  /** Termo da busca nas mensagens (D-228); vazio = o bloco "Mensagens" não existe. */
  messageTerm?: string;
  messageHits?: MessageSearchHit[];
  messagesLoading?: boolean;
  messagesError?: boolean;
  /** Clique num resultado: abre a conversa na mensagem (D-230). */
  onOpenMessage?: (hit: MessageSearchHit) => void;
  /** "Marcar como não lida" no menu do item (D-229). */
  onMarkUnread?: (id: string) => void;
  /** Alerta de tempo de resposta (D-254). Ausente ou regra desligada = sem destaque nem chip. */
  responseAlert?: ConversationResponseAlert;
  /** Injetável para teste determinístico do alerta; sem ele, relógio local. */
  now?: Date;
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
  messageTerm = '',
  messageHits = [],
  messagesLoading = false,
  messagesError = false,
  onOpenMessage,
  onMarkUnread,
  responseAlert,
  now: fixedNow,
}: ConversationListProps) {
  const showMessages = messageTerm.length > 0 && onOpenMessage !== undefined;
  /** Clicar no chip ligado desliga o filtro (volta a ver tudo). */
  const toggle = (next: Exclude<ConversationScope, 'all'>) =>
    onScopeChange(scope === next ? 'all' : next);

  const [newConversationOpen, setNewConversationOpen] = useState(false);

  // Alerta de tempo de resposta (D-254). Encerradas nunca entram (o cálculo já
  // devolve `null`), então o chip some na lista de encerradas.
  const alertActive =
    responseAlert !== undefined &&
    responseAlert.rule.enabled &&
    responseAlert.calendar !== null &&
    scope !== 'closed';
  const tickingNow = useTickingNow(alertActive && fixedNow === undefined, RESPONSE_ALERT_TICK_MS);
  const now = fixedNow ?? tickingNow;
  const alertMinutes = useMemo(() => {
    const out = new Map<string, number>();
    if (!alertActive || !responseAlert?.calendar) return out;
    for (const conversation of conversations) {
      const minutes = responseAlertMinutes(
        conversation,
        responseAlert.rule,
        responseAlert.calendar,
        now,
      );
      if (minutes !== null) out.set(conversation.id, minutes);
    }
    return out;
  }, [alertActive, responseAlert, conversations, now]);
  const [awaitingOnly, setAwaitingOnly] = useState(false);
  const filterAwaiting = alertActive && awaitingOnly;
  const shown = filterAwaiting
    ? conversations.filter((conversation) => alertMinutes.has(conversation.id))
    : conversations;

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
    // Coluna branca, visual WhatsApp Web (CRMLAB-81, D-251).
    <div className="flex min-h-0 flex-1 flex-col bg-chat-panel">
      <div className="flex flex-col gap-md border-b border-chat-line px-lg py-lg">
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
          {alertActive && (
            <Chip
              tone={filterAwaiting ? 'attention' : 'inactive'}
              selected={filterAwaiting}
              onClick={() => setAwaitingOnly((value) => !value)}
              title={`Pacientes esperando resposta há ${responseAlert?.rule.minutes ?? 0} min ou mais (horário de atendimento) — nesta lista`}
            >
              {`Aguardando resposta ${alertMinutes.size}`}
            </Chip>
          )}
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

        {/* Buscando, a falta de conversa por nome não é "vazio" se houver mensagem achada. */}
        {!isLoading && !isError && shown.length === 0 && showMessages && (
          <p className="m-0 px-sm py-sm text-caption text-neutral-600">
            Nenhuma conversa com esse nome ou telefone.
          </p>
        )}

        {!isLoading && !isError && shown.length === 0 && !showMessages && (
          <EmptyState
            message={filterAwaiting ? 'Ninguém aguardando resposta' : 'Nenhuma conversa por aqui'}
            hint={
              filterAwaiting
                ? 'Todos os pacientes desta lista foram respondidos a tempo.'
                : 'Ajuste os filtros ou aguarde a próxima mensagem.'
            }
          />
        )}

        {!isLoading &&
          !isError &&
          shown.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedId}
              onClick={onSelect}
              onTogglePin={onTogglePin}
              onMarkUnread={onMarkUnread}
              responseAlertMinutes={alertMinutes.get(conversation.id) ?? null}
            />
          ))}

        {showMessages && onOpenMessage && (
          <MessageResults
            term={messageTerm}
            hits={messageHits}
            isLoading={messagesLoading}
            isError={messagesError}
            onOpen={onOpenMessage}
          />
        )}
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
