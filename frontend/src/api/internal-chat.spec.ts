import { describe, expect, it, vi } from 'vitest';
import type { Channel } from '@crm-lab/shared';

const get = vi.fn();
vi.mock('@/api/client', () => ({ http: { get: (url: string) => get(url) } }));

const { internalChatApi } = await import('./internal-chat');

function channel(overrides: Partial<Channel>): Channel {
  return {
    id: 'c',
    key: 'avisos',
    name: 'Avisos gerais',
    kind: 'channel',
    unreadCount: 0,
    lastReadAt: null,
    lastMessageAt: null,
    otherUserId: null,
    otherUserName: null,
    ...overrides,
  } as Channel;
}

describe('internalChatApi.channels (CRMLAB-151, D-321)', () => {
  it('oculta o canal `geral` e mantém Avisos gerais e as DMs', async () => {
    get.mockResolvedValue({
      channels: [
        channel({ id: 'a', key: 'avisos' }),
        channel({ id: 'g', key: 'geral', name: 'Geral', unreadCount: 4 }),
        channel({ id: 'd', key: 'dm-x', kind: 'dm', otherUserName: 'Ana' }),
      ],
    });

    const { channels } = await internalChatApi.channels();

    expect(get).toHaveBeenCalledWith('/internal-chat/channels');
    expect(channels.map((c) => c.id)).toEqual(['a', 'd']);
  });
});
