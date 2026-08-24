import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import { Button } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import { Composer, MessageBubble, bubbleTypeFor } from '@/components/conversation';

/**
 * Coluna 2 do inbox — PAGES.md §2.
 *
 * Header (nome, telefone, ações) · bolhas · composer.
 * Rolagem: mensagem nova rola para o fim; carregar histórico antigo mantém a
 * posição de leitura (ver `useMessageScroll`).
 */

export interface ConversationPanelProps {
  conversation: ConversationDetail | null;
  messages: Message[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onSend: (content: string) => void;
  sending: boolean;
  onTransfer: () => void;
  /** "Transferir" quando é sua; "Assumir" quando está na fila livre. */
  transferLabel: string;
  onNewBudget: () => void;
  onArchive: () => void;
  onToggleContext: () => void;
  /** Anexo no composer. */
  onAttach: () => void;
  contextOpen: boolean;
  /** Ainda há mensagens anteriores no servidor. */
  hasOlderMessages: boolean;
  onLoadOlder: () => void;
}

/**
 * Mensagem nova (o ÚLTIMO id mudou) → rola para o fim.
 * Histórico antigo (o último id continua o mesmo e a altura cresceu) → soma a
 * diferença ao `scrollTop`, mantendo sob os olhos a mesma mensagem.
 */
function useMessageScroll(
  ref: RefObject<HTMLDivElement>,
  messages: Message[],
  conversationId: string | null,
): void {
  const lastIdRef = useRef<string | null>(null);
  const heightRef = useRef(0);
  const conversationRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const lastId = messages.at(-1)?.id ?? null;
    const switchedConversation = conversationRef.current !== conversationId;

    if (switchedConversation || lastId !== lastIdRef.current) {
      element.scrollTop = element.scrollHeight;
    } else if (element.scrollHeight > heightRef.current) {
      element.scrollTop += element.scrollHeight - heightRef.current;
    }

    lastIdRef.current = lastId;
    heightRef.current = element.scrollHeight;
    conversationRef.current = conversationId;
  }, [ref, messages, conversationId]);
}

export function ConversationPanel({
  conversation,
  messages,
  isLoading,
  isError,
  onRetry,
  onSend,
  sending,
  onTransfer,
  transferLabel,
  onNewBudget,
  onArchive,
  onToggleContext,
  onAttach,
  contextOpen,
  hasOlderMessages,
  onLoadOlder,
}: ConversationPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useMessageScroll(scrollRef, messages, conversation?.id ?? null);

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          message="Não foi possível carregar a conversa"
          hint="A conexão pode ter caído no meio do caminho."
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          }
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p role="status" className="text-caption text-neutral-600">
          Carregando conversa…
        </p>
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          message="Selecione uma conversa"
          hint="A fila da esquerda mostra quem está esperando resposta."
        />
      </div>
    );
  }

  const archived = conversation.status !== 'active';

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg">
      <header className="flex items-center gap-md border-b border-neutral-300 px-lg py-md">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-body text-label font-semibold text-text">
            {conversation.patientName ?? conversation.patientPhone}
          </span>
          <span className="truncate font-body text-caption text-neutral-600">
            {conversation.patientPhone}
          </span>
        </div>

        <div className="flex flex-[0_0_auto] items-center gap-sm">
          <Button variant="secondary" size="sm" onClick={onTransfer}>
            {transferLabel}
          </Button>
          <Button size="sm" onClick={onNewBudget}>
            Novo Orçamento
          </Button>
          <Button variant="destructive" size="sm" onClick={onArchive} disabled={archived}>
            Arquivar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onToggleContext}
            aria-pressed={contextOpen}
            aria-label={contextOpen ? 'Ocultar contexto do paciente' : 'Mostrar contexto do paciente'}
          >
            Contexto
          </Button>
        </div>
      </header>

      <div
        ref={scrollRef}
        data-testid="message-scroll"
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
            hint="Escreva a primeira mensagem para começar o atendimento."
          />
        ) : (
          messages.map((message) => (
            <MessageBubble
              key={message.id}
              type={bubbleTypeFor(message.senderType)}
              message={message}
            />
          ))
        )}
      </div>

      <Composer onSend={onSend} onAttach={onAttach} sending={sending} disabled={archived} />
    </div>
  );
}
