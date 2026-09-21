import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import type { WsEvent } from '@crm-lab/shared';
import { WS_CLOSE_TOO_MANY_SOCKETS, WS_CLOSE_UNAUTHORIZED } from '@crm-lab/shared';
import { applyWsEvent, createWsClient } from './ws';
import type { WebSocketLike, WsClientOptions } from './ws';
import { queryKeys, queryScopes } from './query-keys';

/**
 * Contrato do WS (FRONTEND_BACKEND.md — "Real-time"):
 *  - evento é NOTIFICAÇÃO: invalida a query certa, nunca faz patch no cache
 *  - reconexão com backoff exponencial
 *  - ao reconectar, invalida as queries ativas (pode ter perdido evento)
 *  - CRMLAB-33: autenticação por cookie (mesmo origin) — a URL não carrega
 *    mais token; `onclose` com `WS_CLOSE_UNAUTHORIZED` tenta refresh antes
 *    de reconectar.
 */

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 1;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
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
  emitClose(code?: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

let queryClient: QueryClient;
let invalidate: MockInstance;

function build(overrides: Partial<WsClientOptions> = {}) {
  return createWsClient({
    queryClient,
    url: 'ws://test/ws',
    socketFactory: (url) => new FakeSocket(url),
    ...overrides,
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
  it('conecta em VITE_WS_URL sem token na query string', () => {
    build().connect();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket(0).url).toBe('ws://test/ws');
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
      queryScopes.operations,
    ]);
  });

  it('approval.decided → toast + invalida a proposta', () => {
    const toast = vi.fn();
    const client = build({ toast });
    client.connect();
    socket(0).emitMessage({
      event: 'approval.decided',
      data: { proposalId: 'p-2', decision: 'approved' },
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(keysPassed()).toEqual([
      queryKeys.proposal('p-2'),
      queryScopes.proposals,
      queryScopes.operations,
    ]);
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

  it('depois de maxAttempts, desiste e avisa por toast', () => {
    const toast = vi.fn();
    const client = build({ toast, maxAttempts: 2 });
    client.connect();

    socket(0).emitClose(); // tentativa 1 agendada
    vi.advanceTimersByTime(1_000);
    socket(1).emitClose(); // tentativa 2 agendada
    vi.advanceTimersByTime(2_000);
    socket(2).emitClose(); // esgotou maxAttempts — não agenda mais

    expect(FakeSocket.instances).toHaveLength(3);
    expect(client.hasGivenUp()).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/reconectar|conexão/i), 'attention');

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(3); // continua sem tentar
  });
});

describe('ws — 401/4401: renova sessão antes de reconectar', () => {
  it('em WS_CLOSE_UNAUTHORIZED, chama refreshAccessToken antes da próxima tentativa', async () => {
    const refreshAccessToken = vi.fn().mockResolvedValue('novo-access-token');
    const client = build({ refreshAccessToken });
    client.connect();

    socket(0).emitClose(WS_CLOSE_UNAUTHORIZED);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    // `.then().finally(scheduleReconnect)` só agenda depois que a promise
    // resolve — flush do microtask queue antes de avançar o timer macro.
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('refresh falhando (sessão morta) ainda assim tenta reconectar (maxAttempts limita)', async () => {
    const refreshAccessToken = vi.fn().mockRejectedValue(new Error('sem sessão'));
    const client = build({ refreshAccessToken });
    client.connect();

    socket(0).emitClose(WS_CLOSE_UNAUTHORIZED);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('close SEM WS_CLOSE_UNAUTHORIZED não chama refresh', () => {
    const refreshAccessToken = vi.fn();
    const client = build({ refreshAccessToken });
    client.connect();

    socket(0).emitClose(); // código genérico (queda de rede, deploy, etc)
    vi.advanceTimersByTime(1_000);

    expect(refreshAccessToken).not.toHaveBeenCalled();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('ws — aba oculta pausa a reconexão', () => {
  it('aba oculta por mais que visibilityHiddenPauseMs: não agenda nova tentativa', () => {
    const client = build({ visibilityHiddenPauseMs: 5_000 });
    client.connect();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(10_000); // já passou dos 5s de tolerância
    socket(0).emitClose();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1); // não reagendou

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(FakeSocket.instances).toHaveLength(2); // reconecta na hora ao voltar
  });

  it('aba que JA nasce oculta tambem pausa — nao queima as tentativas em silencio', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    // Sem nenhum `visibilitychange`: e o caso de ctrl+clique / restauracao de
    // sessao, em que a aba nasce escondida e o evento nunca chega.
    const client = build({ visibilityHiddenPauseMs: 5_000 });
    client.connect();

    vi.advanceTimersByTime(10_000);
    socket(0).emitClose();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('ws — teto de sockets por usuario (4409)', () => {
  it('close 4409 NAO reconecta: a decisao foi do servidor, reconectar evictaria a proxima aba', () => {
    build().connect();

    socket(0).emitClose(WS_CLOSE_TOO_MANY_SOCKETS);
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.instances).toHaveLength(1);
  });
});

/**
 * Auditoria de 2026-09-17: a sessao do WhatsApp caiu as 16:17 e quem estava
 * atendendo continuou achando que o canal respondia. O canal mudo e pior que o
 * canal caido — o laboratorio segue achando que atende enquanto as mensagens
 * nao chegam.
 */
describe('channel.connection_changed', () => {
  it('queda avisa com tom de atencao e invalida o status do canal', () => {
    const toast = vi.fn();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    applyWsEvent(
      queryClient,
      { event: 'channel.connection_changed', data: { channel: 'whatsapp', connected: false } } as WsEvent,
      toast,
    );

    expect(toast).toHaveBeenCalledTimes(1);
    // O tom importa: `positive` (o default dos outros eventos) daria ao
    // atendente a impressao contraria da que o evento carrega.
    expect(toast.mock.calls[0]?.[1]).toBe('attention');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.whatsappStatus() });
  });

  it('reconexao NAO avisa — o card muda sozinho', () => {
    const toast = vi.fn();

    applyWsEvent(
      queryClient,
      { event: 'channel.connection_changed', data: { channel: 'whatsapp', connected: true } } as WsEvent,
      toast,
    );

    expect(toast).not.toHaveBeenCalled();
  });
});
