import { useState } from 'react';
import type { Message, SenderType } from '@crm-lab/shared';
import { cn } from '@/components/ui';
import { fetchAuthenticatedBlob, resolveMediaUrl } from '@/api';
import { useAuthenticatedMedia } from '@/hooks';
import { DateDisplay, ImageLightbox } from '@/components/shared';
import { AudioMessage } from './AudioMessage';

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
  const attachmentUrl = message.attachmentUrl;
  const hasAttachment = Boolean(attachmentUrl);
  const isImage = message.messageType === 'image' && hasAttachment;
  const isAudio = message.messageType === 'audio' && hasAttachment;
  const isDoc = !isImage && !isAudio && hasAttachment;
  const isProtected = attachmentUrl ? isProtectedMediaUrl(attachmentUrl) : false;
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // `GET /media/:id` exige Authorization (requireAuth()) — um <img src> cru
  // nunca manda esse header, por isso a imagem sempre vinha em branco/401.
  // O hook busca autenticado e devolve um object URL utilizável em <img>.
  // URL externa (`isProtected` falso) vai direto no <img>, sem token.
  const {
    objectUrl: fetchedImageUrl,
    fileName: imageFileName,
    isLoading: imageLoading,
  } = useAuthenticatedMedia(isImage && isProtected ? attachmentUrl : null);
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
          <DateDisplay value={message.createdAt} variant="absolute" />
        </span>
      )}
    </div>
  );
}
