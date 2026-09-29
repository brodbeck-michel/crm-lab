import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@crm-lab/shared';
import { MessageBubble, quotedLabel } from './MessageBubble';

/**
 * MessageBubble — CRMLAB-66 (COMPONENTS.md): menu da mensagem, citação,
 * reações, apagada e editada, padrão WhatsApp Web.
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
    quotedMessageId: null,
    quoted: null,
    reactions: [],
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageBubble — menu da mensagem', () => {
  it('a setinha abre Responder · Reagir · Copiar, e Responder entrega a mensagem', async () => {
    const onReply = vi.fn();
    const msg = message();
    render(<MessageBubble type="received" message={msg} onReply={onReply} onReact={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Responder',
      'Reagir',
      'Copiar',
    ]);
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Responder' }));
    expect(onReply).toHaveBeenCalledWith(msg);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('sem handler, a ação some (nada de botão morto)', async () => {
    render(<MessageBubble type="received" message={message()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Copiar',
    ]);
  });

  it('Reagir mostra a barra rápida; o emoji escolhido vai para onReact', async () => {
    const onReact = vi.fn();
    const msg = message();
    render(<MessageBubble type="received" message={msg} onReact={onReact} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reagir' }));

    const bar = screen.getByRole('group', { name: 'Reagir com' });
    expect(within(bar).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '👍',
      '❤️',
      '😂',
      '😮',
      '😢',
      '🙏',
    ]);
    await userEvent.click(within(bar).getByRole('button', { name: 'Reagir com ❤️' }));
    expect(onReact).toHaveBeenCalledWith(msg, '❤️');
  });

  it('clicar no emoji que já é do laboratório tira a reação (null)', async () => {
    const onReact = vi.fn();
    const msg = message({
      reactions: [
        { emoji: '👍', reactorType: 'agent', userId: 'u-1', userName: 'Ana', reactedAt: '2026-08-23T14:26:00Z' },
      ],
    });
    render(<MessageBubble type="received" message={msg} onReact={onReact} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reagir' }));
    const mine = screen.getByRole('button', { name: 'Reagir com 👍' });
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(mine);
    expect(onReact).toHaveBeenCalledWith(msg, null);
  });

  it('Copiar põe o texto na área de transferência', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MessageBubble type="sent" message={message({ senderType: 'agent', content: 'R$ 89,90' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar' }));
    expect(writeText).toHaveBeenCalledWith('R$ 89,90');
  });

  it('Esc fecha o menu', async () => {
    render(<MessageBubble type="received" message={message()} onReply={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('bolha de sistema não tem menu', () => {
    render(<MessageBubble type="system" message={message({ senderType: 'system' })} onReply={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });

  it('carrega data-message-id para o painel rolar até ela', () => {
    render(<MessageBubble type="received" message={message({ id: 'abc' })} />);
    expect(screen.getByTestId('message-bubble')).toHaveAttribute('data-message-id', 'abc');
  });
});

describe('MessageBubble — citação (D-221)', () => {
  it('mostra autor + trecho e o clique leva o id da original', async () => {
    const onQuoteClick = vi.fn();
    render(
      <MessageBubble
        type="sent"
        message={message({
          senderType: 'agent',
          quotedMessageId: 'orig-1',
          quoted: {
            id: 'orig-1',
            senderType: 'patient',
            senderName: 'Maria',
            preview: 'Posso ir amanhã?',
            messageType: 'text',
            deleted: false,
          },
        })}
        onQuoteClick={onQuoteClick}
      />,
    );
    const block = screen.getByRole('button', { name: 'Ir para a mensagem citada' });
    expect(block).toHaveTextContent('Maria');
    expect(block).toHaveTextContent('Posso ir amanhã?');
    await userEvent.click(block);
    expect(onQuoteClick).toHaveBeenCalledWith('orig-1');
  });

  it('rótulos: mídia sem texto, apagada e indisponível', () => {
    const base = { id: 'q', senderType: 'patient' as const, senderName: 'M', preview: '', deleted: false };
    expect(quotedLabel({ ...base, messageType: 'image' })).toBe('📷 Foto');
    expect(quotedLabel({ ...base, messageType: 'audio' })).toBe('🎤 Áudio');
    expect(quotedLabel({ ...base, messageType: 'text', deleted: true })).toBe('🚫 Mensagem apagada');
    expect(quotedLabel({ ...base, id: null, messageType: null })).toBe('Mensagem original indisponível');
  });

  it('citada apagada ou indisponível não é clicável', () => {
    render(
      <MessageBubble
        type="received"
        message={message({
          quoted: { id: null, senderType: null, senderName: null, preview: '', messageType: null, deleted: false },
        })}
        onQuoteClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('quoted-block').tagName).toBe('DIV');
    expect(screen.queryByRole('button', { name: 'Ir para a mensagem citada' })).toBeNull();
  });
});

describe('MessageBubble — reações, apagada e editada (D-220/D-222)', () => {
  it('reações aparecem como pílula embaixo do balão, paciente e laboratório', () => {
    render(
      <MessageBubble
        type="received"
        message={message({
          reactions: [
            { emoji: '😂', reactorType: 'patient', userId: null, userName: null, reactedAt: '2026-08-23T14:26:00Z' },
            { emoji: '🙏', reactorType: 'agent', userId: 'u', userName: 'Ana', reactedAt: '2026-08-23T14:27:00Z' },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('message-reactions')).toHaveTextContent('😂🙏');
  });

  it('apagada: só "🚫 Mensagem apagada", sem menu, sem citação', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ content: '', deletedAt: '2026-08-23T15:00:00Z' })}
        onReply={vi.fn()}
        onReact={vi.fn()}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveAttribute('data-deleted', 'true');
    expect(bubble).toHaveTextContent('🚫 Mensagem apagada');
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });

  it('editada: texto novo + "Editada" na linha da hora', () => {
    render(
      <MessageBubble
        type="received"
        message={message({ content: 'amanhã às 9', editedAt: '2026-08-23T14:30:00Z' })}
      />,
    );
    expect(screen.getByText('amanhã às 9')).toBeInTheDocument();
    expect(screen.getByTestId('message-edited')).toHaveTextContent('Editada');
  });
});
