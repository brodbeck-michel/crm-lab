import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Message, SenderType } from '@crm-lab/shared';
import {
  INBOX_BUBBLE_MAX_WIDTH,
  MESSAGE_BUBBLE_TYPES,
  MessageBubble,
  bubbleTypeFor,
} from './MessageBubble';

/**
 * MessageBubble — COMPONENTS.md: TRÊS tipos, nunca mais.
 * O teste existe para que um quarto tipo não entre sem alguém decidir.
 */

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'patient',
    senderId: null,
    senderName: 'João Santos',
    content: 'Quanto custa um hemograma?',
    messageType: 'text',
    attachmentUrl: null,
    status: 'read',
    readAt: null,
    createdAt: '2026-08-23T14:25:00Z',
    ...overrides,
  };
}

describe('MessageBubble', () => {
  it('tem exatamente 3 tipos', () => {
    expect(MESSAGE_BUBBLE_TYPES).toEqual(['received', 'sent', 'system']);
    expect(MESSAGE_BUBBLE_TYPES).toHaveLength(3);
  });

  it('todo senderType da API cai em um dos 3 tipos', () => {
    const senders: SenderType[] = ['patient', 'agent', 'system'];
    const mapped = senders.map(bubbleTypeFor);

    expect(mapped).toEqual(['received', 'sent', 'system']);
    for (const type of mapped) {
      expect(MESSAGE_BUBBLE_TYPES).toContain(type);
    }
  });

  it('recebida encosta à esquerda com o canto apontado embaixo-esquerda', () => {
    render(<MessageBubble type="received" message={message()} />);
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'received');
    expect(bubble.className).toContain('self-start');
    expect(bubble.className).toContain('rounded-bl-sm');
  });

  it('enviada encosta à direita com o canto apontado embaixo-direita', () => {
    render(
      <MessageBubble
        type="sent"
        message={message({ senderType: 'agent', senderName: 'Marina (Atendente)' })}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'sent');
    expect(bubble.className).toContain('self-end');
    expect(bubble.className).toContain('rounded-br-sm');
  });

  it('evento de sistema é pílula centrada, sem meta e sem largura máxima', () => {
    render(
      <MessageBubble
        type="system"
        message={message({ senderType: 'system', content: 'Orçamento #4776 enviado' })}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');

    expect(bubble).toHaveAttribute('data-type', 'system');
    expect(bubble.className).toContain('self-center');
    expect(bubble.style.maxWidth).toBe('');
    expect(screen.queryByTestId('message-meta')).not.toBeInTheDocument();
  });

  it('largura máxima no inbox é 62% (PAGES.md §2 vence os 78% da regra geral)', () => {
    expect(INBOX_BUBBLE_MAX_WIDTH).toBe('62%');

    render(<MessageBubble type="received" message={message()} />);
    expect(screen.getByTestId('message-bubble').style.maxWidth).toBe('62%');
  });

  it('mostra anexo quando a mensagem tem arquivo', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ messageType: 'pdf', attachmentUrl: 'https://arquivo/pedido.pdf' })}
      />,
    );

    expect(screen.getByRole('link', { name: /Anexo/ })).toHaveAttribute(
      'href',
      'https://arquivo/pedido.pdf',
    );
  });
});
