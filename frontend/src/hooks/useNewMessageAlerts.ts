import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type {
  Channel,
  Conversation,
  GetConversationResponse,
  InternalMessage,
  ListConversationsQuery,
} from '@crm-lab/shared';
import { api, queryKeys, staleTimes } from '@/api';
import { playNewMessageSound } from '@/lib/notification-sound';
import { sidebarRoutesFor } from '@/routes/route-config';
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
 *
 * CRMLAB-116 (D-284): o Chat interno dá o mesmo aviso — sinal na lista de
 * canais (mesma query/cache da Sidebar), confirmado pela página 1 de mensagens
 * do canal para deixar de fora sistema, a própria pessoa e apagada. O título da
 * aba soma conversas + canais não lidos.
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
 * A fila da pessoa logada (D-241 item 1): atribuída a ela, sem dona ou em que
 * ela participa (CRMLAB-93, D-263 item 4) — o recorte do
 * `ConversationRepository.list` para atendente. Gestor/admin usam o MESMO
 * recorte para o aviso.
 */
export function isInMyQueue(
  conversation: Pick<Conversation, 'assignedTo' | 'participants'>,
  userId: string,
): boolean {
  return (
    conversation.assignedTo === null ||
    conversation.assignedTo === userId ||
    isParticipantOf(conversation, userId)
  );
}

function isParticipantOf(
  conversation: Pick<Conversation, 'participants'>,
  userId: string,
): boolean {
  return conversation.participants?.some((p) => p.id === userId) ?? false;
}

/** Corpo da notificação de quem foi chamada para a conversa (D-263 item 4). */
export const ADDED_ALERT_BODY = 'Você foi adicionada à conversa';

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
  /** Corpo fixo no lugar da contagem — "Você foi adicionada à conversa" (D-263). */
  body?: string;
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
  /** Conversas em que a pessoa já participava na carga anterior (D-263). */
  participating?: Set<string>;
}

/** Linha que a linha de base lembra — conversa do atendimento ou canal do chat (D-284). */
type BaselineRow = Pick<Conversation, 'id' | 'unreadCount' | 'lastMessageAt' | 'participants'>;

export function baselineOf(
  conversations: BaselineRow[],
  previous?: AlertsBaseline,
  userId?: string,
): AlertsBaseline {
  const known = new Map(previous?.known);
  let watermark = previous?.watermark ?? null;
  // A lista é a fonte inteira de participação: quem saiu some daqui.
  const participating = new Set<string>();
  for (const c of conversations) {
    if (userId !== undefined && isParticipantOf(c, userId)) participating.add(c.id);
    known.set(c.id, { unreadCount: c.unreadCount, lastMessageAt: c.lastMessageAt });
    if (c.lastMessageAt !== null && (watermark === null || c.lastMessageAt > watermark)) {
      watermark = c.lastMessageAt;
    }
  }
  return { known, watermark, participating };
}

/**
 * Conversas em que a pessoa passou a participar desde a carga anterior (D-263
 * item 4). Primeira carga é linha de base: quem foi adicionada com a tela
 * fechada encontra a conversa no chip "Participando", sem aviso atrasado.
 */
export function detectAddedAsParticipant(
  previous: AlertsBaseline,
  conversations: Conversation[],
  userId: string,
): NewMessageAlert[] {
  const before = previous.participating ?? new Set<string>();
  return conversations
    .filter((c) => isParticipantOf(c, userId) && !before.has(c.id))
    .map((c) => ({ conversationId: c.id, title: titleOf(c), count: 1, body: ADDED_ALERT_BODY }));
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

// ── Chat interno (CRMLAB-116, D-284) ────────────────────────────────────────

/** Mensagens lidas por canal candidato para confirmar o aviso (só leitura). */
export const CHANNEL_ALERT_PAGE_SIZE = 50;

/** Canais/DMs com mensagem não lida — entram na contagem única do título. */
export function countUnreadChannels(channels: Channel[]): number {
  return channels.filter((c) => c.unreadCount > 0).length;
}

/** Título da notificação: nome do canal ou, na DM, o da colega (como a `ChannelList`). */
export function channelTitle(channel: Channel): string {
  return channel.kind === 'dm' ? (channel.otherUserName ?? channel.name) : channel.name;
}

/**
 * Canais cujo `unreadCount` subiu junto com o `lastMessageAt` desde a carga
 * anterior — candidatos ao aviso. O `unreadCount` inclui mensagem de sistema
 * (D-068), por isso a confirmação vem de `freshFromColleagues`.
 */
export function detectNewChannelMessages(previous: AlertsBaseline, channels: Channel[]): Channel[] {
  return channels.filter((c) => {
    if (c.unreadCount === 0) return false;
    const before = previous.known.get(c.id);
    return before
      ? c.unreadCount > before.unreadCount && c.lastMessageAt !== before.lastMessageAt
      : c.lastMessageAt !== null &&
          (previous.watermark === null || c.lastMessageAt > previous.watermark);
  });
}

/** Mensagens de colega (nem sistema, nem minha, nem apagada) depois de `since`. */
export function freshFromColleagues(
  messages: InternalMessage[],
  userId: string,
  since: string | null,
): InternalMessage[] {
  return messages.filter(
    (m) =>
      !m.isSystem &&
      m.senderId !== null &&
      m.senderId !== userId &&
      !m.deletedAt &&
      (since === null || m.createdAt > since),
  );
}

/** Pode usar o Chat interno: mesmo critério da Sidebar (`hasInternalChatRoute`). */
function hasInternalChatRoute(role: Parameters<typeof sidebarRoutesFor>[0]): boolean {
  return sidebarRoutesFor(role).some((route) => route.path === '/internal-chat');
}

/** O que a notificação precisa — já sem nada do conteúdo (D-240). */
interface FiredAlert {
  tag: string;
  title: string;
  body: string;
  href: string;
}

function conversationAlert(alert: NewMessageAlert): FiredAlert {
  return {
    tag: alert.conversationId,
    title: alert.title,
    body: alert.body ?? alertBody(alert.count),
    href: `/attendance?conversationId=${encodeURIComponent(alert.conversationId)}`,
  };
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

  // D-284: a MESMA query/cache de canais da Sidebar e da tela do chat.
  const chatUserId = userId !== null && hasInternalChatRoute(user?.role) ? userId : null;
  const channelsQuery = useQuery({
    queryKey: queryKeys.internalChannels(),
    queryFn: () => api.internalChat.channels(),
    enabled: chatUserId !== null,
  });

  const baselineRef = useRef<AlertsBaseline | null>(null);
  const channelsBaselineRef = useRef<AlertsBaseline | null>(null);
  // `navigate` muda de identidade a cada navegação; a notificação já exibida
  // precisa do atual quando for clicada.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const fireRef = useRef<(alerts: FiredAlert[], fromOpenConversation: boolean) => void>(
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
          body: alert.body,
          tag: alert.tag,
        });
        notification.onclick = () => {
          window.focus();
          navigateRef.current(alert.href);
          notification.close();
        };
      } catch {
        // Navegador que exige Service Worker para notificar (Android) — só não notifica.
      }
    }
  };

  // Título da aba — acompanha as listas (inclusive a leitura, que as invalida).
  // Contagem ÚNICA (D-284): conversas da fila + canais do chat com não lidas.
  const unreadConversations =
    userId !== null && listQuery.data
      ? countUnreadInQueue(listQuery.data.conversations, userId)
      : 0;
  const unreadChannels =
    chatUserId !== null && channelsQuery.data
      ? countUnreadChannels(channelsQuery.data.channels)
      : 0;
  const unread = unreadConversations + unreadChannels;
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
    baselineRef.current = baselineOf(data.conversations, previous ?? undefined, userId);
    if (!previous) return; // primeira carga = linha de base
    const openId = useMessageAlertsStore.getState().openConversationId;
    fireRef.current(
      [
        ...detectAddedAsParticipant(previous, data.conversations, userId),
        ...detectNewMessages(previous, data.conversations, userId, openId),
      ].map(conversationAlert),
      false,
    );
  }, [listQuery.data, userId]);

  // Chat interno (D-284): candidatos pela lista, confirmados pela página 1.
  useEffect(() => {
    const data = channelsQuery.data;
    if (!data || chatUserId === null) return;
    const previous = channelsBaselineRef.current;
    channelsBaselineRef.current = baselineOf(data.channels, previous ?? undefined);
    if (!previous) return; // primeira carga = linha de base
    const openId = useMessageAlertsStore.getState().openInternalChannelId;
    for (const channel of detectNewChannelMessages(previous, data.channels)) {
      const fromOpen = channel.id === openId;
      // Canal aberto com a aba em foco: nem busca (D-241 item 3).
      if (fromOpen && isTabFocused()) continue;
      const since = previous.known.get(channel.id)?.lastMessageAt ?? previous.watermark;
      api.internalChat
        .messages(channel.id, { page: 1, limit: CHANNEL_ALERT_PAGE_SIZE })
        .then(({ messages }) => {
          if (freshFromColleagues(messages, chatUserId, since).length === 0) return;
          const count = freshFromColleagues(messages, chatUserId, channel.lastReadAt).length;
          fireRef.current(
            [
              {
                tag: `internal-chat:${channel.id}`,
                title: channelTitle(channel),
                body: alertBody(count),
                href: `/internal-chat?channelId=${encodeURIComponent(channel.id)}`,
              },
            ],
            fromOpen,
          );
        })
        .catch(() => {
          // Falhou a confirmação: sem aviso — o badge e o título continuam valendo.
        });
    }
  }, [channelsQuery.data, chatUserId]);

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
        [
          conversationAlert({
            conversationId,
            title: titleOf(data.conversation),
            count: fresh.length,
          }),
        ],
        true,
      );
    });
  }, [queryClient, userId]);
}
