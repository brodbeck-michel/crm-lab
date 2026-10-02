import { useState } from 'react';
import type { MessageMediaInfo } from '@crm-lab/shared';
import { useAuthenticatedMedia } from '@/hooks';
import { isProtectedMediaUrl } from './media-url';
import { formatClock } from './message-content';

export interface VideoMessageProps {
  /** `message.attachmentUrl`. */
  url: string;
  media?: MessageMediaInfo | null;
}

/**
 * VideoMessage — vídeo que toca NO PRÓPRIO BALÃO (CRMLAB-70, D-236 item 2).
 *
 * Fica fora do `ImageLightbox` de propósito: a navegação do lightbox
 * (CRMLAB-64) é só de imagens. Antes do clique mostra a miniatura que o
 * WhatsApp mandou (`media.thumbnail`, JPEG em `data:` — a CSP já libera
 * `img-src data:`) com ▶ e a duração; sem miniatura (vídeo enviado pelo CRM),
 * um fundo neutro. O arquivo (até 15 MiB) só é baixado NO CLIQUE, como o
 * documento — baixar na montagem custaria um GET pesado por vídeo da conversa.
 */
export function VideoMessage({ url, media }: VideoMessageProps) {
  const [requested, setRequested] = useState(false);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const isProtected = isProtectedMediaUrl(url);
  const { objectUrl, isLoading, isError } = useAuthenticatedMedia(
    requested && isProtected ? url : null,
  );
  const src = isProtected ? objectUrl : url;
  const duration = media?.durationSec ?? null;

  if (requested && src && playbackFailed) {
    // `.mov`/HEVC no Chrome, por exemplo (D-234 item 8): avisa e deixa baixar.
    return (
      <span className="flex flex-col gap-xs self-start text-caption text-neutral-600">
        Este navegador não reproduz o formato deste vídeo.
        <a href={src} download={media?.fileName ?? 'video'} className="font-semibold text-accent-700 underline">
          Baixar vídeo
        </a>
      </span>
    );
  }

  if (requested && src) {
    return (
      <video
        onError={() => setPlaybackFailed(true)}
        data-testid="video-player"
        src={src}
        controls
        autoPlay
        playsInline
        className="max-h-[300px] max-w-full self-start rounded-md bg-neutral-900"
      />
    );
  }

  return (
    <div className="flex flex-col gap-xs self-start">
      <button
        type="button"
        data-testid="video-message"
        aria-label={
          duration !== null ? `Reproduzir vídeo (${formatClock(duration)})` : 'Reproduzir vídeo'
        }
        onClick={() => setRequested(true)}
        disabled={requested && isLoading}
        className="relative flex h-[180px] w-[240px] max-w-full cursor-pointer items-center justify-center overflow-hidden rounded-md border-none bg-neutral-800 p-0 disabled:cursor-progress"
      >
        {media?.thumbnail && (
          <img
            src={`data:image/jpeg;base64,${media.thumbnail}`}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
        <span
          aria-hidden="true"
          className="relative flex h-[48px] w-[48px] items-center justify-center rounded-pill bg-neutral-900 font-body text-section text-surface opacity-80"
        >
          {requested && isLoading ? '…' : '▶'}
        </span>
        {duration !== null && (
          <span className="absolute bottom-xs left-xs rounded-sm bg-neutral-900 px-xs font-body text-micro text-surface opacity-80">
            🎥 {formatClock(duration)}
          </span>
        )}
      </button>
      {requested && isError && (
        <span className="text-caption text-neutral-600">Não foi possível carregar o vídeo</span>
      )}
    </div>
  );
}
