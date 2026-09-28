import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import type {
  ConversationAssignee,
  ConversationDetail,
  Message,
  QuickReply,
} from '@crm-lab/shared';
import { Badge, Button, cn } from '@/components/ui';
import { EmptyState } from '@/components/shared';
import {
  Composer,
  DateSeparator,
  MessageBubble,
  bubbleTypeFor,
  isSameLocalDay,
} from '@/components/conversation';
import type { RecordedAudio } from '@/components/conversation';
import { useConversationScroll } from './useConversationScroll';

/**
 * Coluna 2 do inbox — PAGES.md §2.
 *
 * Header (nome, telefone, ações) · bolhas · composer.
 * A área das bolhas é BRANCA (CRMLAB-25) — só ela; header e composer seguem no
 * fundo do tema, o que também marca onde a conversa começa e termina.
 * Leitura padrão WhatsApp Web (CRMLAB-71, D-238/D-239): separador de data,
 * faixa "N mensagens não lidas", botão ↓ com contador e histórico que carrega
 * sozinho perto do topo — a rolagem mora em `useConversationScroll`.
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
  /** Ausente = sem "Novo Orçamento" (origem manual desligada nas Regras, D-193). */
  onNewBudget?: () => void;
  /** Encerrar atendimento (D-174). */
  onCloseAttendance: () => void;
  /** Dona, gestor ou admin — o backend valida de novo; aqui é só UX. */
  canCloseAttendance: boolean;
  onToggleContext: () => void;
  /** Fecha a conversa aberta, voltando ao estado "nenhuma selecionada" (padrão WhatsApp Web). */
  onClose: () => void;
  /** Anexo no composer. */
  onAttach: () => void;
  /** Recado de voz gravado no composer (CRMLAB-24) — ver `Composer.onSendAudio`. */
  onSendAudio?: (audio: RecordedAudio) => Promise<unknown>;
  /** Macros do laboratório — a `/` do composer (Onda 8 §3.4). */
  quickReplies: QuickReply[];
  contextOpen: boolean;
  /** Ainda há mensagens anteriores no servidor (`cursors.before` não nulo). */
  hasOlderMessages: boolean;
  /** Página anterior sendo buscada — mostra o indicador e segura novo pedido. */
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /**
   * `unreadCount` da LISTA no clique que abriu a conversa (D-239): o GET do
   * detalhe já zerou o contador quando o painel lê a conversa.
   */
  unreadAtOpen: number;
  /** Mensagem pronta ao chegar aqui por "Enviar orçamento" (ver `Composer.initialValue`). */
  draftMessage?: string;
}

/**
 * A lista encolheu ou cresceu porque o Composer mudou de altura (CRMLAB-49) →
 * a BORDA DE BAIXO fica parada, como no WhatsApp Web: a mensagem que estava
 * logo acima do campo continua lá. Sem isso o `scrollTop` fica igual e as
 * últimas mensagens somem atrás do campo que cresceu.
 *
 * `mounted` porque a lista só existe fora dos estados de carregando/erro/vazio;
 * sem ele o efeito rodaria uma vez com o ref nulo e nunca mais.
 */
function useBottomAnchor(ref: RefObject<HTMLDivElement>, mounted: boolean): void {
  useEffect(() => {
    const element = ref.current;
    // jsdom não tem ResizeObserver; no navegador ele sempre existe.
    if (!mounted || !element || typeof ResizeObserver === 'undefined') return;

    let previous = element.clientHeight;
    const observer = new ResizeObserver(() => {
      const current = element.clientHeight;
      element.scrollTop += previous - current;
      previous = current;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, mounted]);
}

/**
 * Faixa de não lidas (D-239): presa à N-ésima mensagem do PACIENTE contando do
 * fim (só elas somam em `unread_count`). N maior que o carregado: antes da
 * primeira mensagem carregada, com o N verdadeiro.
 */
interface UnreadMark {
  conversationId: string;
  /** `null` = sem faixa (nada não lido, ou a atendente já respondeu). */
  messageId: string | null;
  count: number;
}

function unreadMarkFor(conversationId: string, messages: Message[], count: number): UnreadMark {
  if (count <= 0) return { conversationId, messageId: null, count: 0 };
  let seen = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate?.senderType !== 'patient') continue;
    seen += 1;
    if (seen === count) return { conversationId, messageId: candidate.id, count };
  }
  return { conversationId, messageId: messages[0]?.id ?? null, count };
}

function unreadLabel(count: number): string {
  return count === 1 ? '1 mensagem não lida' : `${count} mensagens não lidas`;
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
  onCloseAttendance,
  canCloseAttendance,
  onToggleContext,
  onClose,
  onAttach,
  onSendAudio,
  quickReplies,
  contextOpen,
  hasOlderMessages,
  loadingOlder,
  onLoadOlder,
  unreadAtOpen,
  draftMessage,
}: ConversationPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const conversationId = conversation?.id ?? null;

  // Calculada UMA vez por conversa aberta, na primeira leitura com mensagens:
  // mensagem nova não desloca a faixa. `setState` no render é o padrão do
  // React para estado derivado — o commit já sai com a faixa, e a rolagem de
  // abertura acha o `dividerRef`.
  const [mark, setMark] = useState<UnreadMark | null>(null);
  if (conversationId !== null && messages.length > 0 && mark?.conversationId !== conversationId) {
    setMark(unreadMarkFor(conversationId, messages, unreadAtOpen));
  }
  const unread = mark?.conversationId === conversationId ? mark : null;

  const scroll = useConversationScroll({
    scrollRef,
    messages,
    conversationId,
    dividerRef,
    canLoadOlder: hasOlderMessages && !loadingOlder,
    onLoadOlder,
  });
  useBottomAnchor(scrollRef, !isError && !isLoading && conversation !== null);

  /** A atendente respondeu: a faixa sai e a resposta aparece no fim (D-239). */
  function beforeReply(): void {
    if (conversationId !== null) setMark({ conversationId, messageId: null, count: 0 });
    scroll.stickOnNextMessage();
    scroll.jumpToBottom('auto');
  }

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

  const closed = conversation.status !== 'active';

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
          {onNewBudget && (
            <Button size="sm" onClick={onNewBudget}>
              Novo Orçamento
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={onCloseAttendance}
            disabled={closed || !canCloseAttendance}
            title={
              closed
                ? 'Atendimento já encerrado'
                : canCloseAttendance
                  ? 'Encerrar o atendimento — sai da fila até o paciente escrever de novo'
                  : 'Só a responsável pela conversa, gestor ou admin encerram'
            }
          >
            Encerrar
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar conversa"
            className={cn(
              'flex h-[28px] w-[28px] flex-[0_0_28px] cursor-pointer items-center justify-center',
              'rounded-pill border-none bg-transparent font-body text-neutral-700 hover:bg-neutral-200',
            )}
          >
            ×
          </button>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          data-testid="message-scroll"
          onScroll={scroll.onScroll}
          className="relative flex min-h-0 flex-1 flex-col gap-sm overflow-y-auto bg-chat-bg px-lg py-lg [overflow-anchor:none]"
        >
          {messages.length === 0 ? (
            <EmptyState
              message="Nenhuma mensagem ainda"
              hint="Escreva a primeira mensagem para começar o atendimento."
            />
          ) : (
            renderRows(messages, unread, dividerRef)
          )}
        </div>

        {/* Fora da área rolável: dentro dela, o indicador empurraria as mensagens
            e a tela pularia justamente enquanto o histórico carrega (D-238). */}
        {loadingOlder && (
          <p
            role="status"
            className="pointer-events-none absolute left-0 right-0 top-sm m-0 flex justify-center"
          >
            <span className="rounded-pill bg-surface px-md py-xs font-body text-caption text-neutral-600 shadow-sm">
              Carregando mensagens anteriores…
            </span>
          </p>
        )}

        {scroll.showJumpButton && (
          <button
            type="button"
            onClick={() => scroll.jumpToBottom()}
            aria-label={
              scroll.newCount > 0
                ? `Ir para a última mensagem (${scroll.newCount} ${scroll.newCount === 1 ? 'nova' : 'novas'})`
                : 'Ir para a última mensagem'
            }
            className={cn(
              'absolute bottom-md right-lg flex h-[40px] w-[40px] cursor-pointer items-center justify-center',
              'rounded-pill border border-neutral-200 bg-surface font-body text-label text-neutral-700 shadow-md',
              'hover:bg-neutral-100',
            )}
          >
            ↓
            {scroll.newCount > 0 && (
              <span className="absolute -right-xs -top-xs">
                <Badge count={scroll.newCount} />
              </span>
            )}
          </button>
        )}
      </div>

      {/* Um Composer POR conversa (D-181): trocar de conversa cancela a gravação
          e solta o microfone — o recado feito para um paciente não vai para outro. */}
      <Composer
        key={conversation.id}
        onSend={(content) => {
          beforeReply();
          onSend(content);
        }}
        onAttach={() => {
          beforeReply();
          onAttach();
        }}
        onSendAudio={
          onSendAudio
            ? (audio) => {
                beforeReply();
                return onSendAudio(audio);
              }
            : undefined
        }
        sending={sending}
        disabled={closed}
        quickReplies={quickReplies}
        initialValue={draftMessage}
      />
    </div>
  );
}

/**
 * Linhas da conversa: separador de dia (D-239), faixa de não lidas e a bolha.
 * Cada bolha vai numa linha com `data-anchor-id` — é nela que a rolagem se
 * ancora (D-238). O `data-message-id` do balão é do `MessageBubble`.
 */
function renderRows(
  messages: Message[],
  unread: UnreadMark | null,
  dividerRef: RefObject<HTMLDivElement>,
): ReactNode[] {
  const now = new Date();
  const nodes: ReactNode[] = [];
  let previous: Message | undefined;

  for (const message of messages) {
    const day = new Date(message.createdAt);
    if (!previous || !isSameLocalDay(new Date(previous.createdAt), day)) {
      nodes.push(<DateSeparator key={`day-${message.id}`} date={message.createdAt} now={now} />);
    }
    if (unread?.messageId === message.id) {
      nodes.push(
        <div
          key={`unread-${message.id}`}
          ref={dividerRef}
          data-testid="unread-divider"
          className="-mx-lg flex flex-[0_0_auto] justify-center bg-accent-100 py-xs"
        >
          <span className="font-body text-caption font-semibold text-accent-800">
            {unreadLabel(unread.count)}
          </span>
        </div>,
      );
    }
    nodes.push(
      <div key={message.id} data-anchor-id={message.id} className="flex min-w-0 flex-col">
        <MessageBubble type={bubbleTypeFor(message.senderType)} message={message} />
      </div>,
    );
    previous = message;
  }

  return nodes;
}
