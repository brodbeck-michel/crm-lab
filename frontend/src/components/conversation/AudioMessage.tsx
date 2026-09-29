import { useEffect, useRef, useState } from 'react';
import { useAuthenticatedMedia } from '@/hooks';
import { formatClock } from './message-content';

export interface AudioMessageProps {
  /** Caminho da mídia autenticada (`message.attachmentUrl`). */
  url: string;
  /** Duração que o WhatsApp informou (CRMLAB-70) — aparece antes de o áudio carregar. */
  durationSec?: number | null;
}

/** Velocidades do botão, na ordem do clique (D-236 item 3). */
export const AUDIO_SPEEDS = [1, 1.5, 2] as const;

function speedLabel(speed: number): string {
  return `${String(speed).replace('.', ',')}x`;
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
 *
 * Velocidade (CRMLAB-70, D-236 item 3): botão 1x → 1,5x → 2x → 1x ao lado do
 * player, só para ESTE áudio (`playbackRate`). O `<audio>` reaplica a taxa ao
 * trocar de `src`, por isso o efeito roda também quando o blob chega.
 */
export function AudioMessage({ url, durationSec }: AudioMessageProps) {
  const { objectUrl, isLoading } = useAuthenticatedMedia(url);
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const speed = AUDIO_SPEEDS[speedIndex] ?? 1;

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed, objectUrl]);

  if (!objectUrl) {
    return (
      <span className="text-caption text-neutral-600">
        {isLoading ? 'Carregando áudio…' : 'Não foi possível carregar o áudio'}
        {isLoading && durationSec ? ` (${formatClock(durationSec)})` : ''}
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
        <span className="flex min-w-0 items-center gap-xs">
          <audio
            ref={audioRef}
            src={objectUrl}
            controls
            preload="metadata"
            onError={() => setPlaybackFailed(true)}
            data-testid="audio-message-player"
            className="min-w-0 max-w-full"
          />
          <button
            type="button"
            data-testid="audio-speed"
            aria-label={`Velocidade ${speedLabel(speed)} — trocar`}
            onClick={() => setSpeedIndex((index) => (index + 1) % AUDIO_SPEEDS.length)}
            className="shrink-0 cursor-pointer rounded-pill border-none bg-neutral-200 px-sm font-body text-caption font-semibold text-neutral-800 hover:bg-neutral-300"
          >
            {speedLabel(speed)}
          </button>
        </span>
      )}
      <a href={objectUrl} download className="text-caption font-semibold text-accent-700 underline">
        Baixar áudio
      </a>
    </div>
  );
}
