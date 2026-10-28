import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { InternalChannelReadState, InternalMessage } from '@crm-lab/shared';
import { InternalMessageItem } from './InternalMessageItem';
import { useMarkReadWhileOpen } from './queries';

/**
 * Chat Interno — CRMLAB-123 (D-300, D-301): ✓ cinza = gravada, ✓✓ azul = lida
 * (DM: o outro abriu; canal: todos os membros). Mesmo tique do atendimento.
 */

const T0 = '2026-10-28T12:00:00.000Z';
const T1 = '2026-10-28T12:05:00.000Z';

function message(overrides: Partial<InternalMessage> = {}): InternalMessage {
  return {
    id: 'm-1',
    channelId: 'ch-1',
    senderId: 'u-1',
    senderName: 'Ana',
    content: 'Reunião às 14h',
    attachedProposalId: null,
    attachment: null,
    isSystem: false,
    createdAt: T0,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function renderItem(
  msg: InternalMessage,
  readState: InternalChannelReadState | null,
  { currentUserId = 'u-1', isDirect = true } = {},
) {
  render(
    <InternalMessageItem
      message={msg}
      currentUserId={currentUserId}
      currentUserRole="attendant"
      isApprovalsChannel={false}
      readState={readState}
      isDirect={isDirect}
    />,
  );
}

const unread: InternalChannelReadState = {
  readUpTo: null,
  readers: [{ userId: 'u-2', name: 'Bruno', readUpTo: null, lastReadAt: null }],
};
const readByBruno: InternalChannelReadState = {
  readUpTo: T0,
  readers: [{ userId: 'u-2', name: 'Bruno', readUpTo: T0, lastReadAt: T1 }],
};

describe('InternalMessageItem — confirmação de leitura (CRMLAB-123)', () => {
  it('DM: minha mensagem ainda não lida mostra ✓ cinza', () => {
    renderItem(message(), unread);
    const tick = screen.getByTestId('message-status');
    expect(tick).toHaveAttribute('data-status', 'sent');
    expect(tick).toHaveTextContent('✓');
    expect(tick).toHaveAccessibleName('Enviada');
  });

  it('DM: lida pelo outro mostra ✓✓ azul (token de lida do atendimento)', () => {
    renderItem(message(), readByBruno);
    const tick = screen.getByTestId('message-status');
    expect(tick).toHaveAttribute('data-status', 'read');
    expect(tick).toHaveTextContent('✓✓');
    expect(tick).toHaveClass('text-chat-tick-read');
  });

  it('mensagem posterior à leitura continua ✓', () => {
    renderItem(message({ createdAt: '2026-10-28T12:00:00.001Z' }), readByBruno);
    expect(screen.getByTestId('message-status')).toHaveAttribute('data-status', 'sent');
  });

  it('mensagem de outra pessoa não leva indicador', () => {
    renderItem(message({ senderId: 'u-2', senderName: 'Bruno' }), readByBruno);
    expect(screen.queryByTestId('message-status')).toBeNull();
  });

  it('mensagem apagada não leva indicador; editada mantém', () => {
    renderItem(message({ deletedAt: T1, content: '' }), readByBruno);
    expect(screen.queryByTestId('message-status')).toBeNull();
  });

  it('editada continua com o tique', () => {
    renderItem(message({ editedAt: T1 }), readByBruno);
    expect(screen.getByTestId('message-status')).toHaveAttribute('data-status', 'read');
  });

  it('canal: ✓ até todos lerem, e o hover diz quem leu e quem falta', () => {
    const partial: InternalChannelReadState = {
      readUpTo: null,
      readers: [
        { userId: 'u-2', name: 'Bruno', readUpTo: T0, lastReadAt: T1 },
        { userId: 'u-3', name: 'Carla', readUpTo: null, lastReadAt: null },
      ],
    };
    renderItem(message(), partial, { isDirect: false });
    const tick = screen.getByTestId('message-status');
    expect(tick).toHaveAttribute('data-status', 'sent');
    const title = tick.getAttribute('title') ?? '';
    expect(title).toMatch(/^Lida por: Bruno \(abriu /);
    expect(title).toContain('Ainda não leram: Carla');
  });

  it('sem readState (servidor antigo) não mostra tique', () => {
    renderItem(message(), null);
    expect(screen.queryByTestId('message-status')).toBeNull();
  });
});

describe('useMarkReadWhileOpen (D-301)', () => {
  function setup(channelId: string | null, initial: InternalMessage[]) {
    const markRead = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const hook = renderHook(
      ({ id, messages }: { id: string | null; messages: InternalMessage[] }) =>
        useMarkReadWhileOpen(id, messages, 'u-1', markRead, onError),
      { initialProps: { id: channelId, messages: initial } },
    );
    return { markRead, hook };
  }

  it('primeira carga é só a linha de base; mensagem nova de outra pessoa marca como lida', () => {
    const first = message({ id: 'm-1', senderId: 'u-2' });
    const { markRead, hook } = setup('ch-1', [first]);
    expect(markRead).not.toHaveBeenCalled();

    hook.rerender({ id: 'ch-1', messages: [first, message({ id: 'm-2', senderId: 'u-2' })] });
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead).toHaveBeenCalledWith('ch-1');
  });

  it('mensagem própria não marca; canal não aberto pela pessoa também não', () => {
    const first = message({ id: 'm-1' });
    const { markRead, hook } = setup('ch-1', [first]);
    hook.rerender({ id: 'ch-1', messages: [first, message({ id: 'm-2' })] });
    expect(markRead).not.toHaveBeenCalled();

    const auto = setup(null, [first]);
    auto.hook.rerender({ id: null, messages: [first, message({ id: 'm-3', senderId: 'u-2' })] });
    expect(auto.markRead).not.toHaveBeenCalled();
  });
});
