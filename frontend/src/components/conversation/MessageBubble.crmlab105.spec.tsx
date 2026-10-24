import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@crm-lab/shared';
import { MESSAGE_DELETE_WINDOW_MS, MESSAGE_EDIT_WINDOW_MS } from '@crm-lab/shared';
import { MessageBubble } from './MessageBubble';

/**
 * MessageBubble — CRMLAB-105 (D-280): "Editar" e "Apagar para todos" só para a
 * AUTORA, em mensagem enviada pelo CRM e dentro do prazo do WhatsApp.
 */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function sent(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderType: 'agent',
    senderId: 'u-1',
    senderName: 'Ana',
    content: 'O exame custa R$ 98,90',
    messageType: 'text',
    attachmentUrl: null,
    status: 'delivered',
    readAt: null,
    createdAt: ago(60_000),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

async function menuItems(): Promise<string[]> {
  await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
}

function renderBubble(message: Message, currentUserId = 'u-1') {
  const onEdit = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn();
  render(
    <MessageBubble
      type="sent"
      message={message}
      currentUserId={currentUserId}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  );
  return { onEdit, onDelete };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MessageBubble — editar/apagar da autora (D-280)', () => {
  it('a autora, dentro de 15 min, vê Editar e Apagar para todos', async () => {
    renderBubble(sent());
    expect(await menuItems()).toEqual(['Copiar', 'Editar', 'Apagar para todos']);
  });

  it('mensagem de outra atendente, do celular ou automática: nenhum dos dois', async () => {
    renderBubble(sent({ senderId: 'u-2' }));
    expect(await menuItems()).toEqual(['Copiar']);
  });

  it('do celular (senderId nulo) não oferece', async () => {
    renderBubble(sent({ senderId: null }));
    expect(await menuItems()).toEqual(['Copiar']);
  });

  it('depois de 15 min só apaga; depois de 48 h, nada', async () => {
    const { unmount } = render(
      <MessageBubble
        type="sent"
        message={sent({ createdAt: ago(MESSAGE_EDIT_WINDOW_MS + 60_000) })}
        currentUserId="u-1"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(await menuItems()).toEqual(['Copiar', 'Apagar para todos']);
    unmount();

    renderBubble(sent({ createdAt: ago(MESSAGE_DELETE_WINDOW_MS + 60_000) }));
    expect(await menuItems()).toEqual(['Copiar']);
  });

  it('ainda enviando ou que falhou: nada (sem id externo)', async () => {
    renderBubble(sent({ status: 'failed' }));
    expect(await menuItems()).toEqual(['Copiar']);
  });

  it('documento só apaga (não tem o que editar)', async () => {
    renderBubble(sent({ messageType: 'pdf', content: 'laudo.pdf', attachmentUrl: 'https://x/laudo.pdf' }));
    expect(await menuItems()).toEqual(['Copiar', 'Apagar para todos']);
  });

  it('sem handler (canal Cloud API), os itens somem', async () => {
    render(<MessageBubble type="sent" message={sent()} currentUserId="u-1" />);
    expect(await menuItems()).toEqual(['Copiar']);
  });

  it('Editar abre a caixa no balão: Enter salva o texto novo', async () => {
    const { onEdit } = renderBubble(sent());
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Editar' }));

    const box = screen.getByLabelText('Editar mensagem');
    await userEvent.clear(box);
    await userEvent.type(box, 'O exame custa R$ 89,90{Enter}');

    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), 'O exame custa R$ 89,90');
    expect(await screen.findByText('O exame custa R$ 98,90')).toBeInTheDocument();
    expect(screen.queryByLabelText('Editar mensagem')).toBeNull();
  });

  it('Esc cancela sem chamar a API; vazio não salva', async () => {
    const { onEdit } = renderBubble(sent());
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Editar' }));
    const box = screen.getByLabelText('Editar mensagem');
    await userEvent.clear(box);
    await userEvent.type(box, '   {Enter}');
    expect(onEdit).not.toHaveBeenCalled();
    await userEvent.type(box, '{Escape}');
    expect(screen.queryByLabelText('Editar mensagem')).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('edição recusada pela API: a caixa continua aberta', async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error('502'));
    render(<MessageBubble type="sent" message={sent()} currentUserId="u-1" onEdit={onEdit} />);
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Editar' }));
    const box = screen.getByLabelText('Editar mensagem');
    await userEvent.type(box, '!{Enter}');
    expect(onEdit).toHaveBeenCalled();
    expect(await screen.findByLabelText('Editar mensagem')).toBeInTheDocument();
  });

  it('Apagar para todos pede confirmação', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onDelete } = renderBubble(sent());

    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Apagar para todos' }));
    expect(confirm).toHaveBeenCalledWith('Apagar para todos?');
    expect(onDelete).not.toHaveBeenCalled();

    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Apagar para todos' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }));
  });
});
