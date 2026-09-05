import { useMemo } from 'react';
import type { Conversation } from '@crm-lab/shared';
import { Badge, Chip, cn } from '@/components/ui';
import { Avatar, DateDisplay } from '@/components/shared';
import { formatDurationSeconds } from '@/lib/format';

/**
 * ConversationItem — COMPONENTS.md (`conversation/`), anatomia padrão WhatsApp.
 *
 *  - Avatar 36px com iniciais, `flex: 0 0 36px` (o primitivo já garante);
 *  - nome 13.5px/600 + hora à direita — sálvia-700 quando há não lidas,
 *    cinza quando está lido;
 *  - prévia truncada em UMA linha com elipse;
 *  - Badge com a contagem de não lidas (não renderiza com 0);
 *  - chips de status + tempo de espera em accent-700, formatado por
 *    `formatDurationSeconds` (a mesma escala do resto do app): minuto cru
 *    virava "aguardando 57871 min" — ilegivel, e quem le a fila precisa
 *    decidir prioridade de relance, nao fazer divisao mental;
 *  - selecionado: fundo neutral-100 + shadow-sm.
 *
 * Nenhuma busca de dado aqui dentro: recebe `conversation` pronto do
 * TanStack Query.
 */

export interface ConversationItemProps {
  conversation: Conversation;
  selected?: boolean;
  onClick?: (id: string) => void;
  /** Injetável para teste determinístico de "aguardando N min". */
  now?: Date;
}

/** Quantos chips de tag cabem antes de virar "+N". */
const MAX_TAG_CHIPS = 2;

/** Minutos inteiros desde a última mensagem (nunca negativo). */
function minutesWaiting(lastMessageAt: string | null, now: Date): number | null {
  if (!lastMessageAt) return null;
  const elapsed = now.getTime() - new Date(lastMessageAt).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return null;
  return Math.floor(elapsed / 60_000);
}

export function ConversationItem({
  conversation,
  selected = false,
  onClick,
  now,
}: ConversationItemProps) {
  const {
    id,
    patientName,
    patientPhone,
    unreadCount,
    lastMessagePreview,
    lastMessageAt,
    tags,
    status,
  } = conversation;

  const displayName = patientName ?? patientPhone;
  const hasUnread = unreadCount > 0;

  // Estado derivado: useMemo, nunca useEffect (CONVENTIONS.md).
  const waiting = useMemo(
    () => (hasUnread ? minutesWaiting(lastMessageAt, now ?? new Date()) : null),
    [hasUnread, lastMessageAt, now],
  );

  const visibleTags = tags.slice(0, MAX_TAG_CHIPS);
  const hiddenTags = tags.length - visibleTags.length;

  return (
    <button
      type="button"
      data-testid="conversation-item"
      data-selected={selected ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onClick?.(id)}
      className={cn(
        'flex w-full cursor-pointer items-start gap-md rounded-md border-none px-lg py-md text-left',
        'font-body transition-colors hover:bg-accent-100',
        selected ? 'bg-neutral-100 shadow-sm' : 'bg-transparent',
      )}
    >
      <Avatar name={displayName} size={36} />

      <span className="flex min-w-0 flex-1 flex-col gap-xs">
        <span className="flex items-baseline gap-sm">
          <span className="min-w-0 flex-1 truncate text-label font-semibold text-text">
            {displayName}
          </span>
          {lastMessageAt && (
            <span
              data-testid="conversation-time"
              data-unread={hasUnread ? 'true' : 'false'}
              className={cn(
                'flex-[0_0_auto] text-micro tracking-normal',
                hasUnread ? 'font-bold text-accent2-700' : 'font-normal text-neutral-600',
              )}
            >
              <DateDisplay value={lastMessageAt} variant="relative" />
            </span>
          )}
        </span>

        <span className="flex items-center gap-sm">
          <span
            data-testid="conversation-preview"
            className="min-w-0 flex-1 truncate text-caption text-neutral-700"
          >
            {lastMessagePreview ?? 'Sem mensagens ainda'}
          </span>
          <Badge
            count={unreadCount}
            label={`${unreadCount} mensagens não lidas`}
          />
        </span>

        {(visibleTags.length > 0 || waiting !== null || status !== 'active') && (
          <span className="flex items-center gap-sm overflow-x-auto">
            {status !== 'active' && (
              <Chip tone="inactive">{status === 'archived' ? 'Arquivada' : 'Encerrada'}</Chip>
            )}
            {visibleTags.map((tag) => (
              <Chip key={tag} tone="positive">
                {tag}
              </Chip>
            ))}
            {hiddenTags > 0 && <Chip tone="inactive">{`+${hiddenTags}`}</Chip>}
            {waiting !== null && (
              <span
                data-testid="conversation-waiting"
                className="flex-[0_0_auto] whitespace-nowrap text-micro font-semibold tracking-normal text-accent-700"
              >
                {`aguardando ${formatDurationSeconds(waiting * 60)}`}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}
