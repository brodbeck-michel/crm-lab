import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import type * as ApiModule from '@/api';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Painel — lightbox com setas entre as imagens da conversa (CRMLAB-64,
 * D-244/D-245): um lightbox só, do painel, ancorado no id da mensagem.
 */
const fetchAuthenticatedBlobMock = vi.fn();
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, fetchAuthenticatedBlob: fetchAuthenticatedBlobMock };
});

const { ConversationPanel } = await import('./ConversationPanel');

const CONVERSATION: ConversationDetail = {
  id: 'c-1',
  patientId: 'p-1',
  patientName: 'Marina Alves',
  patientPhone: '(11) 98765-4321',
  patientEmail: null,
  assignedTo: 'u-1',
  assignedToName: 'Marina',
  channel: 'whatsapp',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: null,
  lastMessageAt: '2026-08-23T09:12:00Z',
  tags: [],
  pinned: false,
  customFields: {},
  createdAt: '2026-08-20T10:00:00Z',
};

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'Marina Alves',
    content: `mensagem ${id}`,
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-08-23T09:12:00Z',
    ...overrides,
  };
}

function image(id: string, minute: number, overrides: Partial<Message> = {}): Message {
  return message(id, {
    messageType: 'image',
    attachmentUrl: `/api/v1/media/${id}`,
    content: `${id}.jpg`,
    createdAt: `2026-08-23T09:${String(minute).padStart(2, '0')}:00Z`,
    ...overrides,
  });
}

function props(messages: Message[]): ConversationPanelProps {
  return {
    conversation: CONVERSATION,
    messages,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    onSend: vi.fn(),
    sending: false,
    quickReplies: [],
    assignees: [],
    onAssign: vi.fn(),
    onCloseAttendance: vi.fn(),
    canCloseAttendance: true,
    onToggleContext: vi.fn(),
    onClose: vi.fn(),
    onSendAttachments: vi.fn(),
    contextOpen: true,
    hasOlderMessages: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    unreadAtOpen: 0,
  };
}

beforeEach(() => {
  fetchAuthenticatedBlobMock.mockReset();
  fetchAuthenticatedBlobMock.mockImplementation((url: string) => {
    const id = String(url).split('/').pop() ?? '';
    return Promise.resolve({ blob: new Blob([id], { type: 'image/jpeg' }), fileName: `${id}.jpg` });
  });
  let n = 0;
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${++n}-${(blob as Blob).size}`);
  URL.revokeObjectURL = vi.fn();
});

/** A foto na tela é identificada pelo nome do download (o do arquivo dela). */
function shownFile(): string | null {
  return screen.getByRole('link', { name: 'Baixar imagem' }).getAttribute('download');
}

async function openThumbnail(index: number): Promise<void> {
  const thumbnails = await screen.findAllByRole('img', { name: 'Anexo enviado na conversa' });
  const target = thumbnails[index];
  if (!target) throw new Error(`thumbnail ${index} não existe`);
  await userEvent.click(target);
}

describe('ConversationPanel — lightbox com setas', () => {
  const MESSAGES = [
    image('img-1', 1, { senderType: 'agent', senderName: 'Atendente Ana' }),
    message('t-1', { createdAt: '2026-08-23T09:02:00Z' }),
    image('img-2', 3, { content: 'Verso do pedido' }),
    image('img-3', 5),
  ];

  it('setas percorrem as imagens da conversa em ordem, sem dar a volta', async () => {
    render(<ConversationPanel {...props(MESSAGES)} />);
    await openThumbnail(0);

    await waitFor(() => expect(shownFile()).toBe('img-1.jpg'));
    expect(screen.getByTestId('image-lightbox-title')).toHaveTextContent(/^Atendente Ana · /);
    expect(screen.queryByRole('button', { name: 'Imagem anterior' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Próxima imagem' }));
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));
    expect(screen.getByTestId('image-lightbox-caption')).toHaveTextContent('Verso do pedido');

    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(shownFile()).toBe('img-3.jpg'));
    // Sem legenda: o `content` é só o nome do arquivo.
    expect(screen.queryByTestId('image-lightbox-caption')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Próxima imagem' })).not.toBeInTheDocument();

    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });

  it('reaproveita o blob do balão: abrir e navegar não baixam de novo', async () => {
    render(<ConversationPanel {...props(MESSAGES)} />);
    await openThumbnail(1);
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(shownFile()).toBe('img-3.jpg'));

    expect(fetchAuthenticatedBlobMock).toHaveBeenCalledTimes(3);
  });

  it('conversa com uma imagem só: nenhuma seta', async () => {
    render(<ConversationPanel {...props([image('img-1', 1), message('t-1')])} />);
    await openThumbnail(0);
    await waitFor(() => expect(shownFile()).toBe('img-1.jpg'));
    expect(screen.queryByRole('button', { name: 'Imagem anterior' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Próxima imagem' })).not.toBeInTheDocument();
  });

  it('imagem nova pelo WS e histórico carregado não fecham nem pulam a foto aberta', async () => {
    const { rerender } = render(<ConversationPanel {...props(MESSAGES)} />);
    await openThumbnail(1);
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));

    // Chega uma imagem mais nova (WS) e uma página mais antiga (rolagem).
    rerender(<ConversationPanel {...props([image('img-0', 0), ...MESSAGES, image('img-4', 7)])} />);
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));
    expect(screen.getByTestId('image-lightbox-backdrop')).toBeInTheDocument();

    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    await waitFor(() => expect(shownFile()).toBe('img-4.jpg'));
  });

  it('mensagem apagada não entra na navegação; a aberta apagada fecha o lightbox', async () => {
    const deleted = image('img-x', 4, { deletedAt: '2026-08-23T10:00:00Z', attachmentUrl: null });
    const { rerender } = render(<ConversationPanel {...props([...MESSAGES, deleted])} />);
    await openThumbnail(1);
    await waitFor(() => expect(shownFile()).toBe('img-2.jpg'));
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(shownFile()).toBe('img-3.jpg'));

    rerender(
      <ConversationPanel
        {...props(
          MESSAGES.map((m) =>
            m.id === 'img-3' ? { ...m, deletedAt: '2026-08-23T10:00:00Z', attachmentUrl: null } : m,
          ),
        )}
      />,
    );
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
  });

  it('trocar de conversa fecha o lightbox', async () => {
    const { rerender } = render(<ConversationPanel {...props(MESSAGES)} />);
    await openThumbnail(0);
    await waitFor(() => expect(shownFile()).toBe('img-1.jpg'));

    rerender(
      <ConversationPanel {...props(MESSAGES)} conversation={{ ...CONVERSATION, id: 'c-2' }} />,
    );
    expect(screen.queryByTestId('image-lightbox-backdrop')).not.toBeInTheDocument();
    // O balão continua lá — só o lightbox fechou.
    expect(within(screen.getByTestId('message-scroll')).getAllByRole('img').length).toBeGreaterThan(
      0,
    );
  });
});
