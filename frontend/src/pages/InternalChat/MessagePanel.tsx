import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Channel, InternalMessage, UserRole } from '@crm-lab/shared';
import { Button } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { Composer } from '@/components/conversation';
import { InternalMessageItem } from './InternalMessageItem';

/**
 * Coluna 2 do Chat Interno — cabeçalho do canal · mensagens · composer.
 * Reaproveita o `Composer` do inbox (Enter envia, Shift+Enter quebra linha).
 */

export interface MessagePanelProps {
  channel: Channel | null;
  messages: InternalMessage[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSend: (content: string) => void;
  sending: boolean;
  currentUserId: string | null;
  currentUserRole: UserRole | null;
  /** Ainda há mensagens anteriores no servidor. */
  hasOlderMessages: boolean;
  onLoadOlder: () => void;
}

/** Chave do canal em que o sistema posta os pedidos (WORKFLOWS.md §3 e §6). */
export const APPROVALS_CHANNEL_KEY = 'aprovacoes';

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-center justify-center">{children}</div>;
}

export function MessagePanel({
  channel,
  messages,
  isLoading,
  isError,
  onRetry,
  onSend,
  sending,
  currentUserId,
  currentUserRole,
  hasOlderMessages,
  onLoadOlder,
}: MessagePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Mensagem nova rola para o fim. */
  const lastId = messages.at(-1)?.id ?? null;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lastId, channel?.id]);

  if (isError) {
    return (
      <Centered>
        <EmptyState
          message="Não foi possível carregar o canal"
          hint="A conexão pode ter caído no meio do caminho."
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          }
        />
      </Centered>
    );
  }

  if (isLoading) {
    return (
      <Centered>
        <p role="status" className="m-0 font-body text-caption text-neutral-600">
          Carregando mensagens…
        </p>
      </Centered>
    );
  }

  if (!channel) {
    return (
      <Centered>
        <EmptyState
          message="Selecione um canal"
          hint="À esquerda ficam os canais da equipe e as mensagens diretas."
        />
      </Centered>
    );
  }

  const isApprovalsChannel = channel.key === APPROVALS_CHANNEL_KEY;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex items-center gap-md border-b border-neutral-300 px-lg py-md">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-body text-label font-semibold text-text">
            {channel.name}
          </span>
          <span className="truncate font-body text-caption text-neutral-600">
            {isApprovalsChannel
              ? 'Pedidos de aprovação de desconto acima da alçada'
              : channel.kind === 'dm'
                ? 'Mensagem direta'
                : 'Canal da equipe'}
          </span>
        </div>
      </header>

      <div
        ref={scrollRef}
        data-testid="internal-message-scroll"
        className="flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto px-lg py-lg"
      >
        {hasOlderMessages && (
          <div className="flex flex-[0_0_auto] justify-center pb-sm">
            <Button variant="secondary" size="sm" onClick={onLoadOlder}>
              Carregar mensagens anteriores
            </Button>
          </div>
        )}

        {messages.length === 0 ? (
          <EmptyState
            message="Nenhuma mensagem ainda"
            hint="Escreva a primeira mensagem deste canal."
          />
        ) : (
          messages.map((message) => (
            <InternalMessageItem
              key={message.id}
              message={message}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              isApprovalsChannel={isApprovalsChannel}
            />
          ))
        )}
      </div>

      <Composer onSend={onSend} sending={sending} placeholder="Escreva para a equipe" />
    </div>
  );
}
