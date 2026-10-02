import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageStatus } from '@crm-lab/shared';
import { MessageBubble } from './MessageBubble';

/** Tiques e "Tentar de novo" (CRMLAB-67, D-225/D-227). */

function message(status: MessageStatus, overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'agent',
    senderId: 'u-1',
    senderName: 'Ana',
    content: 'Seu exame fica pronto amanhã',
    messageType: 'text',
    attachmentUrl: null,
    status,
    readAt: null,
    createdAt: '2026-09-29T14:32:00Z',
    ...overrides,
  };
}

describe('MessageBubble — tiques (D-225)', () => {
  it.each([
    ['pending', '🕓', 'Enviando'],
    ['sent', '✓', 'Enviada'],
    ['delivered', '✓✓', 'Entregue'],
    ['read', '✓✓', 'Lida'],
    ['failed', '⚠', 'Falhou'],
  ] as const)('%s mostra %s ("%s")', (status, glyph, label) => {
    render(<MessageBubble type="sent" message={message(status)} />);
    const tick = screen.getByTestId('message-status');
    expect(tick).toHaveAttribute('data-status', status);
    expect(tick).toHaveTextContent(glyph);
    expect(screen.getByRole('img', { name: label })).toBe(tick);
  });

  it('lida é azul (token), entregue é cinza — mesmo glifo', () => {
    const { rerender } = render(<MessageBubble type="sent" message={message('read')} />);
    expect(screen.getByTestId('message-status').className).toContain('text-chat-tick-read');
    rerender(<MessageBubble type="sent" message={message('delivered')} />);
    expect(screen.getByTestId('message-status').className).toContain('text-chat-meta');
  });

  it('mensagem do paciente não tem tique', () => {
    render(<MessageBubble type="received" message={message('read', { senderType: 'patient' })} />);
    expect(screen.queryByTestId('message-status')).toBeNull();
  });
});

describe('MessageBubble — falhou (D-227)', () => {
  it('mostra o aviso e o botão chama onRetry com a mensagem', async () => {
    const onRetry = vi.fn();
    const failed = message('failed');
    render(<MessageBubble type="sent" message={failed} onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível enviar');
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  it('sem handler, fica só o aviso (nada de botão morto)', () => {
    render(<MessageBubble type="sent" message={message('failed')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível enviar');
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('enviada normal não mostra aviso', () => {
    render(<MessageBubble type="sent" message={message('sent')} onRetry={vi.fn()} />);
    expect(screen.queryByTestId('message-failed')).toBeNull();
  });
});
