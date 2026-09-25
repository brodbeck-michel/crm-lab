import { Button } from '@/components/ui';
import { MAX_RECORDING_MS, formatDuration } from './useVoiceRecorder';
import type { RecordedAudio, VoiceRecorder as VoiceRecorderHandle } from './useVoiceRecorder';

/**
 * Barra do recado de voz (CRMLAB-24, D-181) — ocupa o lugar do emoji, do campo
 * e do Enviar enquanto a gravação está em curso ou em prévia. Só o Composer a
 * usa; quem manda no estado é `useVoiceRecorder`.
 */

export interface VoiceRecorderProps {
  recorder: VoiceRecorderHandle;
  onSend: (audio: RecordedAudio) => Promise<unknown>;
  /** Conversa encerrada no meio da prévia: Enviar trava, Cancelar continua. */
  disabled?: boolean;
}

/** Microfone em SVG inline — sem biblioteca de ícones (padrão do shell). */
export function MicIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
      className="flex-[0_0_15px]"
    >
      <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5" />
    </svg>
  );
}

export function VoiceRecorder({ recorder, onSend, disabled = false }: VoiceRecorderProps) {
  const { state } = recorder;
  if (state.status === 'idle') return null;

  if (state.status === 'requesting') {
    return (
      <div data-testid="voice-recorder" className="flex min-w-0 flex-1 items-center gap-sm">
        <span role="status" className="flex-1 font-body text-label text-neutral-600">
          Aguardando o microfone…
        </span>
        <Button variant="secondary" onClick={recorder.cancel}>
          Cancelar
        </Button>
      </div>
    );
  }

  if (state.status === 'recording') {
    return (
      <div data-testid="voice-recorder" className="flex min-w-0 flex-1 items-center gap-sm">
        <span
          aria-hidden="true"
          className="inline-block h-[10px] w-[10px] flex-[0_0_10px] rounded-pill bg-accent-700 motion-safe:animate-pulse"
        />
        <span role="status" className="font-body text-label font-semibold text-text">
          Gravando
        </span>
        <span
          data-testid="voice-recorder-timer"
          className="flex-1 font-body text-label tabular-nums text-neutral-600"
        >
          {formatDuration(state.elapsedMs)} / {formatDuration(MAX_RECORDING_MS)}
        </span>
        <Button variant="secondary" onClick={recorder.cancel}>
          Cancelar
        </Button>
        <Button onClick={recorder.stop}>Parar</Button>
      </div>
    );
  }

  const sending = state.status === 'sending';
  return (
    <div data-testid="voice-recorder" className="flex min-w-0 flex-1 flex-col gap-xs">
      <div className="flex min-w-0 items-center gap-sm">
        <audio
          src={state.url}
          controls
          preload="metadata"
          data-testid="voice-recorder-preview"
          aria-label="Prévia do áudio gravado"
          className="min-w-0 flex-1"
        />
        <span className="font-body text-caption tabular-nums text-neutral-600">
          {formatDuration(state.durationMs)}
        </span>
        <Button variant="secondary" onClick={recorder.cancel} disabled={sending}>
          Cancelar
        </Button>
        <Button
          onClick={() => void recorder.send(onSend)}
          loading={sending}
          disabled={disabled}
        >
          Enviar
        </Button>
      </div>
      {state.hitLimit && (
        <span className="font-body text-caption text-neutral-600">
          Limite de {MAX_RECORDING_MS / 60_000} min atingido — a gravação parou sozinha.
        </span>
      )}
    </div>
  );
}
