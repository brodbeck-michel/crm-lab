import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Channel,
  InternalMessage,
  InternalMessageAttachment,
  ListInternalMessagesResponse,
} from '@crm-lab/shared';
import type * as ApiModule from '@/api';

/**
 * Chat Interno — anexo de arquivo (CRMLAB-101, D-271, PAGES.md §9).
 *
 * O que este teste protege: o clipe abre a prévia e cada arquivo sai por
 * `POST /internal-chat/channels/:id/attachments` com a legenda como `content`;
 * imagem aparece como miniatura (buscada com token) que amplia no lightbox; PDF
 * e demais aparecem como cartão com nome e tamanho, que baixa com o nome original.
 */

const channelsMock = vi.fn();
const messagesMock = vi.fn();
const markReadMock = vi.fn();
const directoryMock = vi.fn();
const sendAttachmentMock = vi.fn();
const fetchAuthenticatedBlobMock = vi.fn();

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    fetchAuthenticatedBlob: fetchAuthenticatedBlobMock,
    api: {
      ...actual.api,
      internalChat: {
        ...actual.api.internalChat,
        channels: channelsMock,
        messages: messagesMock,
        markRead: markReadMock,
        directory: directoryMock,
        sendAttachment: sendAttachmentMock,
      },
    },
  };
});

const { ToastProvider } = await import('@/components/ui');
const { useAuthStore } = await import('@/stores');
const { InternalChat } = await import('./index');

const GERAL: Channel = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'geral',
  name: '#geral',
  kind: 'channel',
  unreadCount: 0,
  lastReadAt: null,
  lastMessageAt: null,
  otherUserId: null,
  otherUserName: null,
};

function attachment(overrides: Partial<InternalMessageAttachment>): InternalMessageAttachment {
  const id = overrides.id ?? 'a-1';
  return {
    id,
    fileName: 'arquivo.bin',
    mimeType: 'application/pdf',
    byteSize: 2048,
    url: `/api/v1/internal-chat/channels/${GERAL.id}/attachments/${id}`,
    ...overrides,
  };
}

function message(overrides: Partial<InternalMessage>): InternalMessage {
  return {
    id: 'm-1',
    channelId: GERAL.id,
    senderId: 'u-9',
    senderName: 'Carla Souza',
    content: '',
    attachedProposalId: null,
    attachment: null,
    isSystem: false,
    createdAt: '2026-10-19T09:00:00Z',
    ...overrides,
  };
}

function messagesResponse(messages: InternalMessage[]): ListInternalMessagesResponse {
  return { messages, pagination: { page: 1, limit: 50, total: messages.length, totalPages: 1 } };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/internal-chat']}>
          <InternalChat />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: { id: 'u-1', email: 'ana@lab.com', name: 'Ana', role: 'attendant', discountLimit: 10 },
    tenant: null,
    theme: null,
    tokens: { accessToken: 'a', expiresAt: Date.now() + 60_000 },
  });
  channelsMock.mockResolvedValue({ channels: [GERAL] });
  messagesMock.mockResolvedValue(messagesResponse([]));
  markReadMock.mockResolvedValue(undefined);
  directoryMock.mockResolvedValue({ users: [] });
  sendAttachmentMock.mockResolvedValue(message({ id: 'm-novo' }));
  fetchAuthenticatedBlobMock.mockImplementation((url: string) =>
    Promise.resolve({
      blob: new Blob(['x'], { type: 'image/png' }),
      fileName: String(url).split('/').pop(),
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:anexo');
  URL.revokeObjectURL = vi.fn();
});

describe('Chat Interno — anexo de arquivo (CRMLAB-101)', () => {
  it('o clipe abre a prévia e o envio sai pelo endpoint de anexo com a legenda', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText('Nenhuma mensagem ainda');

    await user.click(screen.getByRole('button', { name: 'Anexar arquivo' }));
    const pdf = new File(['%PDF-1.4'], 'pedido.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByTestId('attach-document-input'), pdf);

    const preview = await screen.findByRole('dialog', { name: 'Prévia do anexo' });
    await user.type(within(preview).getByLabelText('Adicionar legenda'), 'Pedido da sala 2');
    await user.click(within(preview).getByRole('button', { name: /^Enviar/ }));

    await waitFor(() => expect(sendAttachmentMock).toHaveBeenCalledTimes(1));
    expect(sendAttachmentMock).toHaveBeenCalledWith(GERAL.id, {
      fileName: 'pedido.pdf',
      mimeType: 'application/pdf',
      contentBase64: btoa('%PDF-1.4'),
      content: 'Pedido da sala 2',
    });
    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
  });

  it('imagem vira miniatura buscada com token e amplia no lightbox', async () => {
    const image = attachment({ id: 'img-1', fileName: 'foto.png', mimeType: 'image/png' });
    messagesMock.mockResolvedValue(messagesResponse([message({ attachment: image })]));
    const user = userEvent.setup();
    renderScreen();

    const thumbnail = await screen.findByTestId('internal-attachment-thumbnail');
    expect(thumbnail).toHaveAttribute('src', 'blob:anexo');
    expect(fetchAuthenticatedBlobMock).toHaveBeenCalledWith(expect.stringContaining(image.url));

    await user.click(screen.getByRole('button', { name: 'Ampliar imagem foto.png' }));
    expect(await screen.findByTestId('image-lightbox-backdrop')).toBeInTheDocument();
    // O ↓ do lightbox baixa com o nome original.
    expect(screen.getByRole('link', { name: 'Baixar imagem' })).toHaveAttribute(
      'download',
      'foto.png',
    );
    expect(screen.queryByTestId('document-card')).not.toBeInTheDocument();
  });

  it('PDF vira cartão com nome e tamanho, e baixa com o nome original', async () => {
    const pdf = attachment({ id: 'pdf-1', fileName: 'laudo março.pdf', byteSize: 2048 });
    messagesMock.mockResolvedValue(
      messagesResponse([message({ content: 'Segue o laudo', attachment: pdf })]),
    );
    fetchAuthenticatedBlobMock.mockResolvedValue({
      blob: new Blob(['%PDF'], { type: 'application/pdf' }),
      fileName: 'laudo março.pdf',
    });
    const clicks: { download: string; href: string }[] = [];
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicks.push({ download: this.download, href: this.href });
    };
    const user = userEvent.setup();
    try {
      renderScreen();

      const card = await screen.findByTestId('document-card');
      expect(screen.getByText('Segue o laudo')).toBeInTheDocument();
      expect(card).toHaveTextContent('laudo março.pdf');
      expect(card).toHaveTextContent('2 KB');
      expect(card).toHaveTextContent('PDF');
      expect(screen.queryByTestId('internal-attachment-thumbnail')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Baixar anexo laudo março.pdf' }));
      await waitFor(() => expect(clicks).toHaveLength(1));
      expect(clicks[0]?.download).toBe('laudo março.pdf');
      expect(fetchAuthenticatedBlobMock).toHaveBeenCalledWith(expect.stringContaining(pdf.url));
    } finally {
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});
