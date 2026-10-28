import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { createWsClient, type WebSocketLike } from './ws';
import { createQueryClient } from './query-client';
import { queryKeys } from './query-keys';
import { isBackgroundLiveKey } from '@/hooks/useAppWebSocket';
import { ALERTS_QUERY } from '@/hooks/useNewMessageAlerts';

/**
 * CRMLAB-122 (D-288): tráfego por aba.
 *  - aba ESCONDIDA não refaz GET por evento WS — só marca; refaz ao voltar;
 *  - exceção: o aviso de mensagem nova continua vivo na aba eleita;
 *  - rajada de eventos vira UM refetch (lote);
 *  - polling (`refetchInterval`) pausa com a aba em segundo plano.
 */

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | null = null;
  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  close(): void {
    this.readyState = 3;
  }
  emit(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

const newMessage = (conversationId = 'c-1') => ({
  event: 'conversation.new_message',
  data: { conversationId, messageId: 'm-1' },
});

let queryClient: QueryClient;
let fetches: Record<string, number>;

/** Monta uma query ATIVA (com observer), contando quantas vezes buscou. */
function observe(queryKey: readonly unknown[]): () => void {
  const name = JSON.stringify(queryKey);
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn: () => {
      fetches[name] = (fetches[name] ?? 0) + 1;
      return Promise.resolve({ at: Date.now() });
    },
    staleTime: Infinity,
  });
  return observer.subscribe(() => undefined);
}

const count = (queryKey: readonly unknown[]) => fetches[JSON.stringify(queryKey)] ?? 0;

beforeEach(() => {
  vi.useFakeTimers();
  fetches = {};
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setVisibility('visible');
});

afterEach(() => {
  queryClient.clear();
  setVisibility('visible');
  vi.useRealTimers();
});

describe('ws — aba escondida não gasta o limite', () => {
  it('escondida: evento só marca as queries; ao voltar visível refaz uma vez', async () => {
    const list = queryKeys.conversations({ status: 'active' });
    observe(list);
    await vi.advanceTimersByTimeAsync(0);
    expect(count(list)).toBe(1);

    const client = createWsClient({
      queryClient,
      url: 'ws://t',
      socketFactory: () => new FakeSocket(),
      keepsBackgroundAlive: () => true,
    });
    client.connect();

    setVisibility('hidden');
    FakeSocket.last?.emit(newMessage());
    FakeSocket.last?.emit(newMessage());
    await vi.advanceTimersByTimeAsync(0);
    expect(count(list)).toBe(1); // nenhum GET com a aba escondida
    expect(queryClient.getQueryState(list)?.isInvalidated).toBe(true);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(count(list)).toBe(2); // um só, não um por evento
    client.disconnect();
  });

  it('escondida e ELEITA: o aviso de mensagem nova continua vivo; o resto espera', async () => {
    const alerts = queryKeys.conversations(ALERTS_QUERY);
    const list = queryKeys.conversations({ status: 'active' });
    observe(alerts);
    observe(list);
    await vi.advanceTimersByTimeAsync(0);

    const client = createWsClient({
      queryClient,
      url: 'ws://t',
      socketFactory: () => new FakeSocket(),
      isBackgroundLive: isBackgroundLiveKey,
      keepsBackgroundAlive: () => true,
    });
    client.connect();
    setVisibility('hidden');
    FakeSocket.last?.emit(newMessage());
    await vi.advanceTimersByTimeAsync(0);

    expect(count(alerts)).toBe(2);
    expect(count(list)).toBe(1);
    client.disconnect();
  });

  it('escondida e NÃO eleita (outra aba do CRM cuida): nem o aviso refaz', async () => {
    const alerts = queryKeys.conversations(ALERTS_QUERY);
    observe(alerts);
    await vi.advanceTimersByTimeAsync(0);

    const client = createWsClient({
      queryClient,
      url: 'ws://t',
      socketFactory: () => new FakeSocket(),
      isBackgroundLive: isBackgroundLiveKey,
      keepsBackgroundAlive: () => false,
    });
    client.connect();
    setVisibility('hidden');
    FakeSocket.last?.emit(newMessage());
    await vi.advanceTimersByTimeAsync(0);

    expect(count(alerts)).toBe(1);
    client.disconnect();
  });
});

describe('ws — lote e contador', () => {
  it('rajada dentro da janela do lote vira UM refetch de cada lista', async () => {
    const list = queryKeys.conversations({ status: 'active' });
    const unread = queryKeys.conversationUnreadCount();
    observe(list);
    observe(unread);
    await vi.advanceTimersByTimeAsync(0);

    const client = createWsClient({
      queryClient,
      url: 'ws://t',
      socketFactory: () => new FakeSocket(),
      invalidateBatchMs: 500,
    });
    client.connect();
    FakeSocket.last?.emit(newMessage('c-1'));
    FakeSocket.last?.emit(newMessage('c-2'));
    FakeSocket.last?.emit(newMessage('c-1'));
    await vi.advanceTimersByTimeAsync(1_200);

    expect(count(list)).toBe(2); // 1 inicial + 1 do lote
    // O contador sai UMA vez por lote (depois do detalhe), não 2 por mensagem.
    expect(count(unread)).toBe(2);
    client.disconnect();
  });

  it('a lista de colegas (assignees) não é refeita por mensagem nova', async () => {
    const assignees = queryKeys.conversationAssignees();
    observe(assignees);
    await vi.advanceTimersByTimeAsync(0);

    const client = createWsClient({ queryClient, url: 'ws://t', socketFactory: () => new FakeSocket() });
    client.connect();
    FakeSocket.last?.emit(newMessage());
    await vi.advanceTimersByTimeAsync(0);

    expect(count(assignees)).toBe(1);
    client.disconnect();
  });
});

describe('polling pausa com a aba em segundo plano', () => {
  it('refetchInterval não roda com a aba escondida (padrão do createQueryClient)', async () => {
    queryClient = createQueryClient();
    const key = ['operation-overview-test'];
    let calls = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        calls += 1;
        return Promise.resolve(calls);
      },
      refetchInterval: 60_000,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2); // visível: polling normal

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(2); // escondida: nenhum tique

    unsubscribe();
  });
});
