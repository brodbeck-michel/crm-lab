import type {
  AnalyticsQuery,
  ListAuditQuery,
  ListConversationsQuery,
  ListExamsQuery,
  ListProposalsQuery,
  PaginationQuery,
} from '@crm-lab/shared';

/**
 * Chaves de cache do TanStack Query — ÚNICO lugar que as define
 * (docs/frontend/PAGES.md — "Estado Global").
 *
 * É daqui que sai a invalidação correta a partir dos eventos WebSocket:
 * `api/ws.ts` importa estas mesmas funções, então evento e tela nunca
 * divergem de chave.
 *
 * Convenção: o primeiro elemento é o "escopo" (plural = listagem,
 * singular = item). `queryClient.invalidateQueries({ queryKey: ['proposals'] })`
 * pega todas as listagens de proposta, com qualquer filtro.
 */
export const queryKeys = {
  /** ['conversations', filters] */
  conversations: (filters?: ListConversationsQuery) => ['conversations', filters ?? {}] as const,
  /** ['conversation', id] */
  conversation: (id: string) => ['conversation', id] as const,

  /** ['proposals', filters] */
  proposals: (filters?: ListProposalsQuery) => ['proposals', filters ?? {}] as const,
  /** ['proposal', id] */
  proposal: (id: string) => ['proposal', id] as const,

  /** ['exams', filters] */
  exams: (filters?: ListExamsQuery) => ['exams', filters ?? {}] as const,

  /** ['analytics', period] */
  analytics: (period?: AnalyticsQuery) => ['analytics', period ?? {}] as const,
  /** ['analytics', 'pipeline'] — snapshot atual, sem período */
  analyticsPipeline: () => ['analytics', 'pipeline'] as const,

  /** ['theme'] */
  theme: () => ['theme'] as const,

  /** ['internal-chat', 'channels'] */
  internalChannels: () => ['internal-chat', 'channels'] as const,
  /** ['internal-chat', 'messages', channelId] */
  internalMessages: (channelId: string) => ['internal-chat', 'messages', channelId] as const,

  /** ['users', filters] */
  users: (filters?: PaginationQuery) => ['users', filters ?? {}] as const,
  /** ['users', 'me'] */
  currentUser: () => ['users', 'me'] as const,

  /** ['audit', filters] */
  audit: (filters?: ListAuditQuery) => ['audit', filters ?? {}] as const,

  /** ['platform', 'tenants'] */
  platformTenants: (filters?: PaginationQuery) => ['platform', 'tenants', filters ?? {}] as const,
  /** ['platform', 'billing'] */
  platformBilling: () => ['platform', 'billing'] as const,
} as const;

/** Prefixos usados para invalidar um escopo inteiro (todas as variações de filtro). */
export const queryScopes = {
  conversations: ['conversations'] as const,
  conversation: ['conversation'] as const,
  proposals: ['proposals'] as const,
  proposal: ['proposal'] as const,
  exams: ['exams'] as const,
  analytics: ['analytics'] as const,
  theme: ['theme'] as const,
  internalChat: ['internal-chat'] as const,
  users: ['users'] as const,
  audit: ['audit'] as const,
  platform: ['platform'] as const,
} as const;

/**
 * `staleTime` por domínio (docs/frontend/PAGES.md — "Estado Global"):
 * conversas 10s · catálogo 1h · analytics 5min.
 */
export const staleTimes = {
  conversations: 10_000,
  exams: 60 * 60_000,
  analytics: 5 * 60_000,
} as const;
