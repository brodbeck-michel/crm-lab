import type {
  AnalyticsQuery,
  ListAuditQuery,
  ListConversationsQuery,
  ListExamsQuery,
  ListInsurancesQuery,
  ListPatientTimelineQuery,
  ListPatientsQuery,
  ListProposalsQuery,
  OperationOverviewQuery,
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

  /** ['patients', filters] — busca de pacientes (`GET /patients`, §2c) */
  patients: (filters?: ListPatientsQuery) => ['patients', filters ?? {}] as const,
  /** ['patient', id] — cadastro + contadores da ficha (D-060) */
  patient: (id: string) => ['patient', id] as const,
  /** ['patient', id, 'timeline', filters] — paginada, filtro por `kind`/`order` */
  patientTimeline: (id: string, filters?: ListPatientTimelineQuery) =>
    ['patient', id, 'timeline', filters ?? {}] as const,

  /** ['proposals', filters] */
  proposals: (filters?: ListProposalsQuery) => ['proposals', filters ?? {}] as const,
  /** ['proposal', id] */
  proposal: (id: string) => ['proposal', id] as const,

  /** ['exams', filters] */
  exams: (filters?: ListExamsQuery) => ['exams', filters ?? {}] as const,
  /**
   * ['exams', 'infinite', filters] — o seletor de `/budget/new` acumula
   * páginas em vez de trocá-las (D-080). Chave separada de `exams()` de
   * propósito: o cache de `useInfiniteQuery` guarda `{ pages, pageParams }`,
   * um shape diferente do `ListExamsResponse` de `useExamList`, e as duas
   * telas não podem se servir da mesma entrada. Continua sob o escopo
   * `['exams']`, então `queryScopes.exams` invalida as duas de uma vez.
   */
  examsInfinite: (filters?: Omit<ListExamsQuery, 'page'>) =>
    ['exams', 'infinite', filters ?? {}] as const,

  /** ['exam-prices', examId] — `GET /exams/:id/prices` (§4/§8, D-081/D-082). */
  examPrices: (examId: string) => ['exam-prices', examId] as const,

  /** ['insurances', filters] — `/settings/insurances` e o seletor de `/budget/new` (§8). */
  insurances: (filters?: ListInsurancesQuery) => ['insurances', filters ?? {}] as const,
  /** ['insurance', id] */
  insurance: (id: string) => ['insurance', id] as const,

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

  /** ['settings', 'channels'] — Canais & Equipe (API_CONTRACTS.md §6) */
  channelSettings: () => ['settings', 'channels'] as const,

  /** ['settings', 'channels', 'whatsapp', 'qr'] — QR vigente, alvo do polling (§6.1) */
  whatsappQr: () => ['settings', 'channels', 'whatsapp', 'qr'] as const,
  /** ['settings', 'channels', 'whatsapp', 'status'] — status do card, sem QR (§6.1) */
  whatsappStatus: () => ['settings', 'channels', 'whatsapp', 'status'] as const,

  /** ['operations', 'overview', query] — retrato único da operação (D-067) */
  operationOverview: (query?: OperationOverviewQuery) =>
    ['operations', 'overview', query ?? {}] as const,

  /** ['platform', 'tenants'] */
  platformTenants: (filters?: PaginationQuery) => ['platform', 'tenants', filters ?? {}] as const,
  /** ['platform', 'billing'] */
  platformBilling: () => ['platform', 'billing'] as const,
} as const;

/** Prefixos usados para invalidar um escopo inteiro (todas as variações de filtro). */
export const queryScopes = {
  conversations: ['conversations'] as const,
  conversation: ['conversation'] as const,
  /** Pega cadastro E timeline do paciente — a timeline é `['patient', id, 'timeline', …]`. */
  patient: ['patient'] as const,
  /** Listagens/buscas de paciente, com qualquer filtro. */
  patients: ['patients'] as const,
  proposals: ['proposals'] as const,
  proposal: ['proposal'] as const,
  exams: ['exams'] as const,
  insurances: ['insurances'] as const,
  analytics: ['analytics'] as const,
  theme: ['theme'] as const,
  internalChat: ['internal-chat'] as const,
  users: ['users'] as const,
  audit: ['audit'] as const,
  platform: ['platform'] as const,
  settings: ['settings'] as const,
  operations: ['operations'] as const,
} as const;

/**
 * `staleTime` por domínio (docs/frontend/PAGES.md — "Estado Global"):
 * conversas 10s · catálogo 1h · analytics 5min.
 */
export const staleTimes = {
  conversations: 10_000,
  /**
   * Busca de paciente do inbox (D-079): o cadastro muda devagar e a busca é
   * digitada — 30s evita repetir a mesma consulta a cada ida e volta do foco.
   */
  patients: 30_000,
  exams: 60 * 60_000,
  analytics: 5 * 60_000,
  /**
   * Operação é painel de "agora" e o servidor não guarda cache (§7): 15s é
   * curto o bastante para não mostrar fila velha e longo o bastante para dois
   * cliques seguidos na aba não repetirem a agregação.
   */
  operation: 15_000,
} as const;
