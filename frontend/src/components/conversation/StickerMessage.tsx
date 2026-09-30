import { useAuthenticatedMedia } from '@/hooks';
import { isProtectedMediaUrl } from './media-url';

export interface StickerMessageProps {
  /** `message.attachmentUrl`. */
  url: string;
}

/**
 * StickerMessage — figurinha (CRMLAB-70, D-236 item 5): 120×120, sem balão
 * (quem tira o fundo é o `MessageBubble`) e SEM lightbox — é tipo próprio
 * (`sticker`), então também fica fora da navegação de imagens do CRMLAB-64.
 */
export function StickerMessage({ url }: StickerMessageProps) {
  const isProtected = isProtectedMediaUrl(url);
  const { objectUrl, isLoading } = useAuthenticatedMedia(isProtected ? url : null);
  const src = isProtected ? objectUrl : url;

  if (!src) {
    return (
      <span className="text-caption text-neutral-600">
        {isLoading ? 'Carregando figurinha…' : 'Não foi possível carregar a figurinha'}
      </span>
    );
  }
  return (
    <img
      data-testid="sticker-message"
      src={src}
      alt="Figurinha"
      className="h-[120px] w-[120px] object-contain"
    />
  );
}
