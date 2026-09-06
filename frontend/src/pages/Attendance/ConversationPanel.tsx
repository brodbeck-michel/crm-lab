import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ConversationAssignee, ConversationDetail, Message } from '@crm-lab/shared';
import { Button, cn } from '@/components/ui';
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
  /** Quem pode receber a conversa — `GET /conversations/assignees`. */
  assignees: ConversationAssignee[];
  /** Atendente escolhida no menu, ou `null` para devolver à fila. */
  onAssign: (userId: string | null) => void;
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

/**
 * Menu "Transferir" — a lista de colegas + "Devolver para a fila"
 * (spec Onda 8 §2.1). Quem já é dona da conversa não aparece na lista: a opção
 * seria um no-op com cara de ação.
 *
 * rangel: mesmo padrão do menu do usuário na `Sidebar` (clique fora + Esc,
 * `role="menu"`), sem biblioteca de popover para dois itens.
 */
function TransferMenu({
  assignees,
  assignedTo,
  onAssign,
}: {
  assignees: ConversationAssignee[];
  assignedTo: string | null;
  onAssign: (userId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // rangel: o gatilho é o primeiro <button> do bloco — `Button` não
      // encaminha ref, e um forwardRef só para isto seria mudança de API.
      ref.current?.querySelector('button')?.focus();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function choose(userId: string | null): void {
    setOpen(false);
    onAssign(userId);
  }

  const options = assignees.filter((assignee) => assignee.id !== assignedTo);

  return (
    <div ref={ref} className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {assignedTo === null ? 'Atribuir' : 'Transferir'}
      </Button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute right-0 top-full z-50 mt-xs max-h-[280px] w-[220px] overflow-y-auto',
            'rounded-md border border-neutral-200 bg-surface py-xs shadow-md',
          )}
        >
          {options.length === 0 && (
            <p className="px-md py-xs font-body text-caption text-neutral-600">
              Ninguém mais para receber esta conversa.
            </p>
          )}

          {options.map((assignee) => (
            <button
              key={assignee.id}
              type="button"
              role="menuitem"
              onClick={() => choose(assignee.id)}
              className="w-full cursor-pointer border-none bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100"
            >
              {assignee.name}
            </button>
          ))}

          {assignedTo !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => choose(null)}
              className="w-full cursor-pointer border-t border-neutral-200 bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100"
            >
              Devolver para a fila
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ConversationPanel({
  conversation,
  messages,
  isLoading,
  isError,
  onRetry,
  onSend,
  sending,
  assignees,
  onAssign,
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
          <TransferMenu
            assignees={assignees}
            assignedTo={conversation.assignedTo}
            onAssign={onAssign}
          />
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
