import { useEffect, useRef, useState } from 'react';
import { QUICK_REACTIONS } from '@crm-lab/shared';
import type {
  Message,
  MessageStatus,
  MessageType,
  QuotedMessageSummary,
  SenderType,
} from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { fetchAuthenticatedBlob, resolveMediaUrl } from '@/api';
import { useAuthenticatedMedia } from '@/hooks';
import { DateDisplay } from '@/components/shared';
import { AudioMessage } from './AudioMessage';
import { WhatsAppText } from './WhatsAppText';

/**
 * So a mídia servida pelo NOSSO backend (`/api/v1/media/:id`) exige o fetch
 * autenticado. Um `attachmentUrl` ABSOLUTO de outro host (a URL da Meta que o
 * webhook grava, ou o que vier num `POST /messages`) tem que ir como link/img
 * cru: passar pelo `fetchAuthenticatedBlob` mandava o Bearer do usuário para
 * um terceiro e o CORS ainda bloqueava a resposta — o anexo que antes abria
 * virou "Não foi possível carregar" (revisão do PR #43).
 */
export function isProtectedMediaUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return url.startsWith('/api/');
  try {
    const target = new URL(url);
    return target.origin === window.location.origin && target.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * MessageBubble — COMPONENTS.md (`conversation/`) + DESIGN_TOKENS.md
 * ("Bolhas de mensagem").
 *
 * TRÊS tipos, nunca um quarto. O canto "apontado" (`--radius-sm`) marca a
 * origem: bolha recebida aponta para baixo-esquerda, enviada para
 * baixo-direita, evento de sistema é pílula centrada.
 *
 * Cor (CRMLAB-25): recebida usa `--color-chat-received` (o tom do tema
 * clareado), enviada `--color-chat-sent` (o acento clareado) — as duas sobre o
 * papel BRANCO da conversa. Antes eram `surface` e `accent-200`, ambas
 * misturadas com `--color-bg`: sobre o bege do tema as duas bolhas e o fundo
 * viravam a mesma coisa e não dava para saber quem falou.
 *
 * Largura máxima: 62% no inbox. DESIGN_TOKENS.md publica 78% na regra geral e
 * PAGES.md §2 fixa 62% no inbox — vale o 62% aqui (fonte mais específica,
 * AGENTS.md "Resolução de Conflitos"). Quem precisar da regra geral passa
 * `maxWidth`.
 */

export type MessageBubbleType = 'received' | 'sent' | 'system';

/** Os três tipos que existem. Qualquer outro valor é bug de construção. */
export const MESSAGE_BUBBLE_TYPES: readonly MessageBubbleType[] = [
  'received',
  'sent',
  'system',
] as const;

/** Largura máxima da bolha no inbox (PAGES.md §2). */
export const INBOX_BUBBLE_MAX_WIDTH = '62%';

/** `senderType` da API → tipo de bolha. Único mapeamento; não duplicar em tela. */
export function bubbleTypeFor(senderType: SenderType): MessageBubbleType {
  if (senderType === 'agent') return 'sent';
  if (senderType === 'system') return 'system';
  return 'received';
}

export interface MessageBubbleProps {
  /** `received` (paciente) · `sent` (recepção) · `system` (evento). */
  type: MessageBubbleType;
  message: Message;
  /** Sobrepõe a largura máxima (padrão 62%, o valor do inbox). */
  maxWidth?: string;
  /** Mostra hora e autor abaixo do texto. Padrão `true`. */
  showMeta?: boolean;
  /** Menu › Responder (CRMLAB-66). Sem handler, a ação some. */
  onReply?: (message: Message) => void;
  /**
   * Menu › Reagir (D-222). `null` = tirar a reação do laboratório (clicar no
   * emoji que já é o dele). Sem handler, a ação some.
   */
  onReact?: (message: Message, emoji: string | null) => void;
  /** Clique no bloco citado — o painel rola até a original (D-221). */
  onQuoteClick?: (quotedMessageId: string) => void;
  /** "Tentar de novo" de mensagem `failed` (D-227). Sem handler, o botão some. */
  onRetry?: (message: Message) => void;
  /**
   * Clique na thumbnail (CRMLAB-64, D-244): quem abre o lightbox e navega entre
   * as fotos é o painel. Sem handler, a thumbnail não é clicável.
   */
  onOpenImage?: (message: Message) => void;
}

/** Tique por status (D-225) — glifo, nome acessível e cor (só tokens). */
const STATUS_TICK: Record<MessageStatus, { glyph: string; label: string; className: string }> = {
  pending: { glyph: '🕓', label: 'Enviando', className: 'text-neutral-600' },
  sent: { glyph: '✓', label: 'Enviada', className: 'text-neutral-600' },
  delivered: { glyph: '✓✓', label: 'Entregue', className: 'text-neutral-600' },
  read: { glyph: '✓✓', label: 'Lida', className: 'text-chat-tick-read' },
  failed: { glyph: '⚠', label: 'Falhou', className: 'text-accent-700' },
};

/** O tique da linha da hora — só no balão da atendente (padrão WhatsApp). */
export function MessageStatusTick({ status }: { status: MessageStatus }) {
  // Status fora do contrato (fixture antiga, versão nova do servidor): sem tique.
  const tick = (STATUS_TICK as Partial<typeof STATUS_TICK>)[status];
  if (!tick) return null;
  return (
    <span
      data-testid="message-status"
      data-status={status}
      role="img"
      aria-label={tick.label}
      title={tick.label}
      className={cn('font-semibold tracking-normal', tick.className)}
    >
      {tick.glyph}
    </span>
  );
}

/** Rótulo do bloco citado quando a citada é mídia sem texto. */
const MEDIA_LABEL: Partial<Record<MessageType, string>> = {
  image: '📷 Foto',
  audio: '🎤 Áudio',
  pdf: '📄 Documento',
  doc: '📄 Documento',
};

/** Texto do bloco citado (D-221): trecho, rótulo de mídia ou o aviso de indisponível. */
export function quotedLabel(quoted: QuotedMessageSummary): string {
  if (quoted.deleted) return '🚫 Mensagem apagada';
  if (quoted.id === null) return 'Mensagem original indisponível';
  if (quoted.preview.length > 0) return quoted.preview;
  return (quoted.messageType && MEDIA_LABEL[quoted.messageType]) ?? 'Mensagem';
}

function QuotedBlock({
  quoted,
  onClick,
}: {
  quoted: QuotedMessageSummary;
  onClick?: (quotedMessageId: string) => void;
}) {
  const clickable = Boolean(onClick && quoted.id && !quoted.deleted);
  const author =
    quoted.senderType === 'patient' ? (quoted.senderName ?? 'Paciente') : (quoted.senderName ?? 'Você');
  const body = (
    <>
      {quoted.id !== null && (
        <span className="truncate text-caption font-semibold text-accent-800">{author}</span>
      )}
      <span className="line-clamp-2 break-words text-caption text-neutral-700">
        {quotedLabel(quoted)}
      </span>
    </>
  );
  const shell =
    'flex min-w-0 flex-col gap-xs rounded-sm border-0 border-l-4 border-solid border-accent bg-neutral-100 px-sm py-xs text-left font-body';
  return clickable && quoted.id ? (
    <button
      type="button"
      data-testid="quoted-block"
      onClick={() => onClick?.(quoted.id as string)}
      className={cn(shell, 'cursor-pointer hover:bg-neutral-200')}
      aria-label="Ir para a mensagem citada"
    >
      {body}
    </button>
  ) : (
    <div data-testid="quoted-block" className={shell}>
      {body}
    </div>
  );
}

/**
 * Setinha + menu da mensagem (padrão WhatsApp Web): Responder · Reagir ·
 * Copiar. "Reagir" troca o menu pela barra rápida de emojis.
 * rangel: mesmo padrão de clique-fora + Esc do `TransferMenu`, sem biblioteca.
 */
function MessageMenu({
  message,
  side,
  onReply,
  onReact,
}: {
  message: Message;
  side: 'left' | 'right';
  onReply?: (message: Message) => void;
  onReact?: (message: Message, emoji: string | null) => void;
}) {
  const [open, setOpen] = useState<'closed' | 'menu' | 'reactions'>('closed');
  const ref = useRef<HTMLDivElement>(null);
  const mine = message.reactions?.find((reaction) => reaction.reactorType === 'agent')?.emoji ?? null;
  const canCopy = message.content.length > 0 && typeof navigator !== 'undefined';

  useEffect(() => {
    if (open === 'closed') return;
    function onPointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen('closed');
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen('closed');
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!onReply && !onReact && !canCopy) return null;

  const item =
    'w-full cursor-pointer border-none bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100';

  return (
    <div ref={ref} className="absolute right-xs top-xs z-10">
      <button
        type="button"
        aria-label="Ações da mensagem"
        aria-haspopup="menu"
        aria-expanded={open !== 'closed'}
        onClick={() => setOpen((value) => (value === 'closed' ? 'menu' : 'closed'))}
        className={cn(
          'flex cursor-pointer items-center justify-center rounded-pill border-none bg-transparent px-xs',
          'font-body text-caption text-neutral-600 hover:bg-neutral-200',
          'opacity-0 focus:opacity-100 group-hover:opacity-100',
          open !== 'closed' && 'opacity-100',
        )}
      >
        ⌄
      </button>

      {open === 'menu' && (
        <div
          role="menu"
          className={cn(
            'absolute top-full z-50 mt-xs w-max min-w-full rounded-md border border-neutral-200 bg-surface py-xs shadow-md',
            side === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {onReply && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen('closed');
                onReply(message);
              }}
            >
              Responder
            </button>
          )}
          {onReact && (
            <button type="button" role="menuitem" className={item} onClick={() => setOpen('reactions')}>
              Reagir
            </button>
          )}
          {canCopy && (
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen('closed');
                void navigator.clipboard?.writeText(message.content);
              }}
            >
              Copiar
            </button>
          )}
        </div>
      )}

      {open === 'reactions' && onReact && (
        <div
          role="group"
          aria-label="Reagir com"
          className={cn(
            'absolute top-full z-50 mt-xs flex gap-xs rounded-pill border border-neutral-200 bg-surface px-sm py-xs shadow-md',
            side === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Reagir com ${emoji}`}
              aria-pressed={mine === emoji}
              onClick={() => {
                setOpen('closed');
                onReact(message, mine === emoji ? null : emoji);
              }}
              className={cn(
                'cursor-pointer rounded-pill border-none bg-transparent px-xs font-body text-label hover:bg-neutral-200',
                mine === emoji && 'bg-accent-100',
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const SHELL: Record<MessageBubbleType, string> = {
  received:
    'self-start bg-chat-received border border-chat-received-border rounded-md rounded-bl-sm ' +
    'px-[15px] py-[11px] text-label',
  sent:
    'self-end bg-chat-sent border border-chat-sent-border rounded-md rounded-br-sm ' +
    'px-[15px] py-[11px] text-label',
  system:
    'self-center bg-accent2-100 border border-accent2-300 rounded-pill px-[14px] py-[5px] ' +
    'text-caption text-accent2-800',
};

export function MessageBubble({
  type,
  message,
  maxWidth = INBOX_BUBBLE_MAX_WIDTH,
  showMeta = true,
  onReply,
  onReact,
  onQuoteClick,
  onRetry,
  onOpenImage,
}: MessageBubbleProps) {
  const isSystem = type === 'system';
  // Apagada pelo remetente (D-220): a API já mandou sem conteúdo; o balão só avisa.
  const isDeleted = Boolean(message.deletedAt);
  const attachmentUrl = message.attachmentUrl;
  const hasAttachment = Boolean(attachmentUrl);
  const isImage = message.messageType === 'image' && hasAttachment;
  const isAudio = message.messageType === 'audio' && hasAttachment;
  const isDoc = !isImage && !isAudio && hasAttachment;
  const isProtected = attachmentUrl ? isProtectedMediaUrl(attachmentUrl) : false;

  // `GET /media/:id` exige Authorization (requireAuth()) — um <img src> cru
  // nunca manda esse header, por isso a imagem sempre vinha em branco/401.
  // O hook busca autenticado e devolve um object URL utilizável em <img>.
  // URL externa (`isProtected` falso) vai direto no <img>, sem token.
  const { objectUrl: fetchedImageUrl, isLoading: imageLoading } = useAuthenticatedMedia(isImage && isProtected ? attachmentUrl : null);
  const imageUrl = isImage && !isProtected ? attachmentUrl : fetchedImageUrl;

  // PDF/doc: o blob só é buscado NO CLIQUE (revisão do PR #43). Buscar na
  // montagem baixava até 15 MiB por mensagem só para desenhar um link — uma
  // conversa com 30 anexos disparava 30 GETs autenticados ao abrir, e de novo
  // a cada troca de conversa. PDF abre em nova aba (o blob carrega o
  // `Content-Type` certo); qualquer outro anexo força download.
  const [docState, setDocState] = useState<'idle' | 'loading' | 'error'>('idle');
  const openDoc = async (): Promise<void> => {
    if (!attachmentUrl || docState === 'loading') return;
    setDocState('loading');
    try {
      const { blob, fileName } = await fetchAuthenticatedBlob(resolveMediaUrl(attachmentUrl));
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      if (message.messageType === 'pdf') {
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      } else {
        anchor.download = fileName ?? 'anexo';
      }
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoga depois que o navegador já abriu/baixou; imediato quebra o download.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setDocState('idle');
    } catch {
      setDocState('error');
    }
  };

  if (isDeleted) {
    return (
      <div
        data-testid="message-bubble"
        data-type={type}
        data-message-id={message.id}
        data-deleted="true"
        style={{ maxWidth: isSystem ? undefined : maxWidth }}
        className={cn(
          'flex min-w-0 flex-col gap-xs font-body text-text transition-shadow',
          'data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-accent',
          SHELL[type],
        )}
      >
        <p className="m-0 italic text-neutral-600">🚫 Mensagem apagada</p>
        {showMeta && !isSystem && (
          <span
            data-testid="message-meta"
            className="flex items-baseline gap-sm text-micro tracking-normal text-neutral-600"
          >
            {message.senderName && <span className="truncate">{message.senderName}</span>}
            <DateDisplay value={message.createdAt} variant="absolute" />
          </span>
        )}
      </div>
    );
  }

  const reactions = message.reactions ?? [];

  return (
    <div
      data-testid="message-bubble"
      data-type={type}
      data-message-id={message.id}
      style={{ maxWidth: isSystem ? undefined : maxWidth }}
      className={cn(
        'group relative flex min-w-0 flex-col gap-xs font-body text-text transition-shadow',
        'data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-accent',
        SHELL[type],
      )}
    >
      {!isSystem && (
        <MessageMenu
          message={message}
          side={type === 'sent' ? 'right' : 'left'}
          onReply={onReply}
          onReact={onReact}
        />
      )}

      {message.quoted && <QuotedBlock quoted={message.quoted} onClick={onQuoteClick} />}

      <p className="m-0 whitespace-pre-wrap break-words">
        {/* Formatação do WhatsApp e links (D-183, D-242): nós React, nunca HTML — sem XSS. */}
        <WhatsAppText text={message.content} />
      </p>

      {isImage &&
        (imageUrl ? (
          onOpenImage ? (
            <button
              type="button"
              onClick={() => onOpenImage(message)}
              className="cursor-pointer self-start rounded-md border-none bg-transparent p-0"
            >
              <img
                src={imageUrl}
                alt="Anexo enviado na conversa"
                className="max-h-[300px] max-w-full rounded-md object-cover"
              />
            </button>
          ) : (
            <img
              src={imageUrl}
              alt="Anexo enviado na conversa"
              className="max-h-[300px] max-w-full self-start rounded-md object-cover"
            />
          )
        ) : (
          <span className="text-caption text-neutral-600">
            {imageLoading ? 'Carregando imagem…' : 'Não foi possível carregar a imagem'}
          </span>
        ))}

      {isAudio && message.attachmentUrl && <AudioMessage url={message.attachmentUrl} />}

      {isDoc &&
        attachmentUrl &&
        (!isProtected ? (
          // Anexo hospedado fora do nosso backend: link cru, sem token.
          <a
            href={attachmentUrl}
            target="_blank"
            rel="noreferrer"
            className="text-caption font-semibold text-accent-700 underline"
          >
            {message.messageType === 'pdf' ? 'Abrir' : 'Baixar'} anexo ({message.messageType})
          </a>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void openDoc()}
              disabled={docState === 'loading'}
              className="cursor-pointer self-start border-none bg-transparent p-0 text-left text-caption font-semibold text-accent-700 underline disabled:cursor-progress"
            >
              {docState === 'loading'
                ? 'Carregando anexo…'
                : `${message.messageType === 'pdf' ? 'Abrir' : 'Baixar'} anexo (${message.messageType})`}
            </button>
            {docState === 'error' && (
              <span className="text-caption text-neutral-600">Não foi possível carregar o anexo</span>
            )}
          </>
        ))}

      {showMeta && !isSystem && (
        <span
          data-testid="message-meta"
          className="flex items-baseline gap-sm text-micro tracking-normal text-neutral-600"
        >
          {message.senderName && <span className="truncate">{message.senderName}</span>}
          {message.editedAt && <span data-testid="message-edited">Editada</span>}
          <DateDisplay value={message.createdAt} variant="absolute" />
          {type === 'sent' && <MessageStatusTick status={message.status} />}
        </span>
      )}

      {type === 'sent' && message.status === 'failed' && (
        <span
          role="alert"
          data-testid="message-failed"
          className="flex flex-wrap items-baseline gap-sm text-caption text-accent-700"
        >
          Não foi possível enviar
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(message)}
              className="font-semibold underline underline-offset-2 hover:text-accent-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Tentar de novo
            </button>
          )}
        </span>
      )}

      {reactions.length > 0 && (
        <span
          data-testid="message-reactions"
          aria-label={`Reações: ${reactions.map((reaction) => reaction.emoji).join(' ')}`}
          className={cn(
            'flex gap-xs self-start rounded-pill border border-neutral-200 bg-surface px-sm text-caption shadow-sm',
            type === 'sent' && 'self-end',
          )}
        >
          {reactions.map((reaction) => (
            <span
              key={reaction.reactorType}
              title={reaction.reactorType === 'patient' ? 'Paciente' : (reaction.userName ?? 'Laboratório')}
            >
              {reaction.emoji}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
