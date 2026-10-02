import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, Message } from '@crm-lab/shared';
import { ConversationPanel } from './ConversationPanel';
import type { ConversationPanelProps } from './ConversationPanel';

/**
 * Painel da conversa — responder citando, reagir e rolar até a original
 * (CRMLAB-66, D-221/D-222). A leitura (CRMLAB-71) tem spec própria.
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

function props(messages: Message[], overrides: Partial<ConversationPanelProps> = {}): ConversationPanelProps {
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

describe('ConversationPanel — responder citando', () => {
  it('Responder abre a faixa; enviar manda o quotedMessageId e a faixa some', async () => {
    const onSend = vi.fn();
    render(<ConversationPanel {...props([message('m-1', { content: 'Posso ir amanhã?' })], { onSend })} />);

    await openMenuOf('Posso ir amanhã?');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    expect(screen.getByTestId('reply-banner')).toHaveTextContent('Respondendo a Marina Alves: Posso ir amanhã?');

    await userEvent.type(screen.getByLabelText('Mensagem'), 'Pode sim');
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('Pode sim', 'm-1');
    expect(screen.queryByTestId('reply-banner')).toBeNull();
  });

  it('sem resposta escolhida, o envio vai sem citação', async () => {
    const onSend = vi.fn();
    render(<ConversationPanel {...props([message('m-1')], { onSend })} />);
    await userEvent.type(screen.getByLabelText('Mensagem'), 'Oi');
    await userEvent.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('Oi', undefined);
  });

  it('anexo com resposta escolhida leva o quotedMessageId (CRMLAB-69: pela prévia)', async () => {
    const onSendAttachments = vi.fn();
    render(
      <ConversationPanel
        {...props([message('m-1', { content: 'manda o pedido' })], { onSendAttachments })}
      />,
    );
    await openMenuOf('manda o pedido');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    const pdf = new File(['%PDF'], 'pedido.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByTestId('attach-document-input'), pdf);
    const preview = screen.getByRole('dialog', { name: 'Prévia do anexo' });
    await userEvent.click(within(preview).getByRole('button', { name: 'Enviar' }));
    expect(onSendAttachments).toHaveBeenCalledWith([{ file: pdf, caption: '' }], 'm-1');
    expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument();
  });

  it('atendimento encerrado: sem Responder nem Reagir', async () => {
    render(
      <ConversationPanel
        {...props([message('m-1', { content: 'fim' })], {
          conversation: { ...CONVERSATION, status: 'closed' },
          onReact: vi.fn(),
        })}
      />,
    );
    await openMenuOf('fim');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Copiar']);
  });
});

describe('ConversationPanel — reagir e rolar até a original', () => {
  it('Reagir entrega o id da mensagem e o emoji', async () => {
    const onReact = vi.fn();
    render(<ConversationPanel {...props([message('m-1', { content: 'obrigada' })], { onReact })} />);
    await openMenuOf('obrigada');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reagir' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reagir com 🙏' }));
    expect(onReact).toHaveBeenCalledWith('m-1', '🙏');
  });

  it('clicar na citação acende a original carregada', async () => {
    const original = message('m-1', { content: 'original' });
    const reply = message('m-2', {
      senderType: 'agent',
      senderName: 'Ana',
      content: 'resposta',
      quotedMessageId: 'm-1',
      quoted: { id: 'm-1', senderType: 'patient', senderName: 'Marina', preview: 'original', messageType: 'text', deleted: false },
    });
    const onQuoteUnavailable = vi.fn();
    render(<ConversationPanel {...props([original, reply], { onQuoteUnavailable })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Ir para a mensagem citada' }));
    const target = document.querySelector('[data-message-id="m-1"]') as HTMLElement;
    expect(target.dataset.highlighted).toBe('true');
    expect(onQuoteUnavailable).not.toHaveBeenCalled();
  });

  it('original fora do que foi carregado: avisa', async () => {
    const reply = message('m-2', {
      content: 'resposta',
      quotedMessageId: 'm-antiga',
      quoted: { id: 'm-antiga', senderType: 'agent', senderName: 'Ana', preview: 'lá atrás', messageType: 'text', deleted: false },
    });
    const onQuoteUnavailable = vi.fn();
    render(<ConversationPanel {...props([reply], { onQuoteUnavailable })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ir para a mensagem citada' }));
    expect(onQuoteUnavailable).toHaveBeenCalledTimes(1);
  });
});
