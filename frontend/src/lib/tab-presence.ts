/**
 * Quantas abas do CRM estão abertas neste navegador (CRMLAB-122, D-288).
 *
 * O limite de requisições é POR USUÁRIO (`RATE_LIMIT_PER_MINUTE`), não por aba:
 * cada aba a mais soma no mesmo balde. Em prod (27/10) atendentes com 3–5 abas
 * passavam de 110 req/min e caíam. Este módulo:
 *  1. conta as outras abas (aviso discreto "o CRM está aberto em N abas");
 *  2. elege QUAL aba escondida continua viva para o aviso de mensagem nova
 *     (`keepsBackgroundAlive`): se alguma aba do CRM está visível, nenhuma
 *     escondida precisa refazer nada; se todas estão escondidas, só a mais
 *     antiga refaz o que o aviso precisa. As outras ficam quietas até voltarem
 *     a ficar visíveis.
 *
 * Mecanismo: `BroadcastChannel` (mesmo origin, sem servidor). Cada aba anuncia
 * `hello` ao abrir, `beat` a cada 5 s e ao mudar de visibilidade, `bye` ao
 * fechar. Aba que some sem `bye` (travou, processo morto) sai da conta depois
 * de 15 s sem `beat`. Sem `BroadcastChannel` (browser antigo, jsdom) o módulo
 * se comporta como aba única: nunca avisa e sempre mantém o aviso vivo — o
 * comportamento de antes deste card.
 */

export interface BroadcastChannelLike {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface TabPresenceOptions {
  /** `null` = sem coordenação (aba única). Padrão: `new BroadcastChannel(...)`. */
  channel?: BroadcastChannelLike | null;
  now?: () => number;
  isVisible?: () => boolean;
  heartbeatMs?: number;
  staleMs?: number;
  id?: string;
  startedAt?: number;
}

export interface TabPresence {
  start: () => void;
  stop: () => void;
  /** Quantas OUTRAS abas do CRM estão vivas. */
  otherTabs: () => number;
  /** Esta aba, escondida, deve continuar refazendo o que o aviso de mensagem precisa? */
  keepsBackgroundAlive: () => boolean;
  /** Para `useSyncExternalStore`: chama quando a contagem muda. */
  subscribe: (listener: () => void) => () => void;
  /** Exposto para teste: processa uma mensagem como se viesse do canal. */
  receive: (data: unknown) => void;
  /** Exposto para teste: roda o ciclo do batimento (anuncia + poda). */
  tick: () => void;
}

export const TAB_PRESENCE_CHANNEL = 'crm-lab:tabs';
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_MS = 15_000;

interface Peer {
  startedAt: number;
  visible: boolean;
  lastSeen: number;
}

type TabMessage =
  | { type: 'hello' | 'beat'; id: string; startedAt: number; visible: boolean }
  | { type: 'bye'; id: string };

function isTabMessage(data: unknown): data is TabMessage {
  if (typeof data !== 'object' || data === null) return false;
  const m = data as Partial<TabMessage> & { startedAt?: unknown; visible?: unknown };
  if (typeof m.id !== 'string') return false;
  if (m.type === 'bye') return true;
  return (
    (m.type === 'hello' || m.type === 'beat') &&
    typeof m.startedAt === 'number' &&
    typeof m.visible === 'boolean'
  );
}

function defaultChannel(): BroadcastChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(TAB_PRESENCE_CHANNEL) as unknown as BroadcastChannelLike;
  } catch {
    return null;
  }
}

function defaultIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

export function createTabPresence(options: TabPresenceOptions = {}): TabPresence {
  const now = options.now ?? (() => Date.now());
  const isVisible = options.isVisible ?? defaultIsVisible;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const id = options.id ?? `${now()}-${Math.random().toString(36).slice(2, 10)}`;
  const startedAt = options.startedAt ?? now();

  const peers = new Map<string, Peer>();
  const listeners = new Set<() => void>();
  let channel: BroadcastChannelLike | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastCount = 0;

  function notifyIfChanged(): void {
    if (peers.size === lastCount) return;
    lastCount = peers.size;
    for (const listener of listeners) listener();
  }

  function post(type: 'hello' | 'beat' | 'bye'): void {
    if (!channel) return;
    const message: TabMessage =
      type === 'bye' ? { type, id } : { type, id, startedAt, visible: isVisible() };
    try {
      channel.postMessage(message);
    } catch {
      // Canal fechado no meio do unload — nada a fazer.
    }
  }

  function prune(): void {
    const cutoff = now() - staleMs;
    for (const [peerId, peer] of peers) {
      if (peer.lastSeen < cutoff) peers.delete(peerId);
    }
  }

  function receive(data: unknown): void {
    if (!isTabMessage(data) || data.id === id) return;
    if (data.type === 'bye') {
      peers.delete(data.id);
    } else {
      const isNew = !peers.has(data.id);
      peers.set(data.id, { startedAt: data.startedAt, visible: data.visible, lastSeen: now() });
      // A aba nova precisa saber de nós já, não daqui a 5 s.
      if (data.type === 'hello' && isNew) post('beat');
    }
    notifyIfChanged();
  }

  function tick(): void {
    post('beat');
    prune();
    notifyIfChanged();
  }

  const onVisibility = () => post('beat');
  const onPageHide = () => post('bye');

  return {
    start() {
      if (channel) return;
      channel = options.channel === undefined ? defaultChannel() : options.channel;
      if (!channel) return;
      channel.onmessage = (event) => receive(event.data);
      post('hello');
      timer = setInterval(tick, heartbeatMs);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    },

    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      post('bye');
      channel?.close();
      channel = null;
      peers.clear();
      notifyIfChanged();
    },

    otherTabs() {
      prune();
      return peers.size;
    },

    keepsBackgroundAlive() {
      prune();
      for (const [peerId, peer] of peers) {
        if (peer.visible) return false;
        // Mais antiga vence; empate (mesmo ms) desempata pelo id.
        if (peer.startedAt < startedAt || (peer.startedAt === startedAt && peerId < id)) {
          return false;
        }
      }
      return true;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    receive,
    tick,
  };
}

let shared: TabPresence | null = null;

/** A instância da aba (criada e iniciada na primeira chamada). */
export function getTabPresence(): TabPresence {
  if (!shared) {
    // Nos testes (Vitest/jsdom) a instância global nasce SEM canal: o Node
    // expõe `BroadcastChannel` e o batimento com `setInterval` brigaria com os
    // fake timers das specs que montam o AppShell. Quem testa a coordenação
    // cria a própria instância com `createTabPresence({ channel })`.
    shared = createTabPresence(import.meta.env.MODE === 'test' ? { channel: null } : {});
    shared.start();
  }
  return shared;
}
