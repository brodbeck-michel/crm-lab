import { useState } from 'react';
import type { Message, SenderType } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { resolveMediaUrl } from '@/api';
import { useAuthenticatedMedia } from '@/hooks';
import { DateDisplay, ImageLightbox } from '@/components/shared';
import { AudioMessage } from './AudioMessage';

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
}: MessageBubbleProps) {
  const isSystem = type === 'system';
  const isImage = message.messageType === 'image' && Boolean(message.attachmentUrl);
  const isAudio = message.messageType === 'audio' && Boolean(message.attachmentUrl);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // `GET /media/:id` exige Authorization (requireAuth()) — um <img src> cru
  // nunca manda esse header, por isso a imagem sempre vinha em branco/401.
  // O hook busca autenticado e devolve um object URL utilizável em <img>.
  const {
    objectUrl: imageUrl,
    fileName: imageFileName,
    isLoading: imageLoading,
  } = useAuthenticatedMedia(isImage ? message.attachmentUrl : null);

  return (
    <div
      data-testid="message-bubble"
      data-type={type}
      style={{ maxWidth: isSystem ? undefined : maxWidth }}
      className={cn('flex min-w-0 flex-col gap-xs font-body text-text', SHELL[type])}
    >
      <p className="m-0 whitespace-pre-wrap break-words">{message.content}</p>

      {isImage &&
        (imageUrl ? (
          <>
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              className="cursor-pointer self-start rounded-md border-none bg-transparent p-0"
            >
              <img
                src={imageUrl}
                alt="Anexo enviado na conversa"
                className="max-h-[300px] max-w-full rounded-md object-cover"
              />
            </button>
            <ImageLightbox
              src={lightboxOpen ? imageUrl : null}
              fileName={imageFileName ?? undefined}
              onClose={() => setLightboxOpen(false)}
            />
          </>
        ) : (
          <span className="text-caption text-neutral-600">
            {imageLoading ? 'Carregando imagem…' : 'Não foi possível carregar a imagem'}
          </span>
        ))}

      {isAudio && message.attachmentUrl && <AudioMessage url={message.attachmentUrl} />}

      {message.attachmentUrl && !isImage && !isAudio && (
        <a
          href={resolveMediaUrl(message.attachmentUrl)}
          target="_blank"
          rel="noreferrer"
          className="text-caption font-semibold text-accent-700 underline"
        >
          Anexo ({message.messageType})
        </a>
      )}

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
