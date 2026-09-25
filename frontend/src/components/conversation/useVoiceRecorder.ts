import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useVoiceRecorder — recado de voz do Composer (CRMLAB-24, D-181).
 *
 * Máquina de estados sobre `getUserMedia` + `MediaRecorder`:
 * `idle → requesting → recording → preview → sending → idle`. Clique inicia,
 * clique para (decisão do usuário — nada de segurar o botão).
 *
 * Três garantias que o hook dá sozinho, sem depender de quem o usa:
 * 1. o microfone é SOLTO (`track.stop()`) ao parar, cancelar, dar erro e
 *    desmontar — inclusive quando a permissão só chega depois do cancelamento;
 * 2. o object URL da prévia é revogado ao enviar, cancelar e desmontar;
 * 3. `send` não dispara duas vezes (ref, não estado: dois cliques no mesmo
 *    frame ainda veem o estado velho).
 */

/** 5 min: ≈1,2 MB a 32 kbps — longe dos 15 MiB do `MediaService` (D-181). */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Abaixo disto é clique acidental: não vira recado de 0 s. */
export const MIN_RECORDING_MS = 1000;
/** Voz: a mesma faixa do recado do próprio WhatsApp. */
const AUDIO_BITS_PER_SECOND = 32_000;
/** `ogg` (Firefox) primeiro, `webm` (Chrome/Edge), `mp4` (Safari) por último. */
export const RECORDING_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/mp4',
] as const;
const TICK_MS = 250;

export const RECORDER_MESSAGES = {
  insecure: 'A gravação de áudio só funciona em conexão segura (https).',
  unsupported:
    'Este navegador não grava áudio. Use o Chrome, Edge, Firefox ou Safari atualizado.',
  denied:
    'O navegador bloqueou o microfone. Libere o acesso no cadeado ao lado do endereço e tente de novo.',
  notFound: 'Nenhum microfone encontrado. Conecte um microfone e tente de novo.',
  busy: 'O microfone está em uso por outro programa. Feche-o e tente de novo.',
  generic: 'Não foi possível usar o microfone.',
  interrupted: 'A gravação foi interrompida. Tente de novo.',
  tooShort: 'Áudio curto demais para enviar. Grave de novo.',
} as const;

export interface RecordedAudio {
  blob: Blob;
  /** O do `MediaRecorder` (ex.: `audio/webm;codecs=opus`) — o backend normaliza. */
  mimeType: string;
  fileName: string;
}

export type VoiceRecorderState =
  | { status: 'idle' }
  | { status: 'requesting' }
  | { status: 'recording'; elapsedMs: number }
  | {
      status: 'preview' | 'sending';
      url: string;
      durationMs: number;
      /** Parou sozinho no teto de 5 min. */
      hitLimit: boolean;
      audio: RecordedAudio;
    };

/** Primeiro formato suportado, ou `null` (navegador sem nenhum deles). */
export function pickRecordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return null;
  }
  return RECORDING_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** `audio/webm;codecs=opus` → `recado-de-voz.webm`; mp4 vira `.m4a` (é só áudio). */
export function recordingFileName(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const ext = base.endsWith('/ogg') ? 'ogg' : base.endsWith('/mp4') ? 'm4a' : 'webm';
  return `recado-de-voz.${ext}`;
}

/** `65_000` → `1:05`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function messageForMediaError(error: unknown): string {
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return RECORDER_MESSAGES.denied;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return RECORDER_MESSAGES.notFound;
    case 'NotReadableError':
    case 'AbortError':
      return RECORDER_MESSAGES.busy;
    default:
      return RECORDER_MESSAGES.generic;
  }
}

function releaseStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export interface VoiceRecorder {
  state: VoiceRecorderState;
  /** Mensagem de erro para a pessoa (permissão, suporte, curto demais). */
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  cancel: () => void;
  send: (onSend: (audio: RecordedAudio) => Promise<unknown>) => Promise<void>;
  dismissError: () => void;
}

export function useVoiceRecorder(): VoiceRecorder {
  const [state, setState] = useState<VoiceRecorderState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hitLimitRef = useRef(false);
  /** A gravação corrente foi cancelada: o `onstop` descarta em vez de virar prévia. */
  const discardRef = useRef(false);
  /** Muda a cada start/cancel/unmount: um `getUserMedia` atrasado sabe que perdeu a vez. */
  const attemptRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  /** Pedido de permissão em voo — segundo clique no mesmo frame não abre outro. */
  const requestingRef = useRef(false);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  const releaseAll = useCallback(() => {
    clearTimer();
    releaseStream(streamRef.current);
    streamRef.current = null;
  }, [clearTimer]);

  const revokePreview = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
  }, []);

  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, []);

  const finish = useCallback(
    (recorder: MediaRecorder, mimeType: string) => {
      if (recorderRef.current !== recorder) return;
      recorderRef.current = null;
      const durationMs = Date.now() - startedAtRef.current;
      releaseAll();
      const discarded = discardRef.current;
      discardRef.current = false;
      if (!mountedRef.current || discarded) return;

      const blob = new Blob(chunksRef.current, { type: mimeType });
      chunksRef.current = [];
      if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
        setState({ status: 'idle' });
        setError(RECORDER_MESSAGES.tooShort);
        return;
      }
      const url = URL.createObjectURL(blob);
      previewUrlRef.current = url;
      setState({
        status: 'preview',
        url,
        durationMs: Math.min(durationMs, MAX_RECORDING_MS),
        hitLimit: hitLimitRef.current,
        audio: { blob, mimeType, fileName: recordingFileName(mimeType) },
      });
    },
    [releaseAll],
  );

  const start = useCallback(async () => {
    if (recorderRef.current || streamRef.current || requestingRef.current) return;
    setError(null);
    revokePreview();

    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setError(RECORDER_MESSAGES.insecure);
      return;
    }
    const getUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    const mimeType = pickRecordingMimeType();
    if (!getUserMedia || !mimeType) {
      setError(RECORDER_MESSAGES.unsupported);
      return;
    }

    const attempt = ++attemptRef.current;
    requestingRef.current = true;
    setState({ status: 'requesting' });
    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: true });
    } catch (err) {
      if (attempt === attemptRef.current) requestingRef.current = false;
      if (attempt !== attemptRef.current || !mountedRef.current) return;
      setState({ status: 'idle' });
      setError(messageForMediaError(err));
      return;
    }
    if (attempt === attemptRef.current) requestingRef.current = false;
    // Cancelou (ou trocou de conversa) enquanto o navegador perguntava.
    if (attempt !== attemptRef.current || !mountedRef.current) {
      releaseStream(stream);
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    } catch (err) {
      releaseStream(stream);
      setState({ status: 'idle' });
      setError(messageForMediaError(err));
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    discardRef.current = false;
    hitLimitRef.current = false;
    // `recorder.mimeType` é o que o navegador de fato usou; vazio em alguns.
    const recordedType = recorder.mimeType || mimeType;
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => finish(recorder, recordedType);
    recorder.onerror = () => {
      discardRef.current = true;
      stopRecorder();
      finish(recorder, recordedType);
      if (mountedRef.current) {
        setState({ status: 'idle' });
        setError(RECORDER_MESSAGES.interrupted);
      }
    };

    try {
      recorder.start(1000);
    } catch (err) {
      recorderRef.current = null;
      releaseAll();
      setState({ status: 'idle' });
      setError(messageForMediaError(err));
      return;
    }
    startedAtRef.current = Date.now();
    setState({ status: 'recording', elapsedMs: 0 });
    timerRef.current = setInterval(() => {
      const elapsedMs = Date.now() - startedAtRef.current;
      if (elapsedMs >= MAX_RECORDING_MS) {
        hitLimitRef.current = true;
        clearTimer();
        stopRecorder();
        return;
      }
      setState((current) =>
        current.status === 'recording' ? { status: 'recording', elapsedMs } : current,
      );
    }, TICK_MS);
  }, [clearTimer, finish, releaseAll, revokePreview, stopRecorder]);

  const stop = useCallback(() => {
    clearTimer();
    stopRecorder();
  }, [clearTimer, stopRecorder]);

  const cancel = useCallback(() => {
    if (sendingRef.current) return;
    attemptRef.current++;
    requestingRef.current = false;
    if (recorderRef.current) {
      discardRef.current = true;
      stopRecorder();
    }
    recorderRef.current = null;
    chunksRef.current = [];
    releaseAll();
    revokePreview();
    setState({ status: 'idle' });
  }, [releaseAll, revokePreview, stopRecorder]);

  const send = useCallback(
    async (onSend: (audio: RecordedAudio) => Promise<unknown>) => {
      if (state.status !== 'preview' || sendingRef.current) return;
      sendingRef.current = true;
      const preview = state;
      setState({ ...preview, status: 'sending' });
      try {
        await onSend(preview.audio);
        sendingRef.current = false;
        if (!mountedRef.current) return;
        revokePreview();
        setState({ status: 'idle' });
      } catch {
        // Quem chama já avisou do erro (toast da API); a prévia fica para tentar de novo.
        sendingRef.current = false;
        if (mountedRef.current) setState({ ...preview, status: 'preview' });
      }
    },
    [revokePreview, state],
  );

  // Desmontou (trocou de conversa, saiu da tela): solta tudo.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      attemptRef.current++;
      discardRef.current = true;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      if (timerRef.current !== null) clearInterval(timerRef.current);
      releaseStream(streamRef.current);
      streamRef.current = null;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    };
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { state, error, start, stop, cancel, send, dismissError };
}
