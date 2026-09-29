import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import { ConversationPanel } from './ConversationPanel';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Painel da conversa — anexos com prévia (CRMLAB-69, D-232/D-233): arrastar,
 * Esc, citação e troca de conversa. A prévia em si tem spec própria
 * (`AttachmentPreview.spec.tsx`).
 */

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

function props(
  messages: Message[],
  overrides: Partial<ConversationPanelProps> = {},
): ConversationPanelProps {
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
    ...overrides,
  };
}

async function openMenuOf(text: string): Promise<void> {
  const bubble = screen.getByText(text).closest('[data-testid="message-bubble"]') as HTMLElement;
  await userEvent.click(within(bubble).getByRole('button', { name: 'Ações da mensagem' }));
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:img');
  URL.revokeObjectURL = vi.fn();
});

function dataTransfer(files: File[], types = ['Files']) {
  return { files, items: [], types };
}

const pdf = () => new File(['%PDF-1.4'], 'pedido.pdf', { type: 'application/pdf' });

describe('ConversationPanel — arrastar arquivo (CRMLAB-69)', () => {
  it('arrastar mostra "Solte o arquivo aqui"; soltar um PDF abre a prévia com nome e tamanho', () => {
    render(<ConversationPanel {...props([message('m-1')])} />);
    const area = screen.getByTestId('conversation-drop-area');
    const file = pdf();

    fireEvent.dragEnter(area, { dataTransfer: dataTransfer([file]) });
    expect(screen.getByText('Solte o arquivo aqui')).toBeInTheDocument();
    fireEvent.drop(area, { dataTransfer: dataTransfer([file]) });

    expect(screen.queryByText('Solte o arquivo aqui')).not.toBeInTheDocument();
    const preview = screen.getByRole('dialog', { name: 'Prévia do anexo' });
    expect(within(preview).getAllByText('pedido.pdf').length).toBeGreaterThan(0);
    expect(within(preview).getByText('8 B')).toBeInTheDocument();
    // A lista NÃO desmonta por baixo da prévia (D-232 item 3).
    expect(screen.getByTestId('message-scroll')).toBeInTheDocument();
  });

  it('arrastar TEXTO não mostra a área de soltar', () => {
    render(<ConversationPanel {...props([message('m-1')])} />);
    fireEvent.dragEnter(screen.getByTestId('conversation-drop-area'), {
      dataTransfer: dataTransfer([], ['text/plain']),
    });
    expect(screen.queryByText('Solte o arquivo aqui')).not.toBeInTheDocument();
  });

  it('sair arrastando esconde a área', () => {
    render(<ConversationPanel {...props([message('m-1')])} />);
    const area = screen.getByTestId('conversation-drop-area');
    fireEvent.dragEnter(area, { dataTransfer: dataTransfer([pdf()]) });
    fireEvent.dragLeave(area, { dataTransfer: dataTransfer([pdf()]) });
    expect(screen.queryByText('Solte o arquivo aqui')).not.toBeInTheDocument();
  });

  it('conversa encerrada não aceita arquivo arrastado', () => {
    render(
      <ConversationPanel
        {...props([message('m-1')], { conversation: { ...CONVERSATION, status: 'closed' } })}
      />,
    );
    const area = screen.getByTestId('conversation-drop-area');
    fireEvent.dragEnter(area, { dataTransfer: dataTransfer([pdf()]) });
    fireEvent.drop(area, { dataTransfer: dataTransfer([pdf()]) });
    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
  });
});

describe('ConversationPanel — prévia e envio (CRMLAB-69)', () => {
  it('Enviar manda só os válidos, na ordem, com a legenda aparada, e fecha a prévia', async () => {
    const onSendAttachments = vi.fn();
    render(<ConversationPanel {...props([message('m-1')], { onSendAttachments })} />);
    const a = new File(['a'], 'a.png', { type: 'image/png' });
    const bloqueado = new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' });
    const c = pdf();
    await userEvent.upload(screen.getByTestId('attach-document-input'), [a, bloqueado, c]);

    await userEvent.type(screen.getByLabelText('Adicionar legenda'), '  Seu pedido  ');
    const preview = screen.getByRole('dialog', { name: 'Prévia do anexo' });
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));

    expect(onSendAttachments).toHaveBeenCalledWith(
      [
        { file: a, caption: 'Seu pedido' },
        { file: c, caption: '' },
      ],
      undefined,
    );
    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
  });

  it('Esc fecha a prévia e a faixa "Respondendo a…" continua', async () => {
    const onSendAttachments = vi.fn();
    render(
      <ConversationPanel
        {...props([message('m-1', { content: 'manda' })], { onSendAttachments })}
      />,
    );
    await openMenuOf('manda');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));

    await userEvent.upload(screen.getByTestId('attach-media-input'), [
      new File(['a'], 'a.png', { type: 'image/png' }),
    ]);
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
    expect(screen.getByTestId('reply-banner')).toBeInTheDocument();
    expect(onSendAttachments).not.toHaveBeenCalled();
  });

  it('o rascunho do composer continua depois de fechar a prévia', async () => {
    render(<ConversationPanel {...props([message('m-1')])} />);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'meio escrito');
    await userEvent.upload(screen.getByTestId('attach-media-input'), [
      new File(['a'], 'a.png', { type: 'image/png' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Descartar anexos' }));
    expect(screen.getByLabelText('Mensagem')).toHaveValue('meio escrito');
  });

  it('trocar de conversa descarta a prévia', async () => {
    const { rerender } = render(<ConversationPanel {...props([message('m-1')])} />);
    await userEvent.upload(screen.getByTestId('attach-media-input'), [
      new File(['a'], 'a.png', { type: 'image/png' }),
    ]);
    expect(screen.getByRole('dialog', { name: 'Prévia do anexo' })).toBeInTheDocument();

    rerender(
      <ConversationPanel
        {...props([message('m-9', { conversationId: 'c-2' })], {
          conversation: { ...CONVERSATION, id: 'c-2' },
        })}
      />,
    );
    expect(screen.queryByRole('dialog', { name: 'Prévia do anexo' })).not.toBeInTheDocument();
  });
});
