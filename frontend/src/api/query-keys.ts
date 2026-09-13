import type {
  AnalyticsQuery,
  LisBudgetsSummaryQuery,
  ListAttendantsQuery,
  ListAuditQuery,
  ListConversationsQuery,
  ListExamsQuery,
  ListExamPackagesQuery,
  ListInsurancesQuery,
  ListLisBudgetsQuery,
  ListLisImportsQuery,
  ListPatientTimelineQuery,
  ListPatientsQuery,
  ListPendingLisBudgetsQuery,
  ListProposalsQuery,
  ListSalesQuery,
  OperationOverviewQuery,
  PaginationQuery,
  PendingLisBudgetsSummaryQuery,
  SalesSummaryQuery,
} from '@crm-lab/shared';
import type { ExecutiveReportQuery } from './reports';

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
  /** ['conversations', 'assignees'] — quem pode receber conversa. */
  conversationAssignees: () => ['conversations', 'assignees'] as const,

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

  /** ['exam-packages', filters] — aba "Pacotes" do Cadastro de Exames (CRMLAB-10). */
  examPackages: (filters?: ListExamPackagesQuery) => ['exam-packages', filters ?? {}] as const,
  /** ['exam-package-prices', packageId] — `GET /exam-packages/:id/prices`. */
  examPackagePrices: (packageId: string) => ['exam-package-prices', packageId] as const,

  /** ['insurances', filters] — `/settings/insurances` e o seletor de `/budget/new` (§8). */
  insurances: (filters?: ListInsurancesQuery) => ['insurances', filters ?? {}] as const,
  /** ['insurance', id] */
  insurance: (id: string) => ['insurance', id] as const,

  /** ['quick-replies'] — a lista inteira; o Composer filtra em memória (§9). */
  quickReplies: () => ['quick-replies'] as const,

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
  /** ['internal-chat', 'users'] — diretório de quem dá para abrir DM (D-101). */
  internalChatDirectory: () => ['internal-chat', 'users'] as const,

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
  /** ['platform', 'tenants', id] — detalhe por tenant (D-102) */
  platformTenant: (id: string) => ['platform', 'tenants', id] as const,

  // ── Domínio LIS (Onda 9/10 — API_CONTRACTS.md §5c/§6b/§10-12) ────────────

  /** ['lis-budgets', filters] — Conferência (`/reconciliation`, PAGES.md §15) */
  lisBudgets: (filters?: ListLisBudgetsQuery) => ['lis-budgets', filters ?? {}] as const,
  /** ['lis-budgets', 'summary', filters] — KPIs de `/results` recortáveis (§14) */
  lisBudgetsSummary: (filters?: LisBudgetsSummaryQuery) =>
    ['lis-budgets', 'summary', filters ?? {}] as const,
  /** ['lis-budgets', 'pending', filters] — Busca Ativa (`/active-search`, §16) */
  lisBudgetsPending: (filters?: ListPendingLisBudgetsQuery) =>
    ['lis-budgets', 'pending', filters ?? {}] as const,
  /** ['lis-budgets', 'pending', 'summary', filters] — cartões por faixa (§16) */
  lisBudgetsPendingSummary: (filters?: PendingLisBudgetsSummaryQuery) =>
    ['lis-budgets', 'pending', 'summary', filters ?? {}] as const,
  /** ['lis-budgets', 'filters'] — opções dos seletores de atendente/convênio */
  lisBudgetsFilters: () => ['lis-budgets', 'filters'] as const,

  /** ['lis-imports', filters] — histórico de importações/purges */
  lisImports: (filters?: ListLisImportsQuery) => ['lis-imports', filters ?? {}] as const,
  /** ['lis-imports', 'latest'] — "Última atualização em ..." (§14) */
  lisImportsLatest: () => ['lis-imports', 'latest'] as const,

  /** ['reports', 'executive', period] — Relatório Executivo + PDF (D-116) */
  reportsExecutive: (period?: ExecutiveReportQuery) =>
    ['reports', 'executive', period ?? {}] as const,

  /** ['sales', filters] — `/sales` (§17); atendente só vê as próprias */
  sales: (filters?: ListSalesQuery) => ['sales', filters ?? {}] as const,
  /** ['sales', 'summary', filters] — cartão de comissão de `/sales` */
  salesSummary: (filters?: SalesSummaryQuery) => ['sales', 'summary', filters ?? {}] as const,

  /** ['attendants', filters] — `/settings/attendants` (§18) */
  attendants: (filters?: ListAttendantsQuery) => ['attendants', filters ?? {}] as const,

  /** ['settings', 'commissions'] — `/settings/commissions` (§19) */
  commissionSettings: () => ['settings', 'commissions'] as const,
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
  quickReplies: ['quick-replies'] as const,
  analytics: ['analytics'] as const,
  theme: ['theme'] as const,
  internalChat: ['internal-chat'] as const,
  users: ['users'] as const,
  audit: ['audit'] as const,
  platform: ['platform'] as const,
  settings: ['settings'] as const,
  operations: ['operations'] as const,
  /**
   * Prefixos do domínio LIS — TRÊS escopos distintos (`invalidateQueries` faz
   * prefix-match; um array só não cobre os três). Invalidados juntos após
   * import e após purge (§14/§15/§16), os dois únicos eventos que mudam
   * `lis_budgets`.
   */
  lisBudgets: ['lis-budgets'] as const,
  lisImports: ['lis-imports'] as const,
  reportsExecutive: ['reports'] as const,
  sales: ['sales'] as const,
  attendants: ['attendants'] as const,
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
  /**
   * Domínio LIS (D-117): importação é esporádica, mas a tela precisa
   * refletir uma importação recém-feita sem exigir F5 manual.
   */
  lis: 60_000,
} as const;
