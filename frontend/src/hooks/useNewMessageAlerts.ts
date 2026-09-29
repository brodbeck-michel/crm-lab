import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  Conversation,
  GetConversationResponse,
  ListConversationsQuery,
} from '@crm-lab/shared';
import { api, queryKeys, staleTimes } from '@/api';
import { playNewMessageSound } from '@/lib/notification-sound';
import { selectUser, useAuthStore } from '@/stores';
import { useMessageAlertsStore } from '@/stores/message-alerts.store';

/**
 * Aviso de mensagem nova, padrão WhatsApp Web (CRMLAB-72, D-240/D-241).
 *
 * Montado no `AppShell`: vale em qualquer tela do laboratório. Faz três coisas:
 *  1. título da aba "(N) <título>" — N = conversas da fila com não lidas;
 *  2. notificação do navegador com a aba SEM foco — só nome + "Nova mensagem"
 *     (D-240: NUNCA o conteúdo; o `body` sai de `alertBody`, que só recebe um
 *     número);
 *  3. som — aba sem foco, ou mensagem de OUTRA conversa que não a aberta.
 *
 * Sinal de "mensagem do paciente" (D-241 item 2): o `unreadCount` subir junto
 * com o `lastMessageAt`. O servidor só incrementa o contador em
 * `createFromPatient`, então mensagem da equipe e evento de sistema não avisam.
 * A conversa ABERTA é a exceção (abrir zera o contador): para ela o sinal é o
 * detalhe já carregado pelo Atendimento (D-241 item 3).
 */

/**
 * A query do aviso e do contador (D-241 item 6). Ordenada por não lidas: os
 * 100 primeiros contêm todas as não lidas em qualquer operação realista.
 */
export const ALERTS_QUERY: ListConversationsQuery = {
  status: 'active',
  scope: 'all',
  sortBy: 'unreadCount',
  order: 'desc',
  limit: 100,
};

/**
 * A fila da pessoa logada (D-241 item 1): atribuída a ela ou sem dona — o
 * recorte do `ConversationRepository.list` para atendente e o par dos chips
 * "Minhas"/"Não atribuídas". Gestor/admin usam o MESMO recorte para o aviso.
 */
export function isInMyQueue(
  conversation: Pick<Conversation, 'assignedTo'>,
  userId: string,
): boolean {
  return conversation.assignedTo === null || conversation.assignedTo === userId;
}

/** Quantas conversas da fila têm mensagem não lida. */
export function countUnreadInQueue(conversations: Conversation[], userId: string): number {
  return conversations.filter((c) => c.unreadCount > 0 && isInMyQueue(c, userId)).length;
}

const COUNT_PREFIX = /^\(\d+\)\s+/;

export function titleWithCount(title: string, count: number): string {
  const base = title.replace(COUNT_PREFIX, '');
  return count > 0 ? `(${count}) ${base}` : base;
}

/**
 * Corpo da notificação — D-240. Recebe SÓ a contagem, de propósito: não há
 * como o conteúdo da mensagem chegar aqui.
 */
export function alertBody(count: number): string {
  return count > 1 ? `${count} novas mensagens` : 'Nova mensagem';
}

export interface NewMessageAlert {
  conversationId: string;
  /** Nome do paciente; sem nome, o telefone que a fila já mostra. */
  title: string;
  count: number;
}

interface KnownConversation {
  unreadCount: number;
  lastMessageAt: string | null;
}

/** O que o hook lembra entre duas cargas da lista. */
export interface AlertsBaseline {
  known: Map<string, KnownConversation>;
  /** Maior `lastMessageAt` da carga anterior (relógio do servidor). */
  watermark: string | null;
}

export function baselineOf(
  conversations: Conversation[],
  previous?: AlertsBaseline,
): AlertsBaseline {
  const known = new Map(previous?.known);
  let watermark = previous?.watermark ?? null;
  for (const c of conversations) {
    known.set(c.id, { unreadCount: c.unreadCount, lastMessageAt: c.lastMessageAt });
    if (c.lastMessageAt !== null && (watermark === null || c.lastMessageAt > watermark)) {
      watermark = c.lastMessageAt;
    }
  }
  return { known, watermark };
}

function titleOf(c: Pick<Conversation, 'patientName' | 'patientPhone'>): string {
  return c.patientName ?? c.patientPhone;
}

/**
 * Conversas da fila que receberam mensagem de paciente desde a carga anterior
 * (D-241 item 2). A conversa aberta fica de fora: quem cuida dela é o detalhe.
 */
export function detectNewMessages(
  previous: AlertsBaseline,
  conversations: Conversation[],
  userId: string,
  openConversationId: string | null,
): NewMessageAlert[] {
  const alerts: NewMessageAlert[] = [];
  for (const c of conversations) {
    if (c.id === openConversationId || c.unreadCount === 0 || !isInMyQueue(c, userId)) continue;
    const before = previous.known.get(c.id);
    const isNew = before
      ? c.unreadCount > before.unreadCount && c.lastMessageAt !== before.lastMessageAt
      : c.lastMessageAt !== null &&
        (previous.watermark === null || c.lastMessageAt > previous.watermark);
    if (isNew) alerts.push({ conversationId: c.id, title: titleOf(c), count: c.unreadCount });
  }
  return alerts;
}

/** Aba em foco (D-241 item 4): visível E com o foco do sistema. */
export function isTabFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function notificationsGranted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/**
 * O detalhe da conversa vive no cache em dois formatos: o objeto simples e, desde o CRMLAB-71
 * (D-238), as páginas do `useInfiniteQuery` (`{ pages, pageParams }`). Achata os dois.
 */
function detailOf(data: unknown): GetConversationResponse | null {
  if (typeof data !== 'object' || data === null) return null;
  if ('pages' in data && Array.isArray(data.pages)) {
    const pages = data.pages as GetConversationResponse[];
    const first = pages[0];
    if (!first) return null;
    return { ...first, messages: pages.flatMap((p) => p.messages ?? []) };
  }
  if ('messages' in data && Array.isArray(data.messages)) return data as GetConversationResponse;
  return null;
}

function newestMessageAt(data: GetConversationResponse): string | null {
  let max: string | null = null;
  for (const m of data.messages) {
    if (max === null || m.createdAt > max) max = m.createdAt;
  }
  return max;
}

export function useNewMessageAlerts(): void {
  const user = useAuthStore(selectUser);
  const userId = user && user.role !== 'platform_operator' ? user.id : null;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const listQuery = useQuery({
    queryKey: queryKeys.conversations(ALERTS_QUERY),
    queryFn: () => api.conversations.list(ALERTS_QUERY),
    staleTime: staleTimes.conversations,
    enabled: userId !== null,
  });

  const baselineRef = useRef<AlertsBaseline | null>(null);
  // `navigate` muda de identidade a cada navegação; a notificação já exibida
  // precisa do atual quando for clicada.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const fireRef = useRef<(alerts: NewMessageAlert[], fromOpenConversation: boolean) => void>(
    () => undefined,
  );

  fireRef.current = (alerts, fromOpenConversation) => {
    if (alerts.length === 0) return;
    const focused = isTabFocused();
    // Conversa aberta com a aba em foco: nada (a atendente está olhando).
    if (fromOpenConversation && focused) return;
    const { soundEnabled, notificationsEnabled } = useMessageAlertsStore.getState();

    if (soundEnabled) playNewMessageSound();
    if (focused || !notificationsEnabled || !notificationsGranted()) return;

    for (const alert of alerts) {
      try {
        // D-240: title = nome; body = contagem. Nada de conteúdo, ícone de
        // anexo ou `image`.
        const notification = new Notification(alert.title, {
          body: alertBody(alert.count),
          tag: alert.conversationId,
        });
        notification.onclick = () => {
          window.focus();
          navigateRef.current(
            `/attendance?conversationId=${encodeURIComponent(alert.conversationId)}`,
          );
          notification.close();
        };
      } catch {
        // Navegador que exige Service Worker para notificar (Android) — só não notifica.
      }
    }
  };

  // Título da aba — acompanha a lista (inclusive a leitura, que a invalida).
  const unread =
    userId !== null && listQuery.data
      ? countUnreadInQueue(listQuery.data.conversations, userId)
      : 0;
  useEffect(() => {
    document.title = titleWithCount(document.title, unread);
  }, [unread]);
  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
    },
    [],
  );

  // Aviso das conversas da fila (menos a aberta).
  useEffect(() => {
    const data = listQuery.data;
    if (!data || userId === null) return;
    const previous = baselineRef.current;
    baselineRef.current = baselineOf(data.conversations, previous ?? undefined);
    if (!previous) return; // primeira carga = linha de base
    const openId = useMessageAlertsStore.getState().openConversationId;
    fireRef.current(detectNewMessages(previous, data.conversations, userId, openId), false);
  }, [listQuery.data, userId]);

  // Conversa aberta: mensagem de paciente mais nova que a última vista no detalhe.
  useEffect(() => {
    if (userId === null) return;
    const lastSeen = new Map<string, string | null>();
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      const [scope, conversationId] = event.query.queryKey;
      if (scope !== 'conversation' || typeof conversationId !== 'string') return;
      if (conversationId !== useMessageAlertsStore.getState().openConversationId) return;
      const data = detailOf(event.query.state.data);
      if (!data) return;

      // `undefined` = primeira carga desta conversa aberta = linha de base.
      const seenAt = lastSeen.get(conversationId);
      const loaded = newestMessageAt(data);
      // Aberta no meio (busca, CRMLAB-68/D-230): a janela pode não ter a última
      // mensagem — a linha de base é a da CONVERSA, senão ir para a ponta depois
      // contaria como "nova" toda mensagem que já estava lá.
      const last = data.conversation.lastMessageAt;
      const newest =
        seenAt === undefined && last !== null && (loaded === null || last > loaded) ? last : loaded;
      lastSeen.set(
        conversationId,
        seenAt === undefined || seenAt === null || (newest !== null && newest > seenAt)
          ? newest
          : seenAt,
      );
      if (seenAt === undefined || !isInMyQueue(data.conversation, userId)) return;

      const fresh = data.messages.filter(
        (m) => m.senderType === 'patient' && (seenAt === null || m.createdAt > seenAt),
      );
      if (fresh.length === 0) return;
      fireRef.current(
        [{ conversationId, title: titleOf(data.conversation), count: fresh.length }],
        true,
      );
    });
  }, [queryClient, userId]);
}
