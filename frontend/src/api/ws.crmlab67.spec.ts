import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyWsEvent } from './ws';
import { queryKeys } from './query-keys';
import { usePresenceStore } from '@/stores/presence.store';

/**
 * WS do CRMLAB-67 (D-225/D-226): o tique refaz SÓ a conversa; a presença vai
 * para o store em memória, sem tocar no cache do servidor.
 */

function spyClient() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  return { client, invalidate };
}

afterEach(() => {
  usePresenceStore.getState().clear();
});

describe('applyWsEvent — CRMLAB-67', () => {
  it('message.status_updated invalida só ["conversation", id] — a lista fica quieta', () => {
    const { client, invalidate } = spyClient();
    applyWsEvent(client, {
      event: 'message.status_updated',
      data: { conversationId: 'c-1', messageId: 'm-1', status: 'read' },
    });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([queryKeys.conversation('c-1')]);
  });

  it('conversation.presence vai para o store e não invalida nada', () => {
    const { client, invalidate } = spyClient();
    applyWsEvent(client, {
      event: 'conversation.presence',
      data: { conversationId: 'c-2', presence: 'typing', lastSeenAt: null },
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(usePresenceStore.getState().byConversation['c-2']).toMatchObject({
      presence: 'typing',
      lastSeenAt: null,
    });
  });
});
