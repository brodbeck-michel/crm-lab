import type { QueryClient } from '@tanstack/react-query';
import type { WsEvent, WsEventName } from '@crm-lab/shared';
import { queryKeys, queryScopes } from './query-keys';

/**
 * Cliente WebSocket (docs/contracts/FRONTEND_BACKEND.md — "Real-time").
 *
 * REGRA: evento WS é NOTIFICAÇÃO, não transporte de dados. O payload carrega
 * só IDs; ao receber, o cliente invalida a query certa e o TanStack Query
 * refaz o fetch. NUNCA se faz patch manual no cache aqui.
 *
 * Reconexão com backoff exponencial. Ao (re)conectar depois de uma queda,
 * invalida TODAS as queries ativas — pode ter havido evento perdido durante
 * a desconexão.
 */

/** Superfície mínima do WebSocket — permite injetar um fake nos testes. */
export interface WebSocketLike {
  readyState: number;
  close: (code?: number, reason?: string) => void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface WsClientOptions {
  queryClient: QueryClient;
  /** Token do usuário logado. `null` = não conecta. */
  getToken: () => string | null;
  /** Padrão: `VITE_WS_URL`. */
  url?: string;
  /** Padrão: `new WebSocket(url)`. */
  socketFactory?: (url: string) => WebSocketLike;
  /**
   * Toast dos eventos com feedback visível (`approval.decided`,
   * `channel.connection_changed`).
   *
   * `tone` existe porque nem todo evento e boa noticia: a queda do canal
   * (`channel.connection_changed`) precisa de `attention`, nao do `positive`
   * que servia a todos quando o unico toast era "proposta aprovada".
   */
  toast?: (message: string, tone?: WsToastTone) => unknown;
  /** Backoff: 1s, 2s, 4s… até o teto. */
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface WsClient {
  connect: () => void;
  disconnect: () => void;
  isConnected: () => boolean;
  /** Quantas tentativas de reconexão já falharam em sequência. */
  reconnectAttempts: () => number;
  /** Exposto para teste: o atraso que a próxima tentativa usaria. */
  nextDelayMs: () => number;
}

export function wsBaseUrl(): string {
  const url = import.meta.env.VITE_WS_URL;
  return typeof url === 'string' && url.length > 0 ? url : 'ws://localhost:3000/ws';
}

export function parseWsEvent(raw: unknown): WsEvent | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WsEvent>;
    if (!parsed || typeof parsed.event !== 'string') return null;
    return parsed as WsEvent;
  } catch {
    return null;
  }
}

export type WsToastTone = 'positive' | 'attention';

/**
 * Mapa evento → invalidação. É a tabela de FRONTEND_BACKEND.md, literal.
 * Sempre `invalidateQueries`, nunca `setQueryData`.
 */
export function applyWsEvent(
  queryClient: QueryClient,
  event: WsEvent,
  toast?: (message: string, tone?: WsToastTone) => unknown,
): void {
  const name: WsEventName = event.event;

  switch (name) {
    case 'conversation.new_message': {
      const data = event.data as { conversationId: string };
      void queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(data.conversationId) });
      return;
    }

    case 'proposal.status_changed': {
      const data = event.data as { proposalId: string };
      void queryClient.invalidateQueries({ queryKey: queryScopes.proposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(data.proposalId) });
      return;
    }

    // CRMLAB-12/D-132: itens, desconto ou médico solicitante mudaram.
    case 'proposal.updated': {
      const data = event.data as { proposalId: string };
      void queryClient.invalidateQueries({ queryKey: queryScopes.proposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(data.proposalId) });
      return;
    }

    case 'approval.requested': {
      const data = event.data as { proposalId: string };
      // Badge em #aprovacoes + a lista de pendentes + o sino de Decisões (PAGES.md §12).
      void queryClient.invalidateQueries({ queryKey: queryScopes.internalChat });
      void queryClient.invalidateQueries({ queryKey: queryScopes.proposals });
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(data.proposalId) });
      void queryClient.invalidateQueries({ queryKey: queryScopes.operations });
      return;
    }

    case 'approval.decided': {
      const data = event.data as { proposalId: string; decision: 'approved' | 'rejected' };
      toast?.(
        data.decision === 'approved'
          ? 'Proposta aprovada pelo gestor.'
          : 'Proposta rejeitada pelo gestor.',
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.proposal(data.proposalId) });
      void queryClient.invalidateQueries({ queryKey: queryScopes.proposals });
      void queryClient.invalidateQueries({ queryKey: queryScopes.operations });
      return;
    }

    case 'internal_chat.new_message': {
      const data = event.data as { channelId: string };
      void queryClient.invalidateQueries({ queryKey: queryKeys.internalChannels() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.internalMessages(data.channelId) });
      return;
    }

    // Auditoria de 2026-09-17: a sessao do WhatsApp caiu e quem estava
    // atendendo continuou achando que o canal respondia. A queda avisa na
    // hora; a reconexao nao precisa de toast (o card ja muda sozinho).
    case 'channel.connection_changed': {
      const data = event.data as { channel: string; connected: boolean };
      if (!data.connected) {
        toast?.('WhatsApp desconectado — mensagens novas não estão chegando.', 'attention');
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.whatsappStatus() });
      void queryClient.invalidateQueries({ queryKey: queryScopes.settings });
      return;
    }
  }
}

const OPEN = 1;

export function createWsClient(options: WsClientOptions): WsClient {
  const {
    queryClient,
    getToken,
    toast,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    socketFactory = (url: string) => new WebSocket(url) as unknown as WebSocketLike,
  } = options;

  let socket: WebSocketLike | null = null;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let intentionallyClosed = false;
  let hasConnectedBefore = false;

  const delayFor = (attempt: number) => Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleReconnect(): void {
    if (intentionallyClosed) return;
    clearTimer();
    const delay = delayFor(attempts);
    attempts += 1;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function open(): void {
    const token = getToken();
    if (!token) return;

    const base = options.url ?? wsBaseUrl();
    const next = socketFactory(`${base}?token=${encodeURIComponent(token)}`);
    socket = next;

    next.onopen = () => {
      attempts = 0;
      if (hasConnectedBefore) {
        // Pode ter perdido evento durante a queda: refaz tudo que está ativo.
        void queryClient.invalidateQueries();
      }
      hasConnectedBefore = true;
    };

    next.onmessage = (message) => {
      const event = parseWsEvent(message.data);
      if (event) applyWsEvent(queryClient, event, toast);
    };

    next.onclose = () => {
      socket = null;
      scheduleReconnect();
    };

    next.onerror = () => {
      // `onclose` sempre vem em seguida — o agendamento fica lá, um só lugar.
    };
  }

  return {
    connect() {
      intentionallyClosed = false;
      if (socket) return;
      clearTimer();
      open();
    },

    disconnect() {
      intentionallyClosed = true;
      clearTimer();
      attempts = 0;
      hasConnectedBefore = false;
      const current = socket;
      socket = null;
      current?.close();
    },

    isConnected: () => socket !== null && socket.readyState === OPEN,
    reconnectAttempts: () => attempts,
    nextDelayMs: () => delayFor(attempts),
  };
}
