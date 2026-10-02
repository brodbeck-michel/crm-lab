import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, MessageMediaInfo } from '@crm-lab/shared';
import type * as ApiModule from '@/api';

/**
 * Tipos de mensagem padrão WhatsApp Web (CRMLAB-70, D-236): vídeo toca no
 * balão (nunca no lightbox), documento com nome/tamanho/páginas, áudio com
 * velocidade, figurinha sem balão, localização com "Abrir no mapa" e contato
 * com "Conversar" (reaproveita a Nova conversa, CRMLAB-50).
 */
const fetchAuthenticatedBlobMock = vi.fn();
const startWhatsAppMock = vi.fn();
const openWhatsAppMock = vi.fn();
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    fetchAuthenticatedBlob: fetchAuthenticatedBlobMock,
    api: {
      ...actual.api,
      conversations: {
        ...actual.api.conversations,
        startWhatsApp: startWhatsAppMock,
        openWhatsApp: openWhatsAppMock,
      },
    },
  };
});

const { MessageBubble } = await import('./MessageBubble');
const { quotedLabel } = await import('./MessageBubble');
const { showsMessageText, formatClock } = await import('./message-content');
const { documentKindLabel } = await import('./DocumentCard');
const { googleMapsUrl } = await import('./LocationCard');
const { formatContactPhone } = await import('./ContactCard');
const { ToastProvider } = await import('@/components/ui');
const { ApiError } = await import('@/api');

beforeEach(() => {
  fetchAuthenticatedBlobMock.mockReset();
  startWhatsAppMock.mockReset();
  openWhatsAppMock.mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
});

function media(overrides: Partial<MessageMediaInfo> = {}): MessageMediaInfo {
  return {
    fileName: 'arquivo',
    fileSize: 1024,
    mimeType: 'application/octet-stream',
    durationSec: null,
    pageCount: null,
    thumbnail: null,
    ...overrides,
  };
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'João Santos',
    content: 'texto',
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-09-29T14:25:00Z',
    media: null,
    location: null,
    contacts: [],
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function withProviders(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/attendance']}>
          {node}
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

describe('vídeo (D-236 item 2)', () => {
  it('mostra miniatura, ▶ e duração sem baixar nada; o clique toca no próprio balão', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['mp4'], { type: 'video/mp4' }),
      fileName: 'video.mp4',
    });
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'video',
          content: 'video',
          attachmentUrl: '/api/v1/media/vid-1',
          media: media({ fileName: 'video', mimeType: 'video/mp4', durationSec: 75, thumbnail: '/9j/AAA' }),
        })}
      />,
    );

    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();
    const play = screen.getByRole('button', { name: 'Reproduzir vídeo (1:15)' });
    expect(play.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/AAA');
    // Sem legenda: o nome do arquivo não vira texto do balão.
    expect(screen.queryByText('video')).not.toBeInTheDocument();

    await user.click(play);
    const player = await screen.findByTestId('video-player');
    expect(player).toHaveAttribute('src', 'blob:mock');
    expect(player).toHaveAttribute('controls');
    expect(String(fetchAuthenticatedBlobMock.mock.calls[0]?.[0])).toContain('/api/v1/media/vid-1');
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });

  it('vídeo sem miniatura (enviado pelo CRM) mostra fundo neutro e a legenda', () => {
    render(
      <MessageBubble
        type="sent"
        message={message({
          senderType: 'agent',
          messageType: 'video',
          content: 'Veja como coletar',
          attachmentUrl: '/api/v1/media/vid-2',
          media: media({ fileName: 'coleta.mp4', mimeType: 'video/mp4' }),
        })}
      />,
    );
    const play = screen.getByRole('button', { name: 'Reproduzir vídeo' });
    expect(play.querySelector('img')).toBeNull();
    expect(screen.getByText('Veja como coletar')).toBeInTheDocument();
  });

  it('formato que o navegador não toca (.mov no Chrome): aviso + baixar', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['mov'], { type: 'video/quicktime' }),
      fileName: 'IMG_0001.MOV',
    });
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'video',
          attachmentUrl: '/api/v1/media/vid-mov',
          media: media({ fileName: 'IMG_0001.MOV', mimeType: 'video/quicktime' }),
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reproduzir vídeo' }));
    fireEvent.error(await screen.findByTestId('video-player'));
    expect(screen.getByText(/não reproduz o formato deste vídeo/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Baixar vídeo' })).toHaveAttribute('download', 'IMG_0001.MOV');
  });

  it('erro ao baixar o vídeo avisa em vez de player quebrado', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockRejectedValue(new Error('network'));
    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'video', attachmentUrl: '/api/v1/media/vid-3' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Reproduzir vídeo' }));
    expect(await screen.findByText('Não foi possível carregar o vídeo')).toBeInTheDocument();
    expect(screen.queryByTestId('video-player')).not.toBeInTheDocument();
  });
});

describe('documento (D-236 item 4)', () => {
  it('cartão com ícone, nome, tamanho e páginas; o clique abre o PDF', async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['%PDF'], { type: 'application/pdf' }),
      fileName: 'hemograma.pdf',
    });
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'pdf',
          content: 'hemograma.pdf',
          attachmentUrl: '/api/v1/media/pdf-1',
          media: media({
            fileName: 'hemograma.pdf',
            mimeType: 'application/pdf',
            fileSize: 184320,
            pageCount: 3,
          }),
        })}
      />,
    );

    const card = screen.getByTestId('document-card');
    expect(card).toHaveTextContent('PDF');
    expect(card).toHaveTextContent('hemograma.pdf');
    expect(card).toHaveTextContent('180 KB · 3 páginas');
    // O nome aparece uma vez só: no cartão, não repetido como texto do balão.
    expect(screen.getAllByText('hemograma.pdf')).toHaveLength(1);
    expect(fetchAuthenticatedBlobMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Abrir anexo hemograma.pdf' }));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.target).toBe('_blank');
    clickSpy.mockRestore();
  });

  it('ícone pelo tipo do arquivo', () => {
    expect(documentKindLabel('application/pdf', null)).toBe('PDF');
    expect(
      documentKindLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'),
    ).toBe('DOC');
    expect(documentKindLabel('application/vnd.ms-excel', null)).toBe('XLS');
    expect(documentKindLabel(null, 'slides.pptx')).toBe('PPT');
    expect(documentKindLabel('text/csv', null)).toBe('CSV');
    expect(documentKindLabel('text/plain', null)).toBe('TXT');
    expect(documentKindLabel('application/octet-stream', 'x.bin')).toBe('ARQ');
  });

  it('documento antigo sem media ainda abre pelo cartão', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'doc', content: 'planilha', attachmentUrl: '/api/v1/media/d-1' })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Baixar anexo' })).toBeInTheDocument();
    expect(screen.getByText('planilha')).toBeInTheDocument();
  });
});

describe('áudio com velocidade (D-236 item 3)', () => {
  it('1x → 1,5x → 2x → 1x, aplicando no player', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['ogg'], { type: 'audio/ogg' }),
      fileName: 'audio.ogg',
    });
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'audio',
          content: 'audio',
          attachmentUrl: '/api/v1/media/aud-1',
          media: media({ fileName: 'audio', mimeType: 'audio/ogg', durationSec: 7 }),
        })}
      />,
    );
    const player = (await screen.findByTestId('audio-message-player')) as HTMLAudioElement;
    const speed = screen.getByTestId('audio-speed');
    expect(speed).toHaveTextContent('1x');
    expect(player.playbackRate).toBe(1);

    await user.click(speed);
    expect(speed).toHaveTextContent('1,5x');
    expect(player.playbackRate).toBe(1.5);
    await user.click(speed);
    expect(speed).toHaveTextContent('2x');
    expect(player.playbackRate).toBe(2);
    await user.click(speed);
    expect(speed).toHaveTextContent('1x');
    expect(player.playbackRate).toBe(1);
  });
});

describe('figurinha (D-236 item 5)', () => {
  it('pequena, sem balão, sem texto e sem lightbox', async () => {
    const user = userEvent.setup();
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['webp'], { type: 'image/webp' }),
      fileName: 'Figurinha',
    });
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'sticker',
          content: 'Figurinha',
          attachmentUrl: '/api/v1/media/stk-1',
          media: media({ fileName: 'Figurinha', mimeType: 'image/webp' }),
        })}
      />,
    );
    const sticker = await screen.findByRole('img', { name: 'Figurinha' });
    expect(sticker.className).toContain('h-[120px]');
    expect(screen.getByTestId('message-bubble').className).toContain('bg-transparent');
    expect(screen.queryByText('Figurinha', { selector: 'p' })).not.toBeInTheDocument();

    await user.click(sticker);
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });
});

describe('localização (D-236 item 6)', () => {
  it('cartão com nome, endereço e "Abrir no mapa" no ponto certo', () => {
    render(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'location',
          content: '📍 Laboratório Centro',
          location: {
            latitude: -28.4817,
            longitude: -49.0069,
            name: 'Laboratório Centro',
            address: 'Rua Lauro Müller, 100',
          },
        })}
      />,
    );
    const card = screen.getByTestId('location-card');
    expect(card).toHaveTextContent('Laboratório Centro');
    expect(card).toHaveTextContent('Rua Lauro Müller, 100');
    const link = screen.getByRole('link', { name: 'Abrir no mapa' });
    expect(link).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=-28.4817,-49.0069',
    );
    expect(link).toHaveAttribute('target', '_blank');
    // O fallback "📍 …" não aparece repetido como texto.
    expect(screen.queryByText('📍 Laboratório Centro')).not.toBeInTheDocument();
  });

  it('mensagem antiga "[Localizacao] …" (tipo text) continua aparecendo como texto', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ content: '[Localizacao] Casa (-28.4, -49.0)' })}
      />,
    );
    expect(screen.getByText('[Localizacao] Casa (-28.4, -49.0)')).toBeInTheDocument();
    expect(screen.queryByTestId('location-card')).not.toBeInTheDocument();
  });

  it('googleMapsUrl', () => {
    expect(googleMapsUrl({ latitude: 1.5, longitude: -2 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=1.5,-2',
    );
  });
});

describe('contato (D-236 item 7)', () => {
  function contactBubble() {
    return withProviders(
      <MessageBubble
        type="received"
        message={message({
          messageType: 'contact',
          content: '👤 Dr. Silva e mais 1',
          contacts: [
            { name: 'Dr. Silva', phone: '+5548988887777' },
            { name: 'Sem Número', phone: null },
          ],
        })}
      />,
    );
  }

  it('mostra nome e telefone; só quem tem telefone ganha "Conversar"', () => {
    render(contactBubble());
    const card = screen.getByTestId('contact-card');
    expect(card).toHaveTextContent('Dr. Silva');
    expect(card).toHaveTextContent('(48) 98888-7777');
    expect(card).toHaveTextContent('Sem telefone');
    expect(screen.getAllByRole('button', { name: /^Conversar com/ })).toHaveLength(1);
  });

  it('número que já tem conversa abre direto, sem modal e sem mensagem', async () => {
    const user = userEvent.setup();
    openWhatsAppMock.mockResolvedValue({ id: 'c-existente' });
    render(contactBubble());

    await user.click(screen.getByRole('button', { name: 'Conversar com Dr. Silva' }));

    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/attendance?conversationId=c-existente',
      ),
    );
    expect(openWhatsAppMock).toHaveBeenCalledWith({ phone: '+5548988887777' });
    expect(startWhatsAppMock).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Telefone (WhatsApp)')).not.toBeInTheDocument();
  });

  it('número sem conversa (404) cai na Nova conversa com o telefone preenchido', async () => {
    const user = userEvent.setup();
    openWhatsAppMock.mockRejectedValue(new ApiError('NOT_FOUND', 'nao encontrada', 404));
    startWhatsAppMock.mockResolvedValue({
      conversation: { id: 'c-novo' },
      message: message({ id: 'm-novo', conversationId: 'c-novo' }),
    });
    render(contactBubble());

    await user.click(screen.getByRole('button', { name: 'Conversar com Dr. Silva' }));
    expect(await screen.findByLabelText('Telefone (WhatsApp)')).toHaveValue('+5548988887777');
    await user.type(screen.getByLabelText('Mensagem'), 'Olá, doutor!');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));

    await waitFor(() =>
      expect(startWhatsAppMock).toHaveBeenCalledWith({
        phone: '+5548988887777',
        content: 'Olá, doutor!',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent('/attendance?conversationId=c-novo'),
    );
  });

  it('conversa de outra atendente (409): avisa com o nome e não navega', async () => {
    const user = userEvent.setup();
    openWhatsAppMock.mockRejectedValue(
      new ApiError('CONVERSATION_ALREADY_ASSIGNED', 'ja atribuida', 409, {
        assignedTo: 'u-2',
        assignedToName: 'Bia',
      }),
    );
    render(contactBubble());

    await user.click(screen.getByRole('button', { name: 'Conversar com Dr. Silva' }));
    expect(
      await screen.findByText('Este número já está em atendimento com Bia.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/attendance');
    expect(screen.getByTestId('location')).not.toHaveTextContent('conversationId');
    expect(screen.queryByLabelText('Telefone (WhatsApp)')).not.toBeInTheDocument();
  });

  it('formatContactPhone', () => {
    expect(formatContactPhone('+5548988887777')).toBe('(48) 98888-7777');
    expect(formatContactPhone('+554833334444')).toBe('(48) 3333-4444');
    expect(formatContactPhone('+14155550100')).toBe('+14155550100');
  });
});

describe('texto do balão e bloco citado', () => {
  it('showsMessageText: some só o fallback', () => {
    expect(showsMessageText(message())).toBe(true);
    expect(showsMessageText(message({ messageType: 'location', content: '📍 X' }))).toBe(false);
    expect(showsMessageText(message({ messageType: 'contact', content: '👤 X' }))).toBe(false);
    expect(
      showsMessageText(
        message({
          messageType: 'image',
          content: 'foto.jpg',
          attachmentUrl: '/api/v1/media/i',
          media: media({ fileName: 'foto.jpg' }),
        }),
      ),
    ).toBe(false);
    expect(
      showsMessageText(
        message({
          messageType: 'image',
          content: 'legenda',
          attachmentUrl: '/api/v1/media/i',
          media: media({ fileName: 'foto.jpg' }),
        }),
      ),
    ).toBe(true);
  });

  it('formatClock', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('citada de vídeo/figurinha/localização/contato ganha rótulo', () => {
    const base = { id: 'q', senderType: 'patient' as const, senderName: null, preview: '', deleted: false };
    expect(quotedLabel({ ...base, messageType: 'video' })).toBe('🎥 Vídeo');
    expect(quotedLabel({ ...base, messageType: 'sticker' })).toBe('Figurinha');
    expect(quotedLabel({ ...base, messageType: 'location' })).toBe('📍 Localização');
    expect(quotedLabel({ ...base, messageType: 'contact' })).toBe('👤 Contato');
  });
});
