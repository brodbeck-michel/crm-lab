import type { Message } from '@crm-lab/shared';
import { ImageLightbox } from '@/components/shared';
import { isProtectedMediaUrl } from '@/components/conversation/MessageBubble';
import { useAuthenticatedMedia } from '@/hooks';
import { imageCaption, imageTitle } from './useConversationImages';

export interface ConversationImageViewerProps {
  /** Imagens já carregadas, em ordem cronológica (`useConversationImages`). */
  images: Message[];
  /** Id da mensagem aberta; `null` ou fora da lista = fechado (D-244 item 3). */
  openId: string | null;
  patientName: string | null;
  onChange: (messageId: string) => void;
  onClose: () => void;
}

/** URL que o hook autenticado deve buscar — `null` para externa ou ausente. */
function protectedUrl(message: Message | undefined): string | null {
  const url = message?.attachmentUrl ?? null;
  return url && isProtectedMediaUrl(url) ? url : null;
}

/**
 * O lightbox da conversa (CRMLAB-64, D-244/D-245): um só, do painel. Recebe o
 * id aberto — não o índice —, então mensagem nova pelo WS ou histórico
 * carregado não fazem a foto pular; se a aberta sair da lista, fecha.
 *
 * A mídia vem de `useAuthenticatedMedia`, que compartilha o blob por URL: a
 * foto aberta reaproveita o que o balão já baixou, e pedir as vizinhas aqui é
 * o próprio pré-carregamento.
 */
export function ConversationImageViewer({
  images,
  openId,
  patientName,
  onChange,
  onClose,
}: ConversationImageViewerProps) {
  const index = openId === null ? -1 : images.findIndex((message) => message.id === openId);
  const current = index >= 0 ? images[index] : undefined;
  const previous = index > 0 ? images[index - 1] : undefined;
  const next = index >= 0 ? images[index + 1] : undefined;

  const media = useAuthenticatedMedia(protectedUrl(current));
  const previousMedia = useAuthenticatedMedia(protectedUrl(previous));
  const nextMedia = useAuthenticatedMedia(protectedUrl(next));

  if (!current?.attachmentUrl) return null;

  const isProtected = isProtectedMediaUrl(current.attachmentUrl);
  const src = isProtected ? media.objectUrl : current.attachmentUrl;
  const preload = [previous, next]
    .map((neighbor, position) => {
      if (!neighbor?.attachmentUrl) return null;
      if (!isProtectedMediaUrl(neighbor.attachmentUrl)) return neighbor.attachmentUrl;
      return (position === 0 ? previousMedia : nextMedia).objectUrl;
    })
    .filter((url): url is string => url !== null);

  return (
    <ImageLightbox
      open
      src={src}
      fileName={media.fileName ?? undefined}
      loading={isProtected && media.isLoading}
      error={isProtected && media.isError}
      title={imageTitle(current, patientName)}
      // Protegida: espera o nome do arquivo para não piscar o nome como legenda.
      caption={isProtected && media.isLoading ? undefined : imageCaption(current, media.fileName)}
      onPrev={previous ? () => onChange(previous.id) : undefined}
      onNext={next ? () => onChange(next.id) : undefined}
      preload={preload}
      onClose={onClose}
    />
  );
}
