import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@crm-lab/shared';
import { ConversationItem } from './ConversationItem';

/**
 * ConversationItem — anatomia de COMPONENTS.md. Os testes cobrem exatamente os
 * pontos onde o layout costuma quebrar: avatar comprimido, prévia em duas
 * linhas, badge fantasma e a cor da hora.
 */

const NOW = new Date('2026-08-23T09:16:00Z');

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c-1',
    patientId: 'p-1',
    patientName: 'Marina Alves',
    patientPhone: '(11) 98765-4321',
    assignedTo: 'u-1',
    assignedToName: 'Marina',
    channel: 'whatsapp',
    status: 'active',
    unreadCount: 3,
    lastMessagePreview: 'Quanto fica hemograma, TSH e vitamina D?',
    lastMessageAt: '2026-08-23T09:12:00Z',
    tags: ['Orçamento'],
    pinned: false,
    createdAt: '2026-08-20T10:00:00Z',
    ...overrides,
  };
}

describe('ConversationItem', () => {
  it('hora em sálvia quando há não lidas', () => {
    render(<ConversationItem conversation={conversation({ unreadCount: 3 })} now={NOW} />);
    const time = screen.getByTestId('conversation-time');

    expect(time).toHaveAttribute('data-unread', 'true');
    expect(time.className).toContain('text-accent2-700');
    expect(time.className).not.toContain('text-neutral-600');
  });

  it('hora em cinza quando está lido', () => {
    render(<ConversationItem conversation={conversation({ unreadCount: 0 })} now={NOW} />);
    const time = screen.getByTestId('conversation-time');

    expect(time).toHaveAttribute('data-unread', 'false');
    expect(time.className).toContain('text-neutral-600');
    expect(time.className).not.toContain('text-accent2-700');
  });

  it('prévia fica em UMA linha com elipse', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} />);
    const preview = screen.getByTestId('conversation-preview');

    expect(preview).toHaveTextContent('Quanto fica hemograma, TSH e vitamina D?');
    expect(preview.className).toContain('truncate');
    expect(preview.className).toContain('min-w-0');
  });

  it('badge só aparece com unreadCount > 0', () => {
    const { rerender } = render(
      <ConversationItem conversation={conversation({ unreadCount: 3 })} now={NOW} />,
    );
    expect(screen.getByLabelText('3 mensagens não lidas')).toHaveTextContent('3');

    rerender(<ConversationItem conversation={conversation({ unreadCount: 0 })} now={NOW} />);
    expect(screen.queryByLabelText(/mensagens não lidas/)).not.toBeInTheDocument();
  });

  it('avatar de 36px nunca comprime', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} />);
    const avatar = screen.getByTitle('Marina Alves');

    expect(avatar).toHaveStyle({ flex: '0 0 36px', width: '36px', height: '36px' });
  });

  it('mostra "aguardando N min" em accent-700 quando há não lidas', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} />);
    const waiting = screen.getByTestId('conversation-waiting');

    expect(waiting).toHaveTextContent('aguardando 4 min');
    expect(waiting.className).toContain('text-accent-700');
  });

  it('espera longa sai em dias/horas, nao em minuto cru', () => {
    // A fila real mostrava "aguardando 57871 min": ninguem le prioridade
    // nisso. Mesma escala do resto do app (`formatDurationSeconds`).
    const doisDias = new Date(new Date(NOW).getTime() - 50 * 60 * 60 * 1000).toISOString();
    render(<ConversationItem conversation={conversation({ lastMessageAt: doisDias })} now={NOW} />);
    expect(screen.getByTestId('conversation-waiting')).toHaveTextContent('aguardando 2d 2h');
  });

  it('sem não lidas não existe espera', () => {
    render(<ConversationItem conversation={conversation({ unreadCount: 0 })} now={NOW} />);
    expect(screen.queryByTestId('conversation-waiting')).not.toBeInTheDocument();
  });

  it('selecionado: fundo neutral-100 + shadow-sm', () => {
    render(<ConversationItem conversation={conversation()} selected now={NOW} />);
    const item = screen.getByTestId('conversation-item');

    expect(item).toHaveAttribute('data-selected', 'true');
    expect(item.className).toContain('bg-neutral-100');
    expect(item.className).toContain('shadow-sm');
  });

  it('sem nome de paciente, cai no telefone', () => {
    render(<ConversationItem conversation={conversation({ patientName: null })} now={NOW} />);
    expect(screen.getAllByText('(11) 98765-4321').length).toBeGreaterThan(0);
  });

  it('clique devolve o id da conversa', async () => {
    const onClick = vi.fn();
    render(<ConversationItem conversation={conversation()} onClick={onClick} now={NOW} />);

    await userEvent.click(screen.getByTestId('conversation-item'));
    expect(onClick).toHaveBeenCalledWith('c-1');
  });
});

describe('ConversationItem — fixar (Onda 8 §2.3)', () => {
  it('sem `onTogglePin` não existe botão de fixar (nada de botão morto)', () => {
    render(<ConversationItem conversation={conversation()} now={NOW} />);
    expect(screen.queryByRole('button', { name: /fixar/i })).not.toBeInTheDocument();
  });

  it('fixar chama o handler com o estado NOVO, e desafixar com o inverso', async () => {
    const user = userEvent.setup();
    const onTogglePin = vi.fn();

    const { rerender } = render(
      <ConversationItem conversation={conversation()} now={NOW} onTogglePin={onTogglePin} />,
    );
    await user.click(screen.getByRole('button', { name: 'Fixar conversa com Marina Alves' }));
    expect(onTogglePin).toHaveBeenCalledWith('c-1', true);

    rerender(
      <ConversationItem
        conversation={conversation({ pinned: true })}
        now={NOW}
        onTogglePin={onTogglePin}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Desafixar conversa com Marina Alves' }));
    expect(onTogglePin).toHaveBeenLastCalledWith('c-1', false);
  });

  it('fixar NÃO abre a conversa — o clique não vaza para o item', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <ConversationItem
        conversation={conversation()}
        now={NOW}
        onClick={onClick}
        onTogglePin={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Fixar conversa com Marina Alves' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
