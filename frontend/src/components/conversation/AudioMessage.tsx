import { useState } from 'react';
import { useAuthenticatedMedia } from '@/hooks';

export interface AudioMessageProps {
  /** Caminho da mídia autenticada (`message.attachmentUrl`). */
  url: string;
}

/**
 * AudioMessage — áudio recebido tocado dentro da própria bolha (CRMLAB-2).
 *
 * Antes, áudio caía no link genérico "Anexo (audio)": abria outra aba e, por
 * ser mídia autenticada, muitas vezes nem tocava. Aqui o blob vem com token
 * (`useAuthenticatedMedia`) e vira `src` do `<audio>`.
 *
 * Controles são os NATIVOS do navegador: play/pause, barra com tempo
 * decorrido/total e seek clicando na barra — tudo o que o atendimento pede,
 * com acessibilidade e teclado de graça. Um player desenhado à mão só entra se
 * o visual virar exigência de verdade.
 *
 * O download continua disponível: o Evolution entrega ogg/opus, que o Safari
 * não toca. Quando o `<audio>` falha, o link é o plano B — não um beco sem
 * saída.
 */
export function AudioMessage({ url }: AudioMessageProps) {
  const { objectUrl, isLoading } = useAuthenticatedMedia(url);
  const [playbackFailed, setPlaybackFailed] = useState(false);

  if (!objectUrl) {
    return (
      <span className="text-caption text-neutral-600">
        {isLoading ? 'Carregando áudio…' : 'Não foi possível carregar o áudio'}
      </span>
    );
  }

  return (
    <div data-testid="audio-message" className="flex min-w-0 flex-col gap-xs">
      {playbackFailed ? (
        <span className="text-caption text-neutral-600">
          Este navegador não reproduz o formato deste áudio.
        </span>
      ) : (
        <audio
          src={objectUrl}
          controls
          preload="metadata"
          onError={() => setPlaybackFailed(true)}
          data-testid="audio-message-player"
          className="max-w-full"
        />
      )}
      <a href={objectUrl} download className="text-caption font-semibold text-accent-700 underline">
        Baixar áudio
      </a>
    </div>
  );
}
