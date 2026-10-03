import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Conversation } from '@crm-lab/shared';
import { ConversationItem } from './ConversationItem';

/**
 * Alerta de tempo de resposta no item (CRMLAB-84, D-254). O item só pinta: os
 * minutos úteis chegam prontos da lista em `responseAlertMinutes`.
 */

const NOW = new Date('2026-10-02T15:00:00Z');

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '(48) 98765-4321',
    assignedTo: null,
    assignedToName: null,
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 2,
    lastMessagePreview: 'Oi, tem horário amanhã?',
    lastMessageAt: '2026-10-02T14:30:00Z',
    tags: [],
    pinned: false,
    createdAt: '2026-10-01T10:00:00Z',
    awaitingReplySince: '2026-10-02T14:30:00Z',
    ...overrides,
  };
}

describe('ConversationItem — alerta de tempo de resposta', () => {
  it('em alerta: fundo vermelho claro, faixa à esquerda e relógio "há 23 min" no lugar do "aguardando"', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} responseAlertMinutes={23} />);
    const item = screen.getByTestId('conversation-item');
    expect(item).toHaveAttribute('data-response-alert', 'true');
    expect(item.className).toContain('bg-chat-alert-bg');
    expect(item.className).toContain('var(--color-chat-alert)');

    const alert = screen.getByTestId('conversation-response-alert');
    expect(alert).toHaveTextContent('Aguardando resposta');
    expect(alert).toHaveTextContent('há 23 min');
    expect(alert.className).toContain('text-chat-alert');
    expect(screen.queryByTestId('conversation-waiting')).not.toBeInTheDocument();
  });

  it('tempo longo usa a escala do app ("há 2h05")', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} responseAlertMinutes={125} />);
    expect(screen.getByTestId('conversation-response-alert')).toHaveTextContent('há 2h05');
  });

  it('fora do alerta: sem destaque, e o "aguardando" das não lidas continua', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} />);
    const item = screen.getByTestId('conversation-item');
    expect(item).toHaveAttribute('data-response-alert', 'false');
    expect(item.className).not.toContain('bg-chat-alert-bg');
    expect(screen.queryByTestId('conversation-response-alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-waiting')).toHaveTextContent('aguardando 30 min');
  });

  it('selecionada em alerta mantém o fundo de selecionada, com a faixa', () => {
    render(
      <ConversationItem conversation={conversation()} now={NOW} selected responseAlertMinutes={40} />,
    );
    const item = screen.getByTestId('conversation-item');
    expect(item.className).toContain('bg-chat-selected');
    expect(item.className).not.toContain('bg-chat-alert-bg');
    expect(item.className).toContain('var(--color-chat-alert)');
  });
});
