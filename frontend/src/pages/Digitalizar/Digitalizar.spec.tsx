import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ApiModule from '@/api';
import type * as HelpersModule from './capture-helpers';

const sessionMock = vi.fn();
const pairMock = vi.fn();
const uploadMock = vi.fn();
const reduceMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    captureApi: { session: sessionMock, pair: pairMock, uploadScan: uploadMock },
  };
});

vi.mock('./capture-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof HelpersModule>();
  return { ...actual, reduceScanImage: reduceMock };
});

const { ApiError } = await import('@/api');
const { default: Digitalizar, MESSAGES } = await import('./index');

/**
 * `/digitalizar` (PAGES.md §24, CRMLAB-184): instalar → código → câmera, e o
 * envio em sequência com falha por foto.
 */

const SESSION = { deviceName: 'Celular recepção', tenantName: 'Laboratório Santé' };
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

function setDisplay(standalone: boolean, userAgent = IPHONE_UA): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
}

function unpaired() {
  return new ApiError('CAPTURE_DEVICE_UNPAIRED', 'Dispositivo não pareado', 401);
}

function photo(name: string): File {
  return new File([name], name, { type: 'image/jpeg' });
}

async function takePhotos(names: string[]): Promise<void> {
  for (const name of names) {
    await userEvent.upload(screen.getByTestId('capture-input'), photo(name));
  }
  await waitFor(() =>
    expect(screen.getByRole('button', { name: `Enviar (${names.length})` })).toBeEnabled(),
  );
}

beforeEach(() => {
  sessionMock.mockReset();
  pairMock.mockReset();
  uploadMock.mockReset();
  reduceMock.mockReset();
  reduceMock.mockImplementation((file: File) =>
    Promise.resolve(new Blob([file.name], { type: 'image/jpeg' })),
  );
  URL.createObjectURL = vi.fn(() => 'blob:foto');
  URL.revokeObjectURL = vi.fn();
  setDisplay(true);
});

afterEach(() => {
  vi.useRealTimers();
  document.head.querySelectorAll('[data-digitalizar]').forEach((node) => node.remove());
});

describe('/digitalizar — abrir', () => {
  it('no Safari do iPhone (não instalada) só ensina a instalar e não pergunta a sessão', async () => {
    setDisplay(false, IPHONE_UA);
    render(<Digitalizar />);
    expect(await screen.findByRole('list', { name: 'Como instalar' })).toBeInTheDocument();
    expect(screen.getByText('Adicionar à Tela de Início')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continuar sem instalar' })).not.toBeInTheDocument();
    expect(sessionMock).not.toHaveBeenCalled();
  });

  it('fora do iOS mostra o passo a passo e deixa seguir para o código', async () => {
    setDisplay(false, DESKTOP_UA);
    sessionMock.mockRejectedValue(unpaired());
    render(<Digitalizar />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continuar sem instalar' }));
    expect(await screen.findByLabelText('Código de pareamento')).toBeInTheDocument();
  });

  it('injeta o manifesto e o ícone do iOS só nesta rota', async () => {
    sessionMock.mockResolvedValue(SESSION);
    const { unmount } = render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    expect(document.head.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/digitalizar.webmanifest',
    );
    expect(document.head.querySelector('link[rel="apple-touch-icon"]')).not.toBeNull();
    expect(
      document.head.querySelector('meta[name="apple-mobile-web-app-capable"]'),
    ).toHaveAttribute('content', 'yes');
    unmount();
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
  });
});

describe('/digitalizar — pareamento', () => {
  it('sessão 401 → tela do código; hífen automático; pareia e mostra laboratório e dispositivo', async () => {
    sessionMock.mockRejectedValue(unpaired());
    pairMock.mockResolvedValue(SESSION);
    render(<Digitalizar />);

    const input = await screen.findByLabelText('Código de pareamento');
    const connect = screen.getByRole('button', { name: 'Conectar' });
    expect(connect).toBeDisabled();
    await userEvent.type(input, 'k7mx4qpr');
    expect(input).toHaveValue('K7MX-4QPR');
    await userEvent.click(connect);

    expect(pairMock).toHaveBeenCalledWith({ code: 'K7MX4QPR' });
    expect(await screen.findByText('Laboratório Santé')).toBeInTheDocument();
    expect(screen.getByText(/Celular recepção/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tirar foto' })).toBeInTheDocument();
  });

  it('código inválido mostra a mensagem do contrato', async () => {
    sessionMock.mockRejectedValue(unpaired());
    pairMock.mockRejectedValue(new ApiError('PAIRING_CODE_INVALID', 'Código inválido', 400));
    render(<Digitalizar />);
    await userEvent.type(await screen.findByLabelText('Código de pareamento'), 'K7MX4QPR');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.invalidCode);
  });

  it('429 pede para esperar', async () => {
    sessionMock.mockRejectedValue(unpaired());
    pairMock.mockRejectedValue(new ApiError('RATE_LIMIT_EXCEEDED', 'Muitas', 429));
    render(<Digitalizar />);
    await userEvent.type(await screen.findByLabelText('Código de pareamento'), 'K7MX4QPR');
    await userEvent.click(screen.getByRole('button', { name: 'Conectar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(MESSAGES.tooManyAttempts);
  });
});

describe('/digitalizar — envio', () => {
  it('sobe uma por vez, na ordem; a que falha fica com "Tentar de novo" e as outras seguem', async () => {
    sessionMock.mockResolvedValue(SESSION);
    const order: string[] = [];
    uploadMock.mockImplementation((body: { contentBase64: string }) => {
      const name = atob(body.contentBase64);
      order.push(name);
      return name === 'b.jpg'
        ? Promise.reject(new ApiError('INTERNAL_ERROR', 'falhou', 500))
        : Promise.resolve({ id: `s-${name}`, createdAt: '', expiresAt: '' });
    });
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg', 'b.jpg', 'c.jpg']);

    await userEvent.click(screen.getByRole('button', { name: 'Enviar (3)' }));

    await waitFor(() => expect(order).toEqual(['a.jpg', 'b.jpg', 'c.jpg']));
    expect(uploadMock.mock.calls[0]?.[0]).toMatchObject({ mimeType: 'image/jpeg' });
    const left = await screen.findAllByTestId('capture-photo');
    expect(left).toHaveLength(1);
    expect(left[0]).toHaveAttribute('data-status', 'failed');
    expect(screen.queryByText(MESSAGES.sent)).not.toBeInTheDocument();

    // Tentar de novo: só a que falhou.
    uploadMock.mockResolvedValue({ id: 's-b', createdAt: '', expiresAt: '' });
    await userEvent.click(within(left[0] as HTMLElement).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(MESSAGES.sent)).toBeInTheDocument();
    expect(uploadMock).toHaveBeenCalledTimes(4);
    expect(screen.queryAllByTestId('capture-photo')).toHaveLength(0);
  });

  it('tudo certo: "Enviado ✓" por 2 s e volta ao estado inicial', async () => {
    sessionMock.mockResolvedValue(SESSION);
    uploadMock.mockResolvedValue({ id: 's-1', createdAt: '', expiresAt: '' });
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg']);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await userEvent.click(screen.getByRole('button', { name: 'Enviar (1)' }));
    expect(await screen.findByText(MESSAGES.sent)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tirar foto' })).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.queryByText(MESSAGES.sent)).not.toBeInTheDocument();
  });

  it('CAPTURE_DEVICE_UNPAIRED no envio volta para o código com o aviso', async () => {
    sessionMock.mockResolvedValue(SESSION);
    uploadMock.mockRejectedValue(unpaired());
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg', 'b.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar (2)' }));
    expect(await screen.findByText(MESSAGES.unpaired)).toBeInTheDocument();
    expect(screen.getByLabelText('Código de pareamento')).toBeInTheDocument();
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('fila cheia para o envio e explica', async () => {
    sessionMock.mockResolvedValue(SESSION);
    uploadMock.mockRejectedValue(
      new ApiError('CONFLICT', 'Fila cheia', 409, { reason: 'scan_queue_full', max: 100 }),
    );
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg', 'b.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar (2)' }));
    expect(await screen.findByText(MESSAGES.queueFull)).toBeInTheDocument();
    expect(uploadMock).toHaveBeenCalledTimes(1);
  });

  it('sem rede: a foto fica com "Sem conexão. A foto continua aqui."', async () => {
    sessionMock.mockResolvedValue(SESSION);
    uploadMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'Enviar (1)' }));
    expect(await screen.findByText(MESSAGES.offline)).toBeInTheDocument();
    expect(screen.getByTestId('capture-photo')).toHaveAttribute('data-status', 'failed');
  });

  it('foto acima de 5 MB mesmo reduzida: avisa e não entra no envio', async () => {
    sessionMock.mockResolvedValue(SESSION);
    reduceMock.mockResolvedValueOnce(null);
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await userEvent.upload(screen.getByTestId('capture-input'), photo('enorme.jpg'));
    expect(await screen.findByText(MESSAGES.tooLarge)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar (0)' })).toBeDisabled();
  });

  it('× tira a foto da faixa', async () => {
    sessionMock.mockResolvedValue(SESSION);
    render(<Digitalizar />);
    await screen.findByText('Laboratório Santé');
    await takePhotos(['a.jpg', 'b.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'Remover foto 1' }));
    expect(screen.getAllByTestId('capture-photo')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enviar (1)' })).toBeEnabled();
  });
});
