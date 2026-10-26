import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Channel, UserPresenceStatus } from '@crm-lab/shared';
import { ChannelList } from './ChannelList';
import { MessagePanel } from './MessagePanel';
import { UserSearch } from './UserSearch';

/** Status da equipe no Chat Interno (CRMLAB-120, D-286). */

const STATUS: Record<string, UserPresenceStatus> = { 'u-2': 'busy', 'u-3': 'offline' };
const presenceOf = (id: string) => STATUS[id];

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: 'c-1',
    key: 'geral',
    name: 'geral',
    kind: 'channel',
    otherUserId: null,
    otherUserName: null,
    unreadCount: 0,
    lastReadAt: null,
    lastMessageAt: null,
    ...overrides,
  };
}

const DM = channel({ id: 'c-2', name: 'dm', kind: 'dm', otherUserId: 'u-2', otherUserName: 'Bruno' });

describe('Chat interno — status da equipe (CRMLAB-120)', () => {
  it('DM tem a bolinha da outra pessoa; canal não tem', () => {
    render(
      <ChannelList
        channels={[channel({}), DM]}
        selectedId={null}
        onSelect={vi.fn()}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        presenceOf={presenceOf}
      />,
    );

    const [general, dm] = screen.getAllByTestId('channel-item');
    expect(general?.querySelector('[role="img"]')).toBeNull();
    expect(dm).toContainElement(screen.getByRole('img', { name: 'Status: Ocupado' }));
  });

  it('a busca de usuário mostra o status de cada um', async () => {
    const user = userEvent.setup();
    render(
      <UserSearch
        users={[
          { id: 'u-2', name: 'Bruno', role: 'manager' },
          { id: 'u-3', name: 'Carla', role: 'attendant' },
        ]}
        onSelectUser={vi.fn()}
        isLoading={false}
        isError={false}
        presenceOf={presenceOf}
      />,
    );

    await user.click(screen.getByRole('searchbox'));
    expect(screen.getByRole('img', { name: 'Status: Ocupado' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Status: Offline' })).toBeInTheDocument();
  });

  it('o cabeçalho da DM mostra o status com o nome da outra pessoa', () => {
    render(
      <MessagePanel
        channel={DM}
        messages={[]}
        isLoading={false}
        isError={false}
        onRetry={vi.fn()}
        onSend={vi.fn()}
        sending={false}
        currentUserId="u-1"
        currentUserRole="attendant"
        hasOlderMessages={false}
        onLoadOlder={vi.fn()}
        presenceOf={presenceOf}
      />,
    );

    expect(screen.getByText('Bruno')).toBeInTheDocument();
    expect(screen.getByText('Mensagem direta · Ocupado')).toBeInTheDocument();
  });
});
