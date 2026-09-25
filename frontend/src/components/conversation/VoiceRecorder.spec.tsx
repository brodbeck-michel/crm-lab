import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';
import { MAX_RECORDING_MS, RECORDER_MESSAGES } from './useVoiceRecorder';
import type { RecordedAudio } from './useVoiceRecorder';

/**
 * Recado de voz no Composer (CRMLAB-24, D-181). `getUserMedia` e
 * `MediaRecorder` são falsos: o jsdom não tem nenhum dos dois, e o que se
 * protege aqui é a máquina de estados — microfone solto, sem duplo envio, sem
 * recado de 0 s, parada no teto de 5 min.
 */

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks = [new FakeTrack()];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

let supportedTypes: string[] = [];
let recorders: FakeMediaRecorder[] = [];

class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return supportedTypes.includes(type);
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  options: MediaRecorderOptions | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.options = options;
    this.mimeType = options?.mimeType ?? '';
    recorders.push(this);
  }
  startArgs: unknown[] = [];
  start(...args: unknown[]): void {
    this.startArgs = args;
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') throw new DOMException('inactive', 'InvalidStateError');
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio-bytes'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const getUserMedia = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>();
const createObjectURL = vi.fn(() => 'blob:preview');
const revokeObjectURL = vi.fn();

function setSecure(value: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  supportedTypes = ['audio/webm;codecs=opus', 'audio/mp4'];
  recorders = [];
  getUserMedia.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  setSecure(true);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia },
    configurable: true,
  });
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mic(): HTMLElement {
  return screen.getByRole('button', { name: 'Gravar áudio' });
}

async function clickMic(): Promise<void> {
  await act(async () => {
    fireEvent.click(mic());
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

async function recordFor(
  ms: number,
  onSendAudio = vi.fn(async (_audio: RecordedAudio): Promise<void> => undefined),
) {
  const { stream, tracks } = fakeStream();
  getUserMedia.mockResolvedValue(stream);
  const view = render(<Composer onSend={vi.fn()} onSendAudio={onSendAudio} />);
  await clickMic();
  advance(ms);
  return { ...view, tracks, onSendAudio };
}

describe('Composer — recado de voz', () => {
  it('sem onSendAudio o microfone não aparece (nada de botão morto)', () => {
    render(<Composer onSend={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Gravar áudio' })).not.toBeInTheDocument();
  });

  it('conversa encerrada: microfone travado junto com o compositor', () => {
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} disabled />);
    expect(mic()).toBeDisabled();
  });

  it('grava, mostra o tempo, para, ouve a prévia e envia pelo onSendAudio', async () => {
    const { tracks, onSendAudio } = await recordFor(30_000);

    expect(screen.getByRole('status')).toHaveTextContent('Gravando');
    expect(screen.getByTestId('voice-recorder-timer')).toHaveTextContent('0:30 / 5:00');
    expect(screen.queryByLabelText('Mensagem')).not.toBeInTheDocument();
    expect(recorders[0]?.options).toEqual({
      mimeType: 'audio/webm;codecs=opus',
      audioBitsPerSecond: 32_000,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));

    expect(tracks[0]?.stopped).toBe(true);
    expect(screen.getByTestId('voice-recorder-preview')).toHaveAttribute('src', 'blob:preview');
    expect(screen.getByText('0:30')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    });

    expect(onSendAudio).toHaveBeenCalledTimes(1);
    const audio = onSendAudio.mock.calls[0]?.[0];
    expect(audio?.mimeType).toBe('audio/webm;codecs=opus');
    expect(audio?.fileName).toBe('recado-de-voz.webm');
    expect(audio?.blob.size).toBeGreaterThan(0);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Mensagem')).toBeInTheDocument();
  });

  it('o texto que estava sendo digitado volta depois da gravação', async () => {
    getUserMedia.mockResolvedValue(fakeStream().stream);
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Mensagem'), { target: { value: 'rascunho' } });
    await clickMic();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByLabelText('Mensagem')).toHaveValue('rascunho');
  });

  it('dois cliques em Enviar mandam um recado só', async () => {
    let resolve: () => void = () => undefined;
    const onSendAudio = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    await recordFor(5_000, onSendAudio);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));

    const send = screen.getByRole('button', { name: 'Enviar' });
    await act(async () => {
      fireEvent.click(send);
      fireEvent.click(send);
    });
    expect(onSendAudio).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();

    await act(async () => resolve());
    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument();
  });

  it('envio que falha mantém a prévia para tentar de novo', async () => {
    const onSendAudio = vi.fn(async () => {
      throw new Error('502');
    });
    await recordFor(5_000, onSendAudio);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    });
    expect(screen.getByTestId('voice-recorder-preview')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('Cancelar durante a gravação solta o microfone e não gera prévia', async () => {
    const { tracks, onSendAudio } = await recordFor(3_000);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(tracks[0]?.stopped).toBe(true);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByTestId('voice-recorder')).not.toBeInTheDocument();
    expect(onSendAudio).not.toHaveBeenCalled();
  });

  it('Cancelar na prévia revoga o object URL', async () => {
    await recordFor(3_000);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(screen.getByRole('button', { name: 'Gravar áudio' })).toBeInTheDocument();
  });

  it('parar antes de 1 s descarta com aviso — nunca um recado de 0 s', async () => {
    await recordFor(400);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    expect(screen.getByRole('alert')).toHaveTextContent(RECORDER_MESSAGES.tooShort);
    expect(screen.queryByTestId('voice-recorder-preview')).not.toBeInTheDocument();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('para sozinho no teto de 5 min e avisa na prévia', async () => {
    const { tracks } = await recordFor(MAX_RECORDING_MS + 500);
    expect(recorders[0]?.state).toBe('inactive');
    expect(tracks[0]?.stopped).toBe(true);
    expect(screen.getByTestId('voice-recorder-preview')).toBeInTheDocument();
    expect(screen.getByText(/Limite de 5 min atingido/)).toBeInTheDocument();
    expect(screen.getByText('5:00')).toBeInTheDocument();
  });

  it('desmontar no meio da gravação solta o microfone', async () => {
    const { tracks, unmount } = await recordFor(2_000);
    unmount();
    expect(tracks[0]?.stopped).toBe(true);
  });

  it('desmontar na prévia revoga o object URL', async () => {
    const { unmount } = await recordFor(2_000);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('permissão que chega DEPOIS do cancelamento solta o microfone na hora', async () => {
    let grant: (stream: MediaStream) => void = () => undefined;
    getUserMedia.mockImplementation(() => new Promise((resolve) => (grant = resolve)));
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    await clickMic();
    expect(screen.getByRole('status')).toHaveTextContent('Aguardando o microfone');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    const { stream, tracks } = fakeStream();
    await act(async () => grant(stream));

    expect(tracks[0]?.stopped).toBe(true);
    expect(recorders).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Gravar áudio' })).toBeInTheDocument();
  });

  it('permissão negada (NotAllowedError) vira mensagem clara', async () => {
    getUserMedia.mockRejectedValue(new DOMException('negado', 'NotAllowedError'));
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    await clickMic();
    expect(screen.getByRole('alert')).toHaveTextContent(RECORDER_MESSAGES.denied);
    expect(mic()).toBeEnabled();
  });

  it('sem microfone (NotFoundError) vira mensagem clara', async () => {
    getUserMedia.mockRejectedValue(new DOMException('nada', 'NotFoundError'));
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    await clickMic();
    expect(screen.getByRole('alert')).toHaveTextContent(RECORDER_MESSAGES.notFound);
  });

  it('conexão sem https: avisa sem nem pedir o microfone', async () => {
    setSecure(false);
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    await clickMic();
    expect(screen.getByRole('alert')).toHaveTextContent(RECORDER_MESSAGES.insecure);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('navegador sem MediaRecorder: avisa que não grava', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    render(<Composer onSend={vi.fn()} onSendAudio={vi.fn()} />);
    await clickMic();
    expect(screen.getByRole('alert')).toHaveTextContent(RECORDER_MESSAGES.unsupported);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('prefere ogg/opus quando o navegador grava nele (Firefox)', async () => {
    supportedTypes = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'];
    await recordFor(2_000);
    expect(recorders[0]?.options?.mimeType).toBe('audio/ogg;codecs=opus');
  });

  it('grava sem timeslice — um Blob só no fim (MP4 fatiado do Safari não toca inteiro)', async () => {
    await recordFor(1_500);
    expect(recorders[0]?.startArgs).toEqual([]);
  });

  it('conversa encerrada no meio da prévia: Enviar trava, Cancelar continua', async () => {
    const { rerender, onSendAudio } = await recordFor(3_000);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    rerender(<Composer onSend={vi.fn()} onSendAudio={onSendAudio} disabled />);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  });

  it('Safari (só mp4): grava em audio/mp4 e manda como .m4a', async () => {
    supportedTypes = ['audio/mp4'];
    const { onSendAudio } = await recordFor(2_000);
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    });
    expect(onSendAudio).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/mp4', fileName: 'recado-de-voz.m4a' }),
    );
  });
});
