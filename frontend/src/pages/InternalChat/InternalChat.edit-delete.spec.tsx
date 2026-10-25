import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalMessage } from '@crm-lab/shared';
import { MESSAGE_DELETE_WINDOW_MS, MESSAGE_EDIT_WINDOW_MS } from '@crm-lab/shared';
import { InternalMessageItem } from './InternalMessageItem';

/**
 * Chat Interno — CRMLAB-117 (D-282): "Editar" e "Apagar para todos" só para a
 * AUTORA, dentro dos mesmos prazos do atendimento. Gestão não mexe em
 * mensagem de colega; sistema fica de fora; arquivo só apaga.
 */

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function mine(overrides: Partial<InternalMessage> = {}): InternalMessage {
  return {
    id: 'm-1',
    channelId: 'ch-1',
    senderId: 'u-1',
    senderName: 'Ana',
    content: 'Reunião às 14h',
    attachedProposalId: null,
    attachment: null,
    isSystem: false,
    createdAt: ago(60_000),
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function renderItem(
  message: InternalMessage,
  currentUserId = 'u-1',
  role: 'attendant' | 'admin' = 'attendant',
) {
  const onEdit = vi.fn().mockResolvedValue(undefined);
  const onDelete = vi.fn();
  render(
    <InternalMessageItem
      message={message}
      currentUserId={currentUserId}
      currentUserRole={role}
      isApprovalsChannel={false}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  );
  return { onEdit, onDelete };
}

async function menuItems(): Promise<string[]> {
  await userEvent.click(screen.getByRole('button', { name: 'Ações da mensagem' }));
  return within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InternalMessageItem — editar/apagar da autora (D-282)', () => {
  it('a autora, dentro de 15 min, vê Editar e Apagar para todos', async () => {
    renderItem(mine());
    expect(await menuItems()).toEqual(['Editar', 'Apagar para todos']);
  });

  it('admin não vê o menu em mensagem de colega', () => {
    renderItem(mine({ senderId: 'u-2' }), 'u-1', 'admin');
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });

  it('mensagem de sistema não oferece nada', () => {
    renderItem(mine({ isSystem: true, senderId: null, senderName: 'Sistema' }));
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });

  it('depois de 15 min só apaga; depois de 48 h, nada', async () => {
    renderItem(mine({ createdAt: ago(MESSAGE_EDIT_WINDOW_MS + 60_000) }));
    expect(await menuItems()).toEqual(['Apagar para todos']);
  });

  it('depois de 48 h o menu some', () => {
    renderItem(mine({ createdAt: ago(MESSAGE_DELETE_WINDOW_MS + 60_000) }));
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });

  it('mensagem com arquivo só apaga', async () => {
    renderItem(
      mine({
        content: '',
        attachment: {
          id: 'a-1',
          fileName: 'pedido.pdf',
          mimeType: 'application/pdf',
          byteSize: 10,
          url: '/api/v1/internal-chat/channels/ch-1/attachments/a-1',
        },
      }),
    );
    expect(await menuItems()).toEqual(['Apagar para todos']);
  });

  it('editar no próprio balão: Enter salva o texto novo', async () => {
    const { onEdit } = renderItem(mine());
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Editar' }));
    const box = screen.getByRole('textbox', { name: 'Editar mensagem' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Reunião às 15h{Enter}');
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }), 'Reunião às 15h');
  });

  it('Esc cancela e vazio não salva', async () => {
    const { onEdit } = renderItem(mine());
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Editar' }));
    const box = screen.getByRole('textbox', { name: 'Editar mensagem' });
    await userEvent.clear(box);
    await userEvent.type(box, '{Enter}');
    expect(onEdit).not.toHaveBeenCalled();
    await userEvent.type(box, '{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Editar mensagem' })).toBeNull();
    expect(screen.getByText('Reunião às 14h')).toBeTruthy();
  });

  it('Apagar para todos pede confirmação', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { onDelete } = renderItem(mine());
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Apagar para todos' }));
    expect(onDelete).not.toHaveBeenCalled();
    await menuItems();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Apagar para todos' }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'm-1' }));
  });

  it('mostra "Editada" e, apagada, "Mensagem apagada" sem menu', () => {
    const { unmount } = render(
      <InternalMessageItem
        message={mine({ editedAt: ago(1000) })}
        currentUserId="u-1"
        currentUserRole="attendant"
        isApprovalsChannel={false}
      />,
    );
    expect(screen.getByTestId('internal-message-edited').textContent).toBe('Editada');
    unmount();

    renderItem(mine({ content: '', deletedAt: ago(1000) }));
    expect(screen.getByText('🚫 Mensagem apagada')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ações da mensagem' })).toBeNull();
  });
});
