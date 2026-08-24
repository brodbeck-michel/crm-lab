import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { WsEvent } from '@crm-lab/shared';
import { createWsClient } from './ws';
import type { WebSocketLike } from './ws';
import { queryKeys, queryScopes } from './query-keys';

/**
 * Contrato do WS (FRONTEND_BACKEND.md — "Real-time"):
 *  - evento é NOTIFICAÇÃO: invalida a query certa, nunca faz patch no cache
 *  - reconexão com backoff exponencial
 *  - ao reconectar, invalida as queries ativas (pode ter perdido evento)
 */

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /* Gatilhos do teste */
  emitOpen(): void {
    this.onopen?.({});
  }
  emitMessage(event: WsEvent): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  emitClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

let queryClient: QueryClient;
let invalidate: MockInstance;

function build(token: string | null = 'access-1') {
  return createWsClient({
    queryClient,
    getToken: () => token,
    url: 'ws://test/ws',
    socketFactory: (url) => new FakeSocket(url),
  });
}

/** Socket criado na n-ésima tentativa, falhando alto se não existir. */
function socket(index: number): FakeSocket {
  const found = FakeSocket.instances[index];
  if (!found) throw new Error(`socket #${index} não foi criado`);
  return found;
}

function keysPassed(): unknown[] {
  return invalidate.mock.calls.map((call) => (call[0] as { queryKey?: unknown })?.queryKey);
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  queryClient = new QueryClient();
  invalidate = vi
    .spyOn(queryClient, 'invalidateQueries')
    .mockResolvedValue(undefined) as unknown as MockInstance;
});

afterEach(() => {
  vi.useRealTimers();
  queryClient.clear();
});

describe('ws — conexão', () => {
  it('conecta em VITE_WS_URL com ?token=', () => {
    build().connect();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket(0).url).toBe('ws://test/ws?token=access-1');
  });

  it('sem token não conecta', () => {
    build(null).connect();
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

describe('ws — evento invalida a query certa', () => {
  it('conversation.new_message → ["conversations"] + ["conversation", id]', () => {
    const client = build();
    client.connect();
    socket(0).emitMessage({
      event: 'conversation.new_message',
      data: { conversationId: 'c-1', messageId: 'm-1' },
    });

    expect(keysPassed()).toEqual([queryScopes.conversations, queryKeys.conversation('c-1')]);
  });

  it('proposal.status_changed → ["proposals"] + ["proposal", id]', () => {
    const client = build();
    client.connect();
    socket(0).emitMessage({
      event: 'proposal.status_changed',
      data: { proposalId: 'p-1', status: 'ganho' },
    });

    expect(keysPassed()).toEqual([queryScopes.proposals, queryKeys.proposal('p-1')]);
  });

  it('approval.requested → chat interno (badge #aprovacoes) + pendentes', () => {
    const client = build();
    client.connect();
    socket(0).emitMessage({
      event: 'approval.requested',
      data: { proposalId: 'p-9' },
    });

    expect(keysPassed()).toEqual([
      queryScopes.internalChat,
      queryScopes.proposals,
      queryKeys.proposal('p-9'),
    ]);
  });

  it('approval.decided → toast + invalida a proposta', () => {
    const toast = vi.fn();
    const client = createWsClient({
      queryClient,
      getToken: () => 'access-1',
      url: 'ws://test/ws',
      socketFactory: (url) => new FakeSocket(url),
      toast,
    });
    client.connect();
    socket(0).emitMessage({
      event: 'approval.decided',
      data: { proposalId: 'p-2', decision: 'approved' },
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(keysPassed()).toEqual([queryKeys.proposal('p-2'), queryScopes.proposals]);
  });

  it('mensagem inválida não quebra nem invalida nada', () => {
    const client = build();
    client.connect();
    socket(0).onmessage?.({ data: 'não é json' });

    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('ws — reconexão', () => {
  it('reconecta com backoff exponencial (1s, 2s, 4s…)', () => {
    const client = build();
    client.connect();
    expect(client.nextDelayMs()).toBe(1_000);

    socket(0).emitClose();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1); // ainda não

    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2); // 1ª tentativa em 1s

    socket(1).emitClose();
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3); // 2ª tentativa em 2s

    socket(2).emitClose();
    vi.advanceTimersByTime(4_000);
    expect(FakeSocket.instances).toHaveLength(4); // 3ª tentativa em 4s
  });

  it('conexão bem-sucedida zera o backoff', () => {
    const client = build();
    client.connect();

    socket(0).emitClose();
    vi.advanceTimersByTime(1_000);
    expect(client.reconnectAttempts()).toBe(1);

    socket(1).emitOpen();
    expect(client.reconnectAttempts()).toBe(0);
    expect(client.nextDelayMs()).toBe(1_000);
  });

  it('ao RECONECTAR invalida as queries ativas (pode ter perdido evento)', () => {
    const client = build();
    client.connect();
    socket(0).emitOpen(); // 1ª conexão: nada a recuperar
    expect(invalidate).not.toHaveBeenCalled();

    socket(0).emitClose();
    vi.advanceTimersByTime(1_000);
    socket(1).emitOpen();

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(); // sem filtro = todas as ativas
  });

  it('disconnect() é intencional: fecha o socket e não reagenda', () => {
    const client = build();
    client.connect();
    const opened = socket(0);

    client.disconnect();

    expect(opened.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.isConnected()).toBe(false);
  });
});
