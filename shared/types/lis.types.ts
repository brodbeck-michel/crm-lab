/**
 * Domínio "Orçamentos do LIS" (Onda 9 — fusão CRM Lab + FluxoLab). Espelha
 * `docs/api/API_CONTRACTS.md` §10 (LIS Budgets & Imports) e §12 (Attendants),
 * `docs/database/SCHEMA.md` §24-26.
 *
 * Todos os shapes do domínio (imports, attendants, budgets, commission
 * settings, sales, relatório executivo) vivem neste ÚNICO arquivo — não crie
 * um segundo `lis*.types.ts`.
 */
import type { IsoDate, IsoDateTime, PaginationMeta, PaginationQuery } from './api.types.js';

// ---------------------------------------------------------------------------
// LIS Imports (API_CONTRACTS.md §10.1)
// ---------------------------------------------------------------------------

export type LisImportKind = 'import' | 'purge';
export type LisImportStatus = 'processing' | 'completed' | 'failed';

export interface LisImport {
  id: string;
  kind: LisImportKind;
  fileName: string | null;
  rowsInFile: number | null;
  rowsAccepted: number | null;
  rowsRejected: number | null;
  proposalsWon: number | null;
  status: LisImportStatus;
  errorMessage: string | null;
  createdBy: string | null;
  createdAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

export interface ImportLisSpreadsheetRequest {
  fileName: string;
  contentBase64: string;
}

export interface PurgeLisBudgetsRequest {
  confirm: string;
}

export interface ListLisImportsQuery extends PaginationQuery {}

export interface ListLisImportsResponse {
  imports: LisImport[];
  pagination: PaginationMeta;
}

/** `details.reason` de `VALIDATION_ERROR` em `POST /lis-imports`. */
export type LisImportInvalidReason = 'pdf_disguised' | 'missing_column' | 'empty';

// ---------------------------------------------------------------------------
// Attendants (API_CONTRACTS.md §12)
// ---------------------------------------------------------------------------

export interface Attendant {
  id: string;
  name: string;
  isActive: boolean;
  userId: string | null;
  userName: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ListAttendantsQuery extends PaginationQuery {
  active?: boolean;
  search?: string;
}

export interface ListAttendantsResponse {
  attendants: Attendant[];
  pagination: PaginationMeta;
}

export interface CreateAttendantRequest {
  name: string;
  userId?: string | null;
}

export interface UpdateAttendantRequest {
  name?: string;
  userId?: string | null;
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// LIS Budgets (API_CONTRACTS.md §10.2) — leitura, dono: LisAnalyticsService.
// ---------------------------------------------------------------------------

export interface LisBudget {
  id: string;
  number: string;
  issuedOn: IsoDate | null;
  patientName: string | null;
  principalInsuranceName: string | null;
  totalValue: number;
  insuranceId: string | null;
  attendantName: string | null;
  attendantId: string | null;
  requisitionNumber: string | null;
  requisitionValue: number | null;
  paidValue: number | null;
  paidOn: IsoDate | null;
  proposalId: string | null;
  createdAt: IsoDateTime;
}

export interface LisBudgetsPeriod {
  startDate: IsoDate;
  endDate: IsoDate;
}

/** Recorte "emissão" (BUSINESS_RULES.md §11.7) — orçamentos emitidos no período. */
export interface LisIssuedTotals {
  count: number;
  totalValue: number;
  averageTicket: number;
}

/** Recorte "pagamento" — requisições pagas no período (dedupe por requisição, §11.2). */
export interface LisPaidTotals {
  count: number;
  totalValue: number;
  averageTicket: number;
  conversionQty: number;
}

/**
 * "Em Requisição" (D-125) — orçamentos convertidos em requisição no período
 * (janela de EMISSÃO, dedupe por requisição), pagos ou não. Card "Em
 * Requisição" de `/results` — NÃO é o mesmo que Busca Ativa (§16, que é só a
 * fatia sem pagamento).
 */
export interface LisRequisitionTotals {
  count: number;
  totalValue: number;
}

export interface LisAttendantAgg {
  attendantId: string;
  attendantName: string;
  issuedCount: number;
  /** Requisições pagas do atendente no período (D-122) — base de `conversionQty` por linha. */
  paidCount: number;
  paidValue: number;
}

export interface LisInsuranceAgg {
  insuranceName: string;
  count: number;
  totalValue: number;
}

export interface ListLisBudgetsQuery extends PaginationQuery {
  startDate?: string;
  endDate?: string;
  attendantId?: string;
  insuranceId?: string;
  search?: string;
  sortBy?: 'issuedOn' | 'number' | 'totalValue';
  order?: 'asc' | 'desc';
}

export interface ListLisBudgetsResponse {
  budgets: LisBudget[];
  pagination: PaginationMeta;
}

export interface LisBudgetsSummaryQuery {
  startDate?: string;
  endDate?: string;
  attendantId?: string;
  insuranceId?: string;
}

export interface LisBudgetsSummary {
  period: LisBudgetsPeriod;
  issued: LisIssuedTotals;
  requisition: LisRequisitionTotals;
  paid: LisPaidTotals;
  /** Top 6 por `paidValue`, `[]` abaixo de `MIN_ORC_RANKING` (ranking qualitativo). */
  byAttendant: LisAttendantAgg[];
  /**
   * TODOS os atendentes do período, sem corte de `MIN_ORC_RANKING` (D-122) —
   * fonte do gráfico "Faturamento por atendente" e da tabela "Detalhe por
   * atendente" de `/results` (PAGES.md §14), que é relatório de comissão
   * (contábil), não ranking qualitativo: não pode sumir atendente por baixo
   * volume.
   */
  byAttendantDetail: LisAttendantAgg[];
  byInsurance: LisInsuranceAgg[];
}

export type LisBudgetAgeBand = '0-7' | '8-15' | '16-30' | '30+';

export const LIS_BUDGET_AGE_BANDS: readonly LisBudgetAgeBand[] = ['0-7', '8-15', '16-30', '30+'];

export interface PendingLisBudget {
  id: string;
  number: string;
  patientName: string | null;
  principalInsuranceName: string | null;
  totalValue: number;
  attendantName: string | null;
  attendantId: string | null;
  requisitionNumber: string | null;
  requisitionValue: number | null;
  issuedOn: IsoDate | null;
  daysOpen: number;
  ageBand: LisBudgetAgeBand;
}

export interface ListPendingLisBudgetsQuery extends PaginationQuery {
  attendantId?: string;
  ageBand?: LisBudgetAgeBand;
}

export interface ListPendingLisBudgetsResponse {
  budgets: PendingLisBudget[];
  pagination: PaginationMeta;
}

export interface PendingLisBudgetsSummaryQuery {
  attendantId?: string;
}

export interface PendingLisBudgetsSummary {
  total: { count: number; value: number };
  byAgeBand: Record<LisBudgetAgeBand, { count: number; value: number }>;
}

export interface LisBudgetsFilters {
  attendants: Array<{ id: string; name: string }>;
  insurances: Array<{ id: string; name: string }>;
  issuedOnRange: { min: IsoDate | null; max: IsoDate | null };
}

// ---------------------------------------------------------------------------
// Reports — Relatório Executivo do LIS (API_CONTRACTS.md §5c)
// ---------------------------------------------------------------------------

export interface ExecutiveReportMonthlyPoint {
  /** `YYYY-MM`. */
  month: string;
  issuedValue: number;
  paidValue: number;
}

export interface ExecutiveReport {
  period: LisBudgetsPeriod;
  issued: LisIssuedTotals;
  requisition: LisRequisitionTotals;
  paid: LisPaidTotals;
  monthlySeries: ExecutiveReportMonthlyPoint[];
  byAttendant: LisAttendantAgg[];
  byInsurance: LisInsuranceAgg[];
  brandName: string;
  logoUrl: string | null;
}

// ---------------------------------------------------------------------------
// Commission Settings (API_CONTRACTS.md §6b)
// ---------------------------------------------------------------------------

export interface CommissionSettings {
  commissionBudgetPct: number;
  commissionExamsPct: number;
  commissionCheckupPct: number;
}

export interface UpdateCommissionSettingsRequest {
  commissionBudgetPct?: number;
  commissionExamsPct?: number;
  commissionCheckupPct?: number;
}

// ---------------------------------------------------------------------------
// Sales (API_CONTRACTS.md §11)
// ---------------------------------------------------------------------------

export type SaleKind = 'exams' | 'checkup';

export interface Sale {
  id: string;
  attendantId: string;
  attendantName: string;
  soldOn: IsoDate;
  code: string | null;
  value: number;
  exams: string | null;
  kind: SaleKind;
  createdBy: string | null;
  createdAt: IsoDateTime;
}

export interface CreateSaleRequest {
  /** Obrigatório para manager/admin; ignorado (resolvido pelo vínculo) para attendant. */
  attendantId?: string;
  soldOn: string;
  code?: string;
  value: number;
  exams?: string;
  kind: SaleKind;
}

export interface ListSalesQuery extends PaginationQuery {
  startDate?: string;
  endDate?: string;
  attendantId?: string;
  kind?: SaleKind;
}

export interface ListSalesResponse {
  sales: Sale[];
  pagination: PaginationMeta;
}

export interface SalesSummaryQuery {
  startDate?: string;
  endDate?: string;
  attendantId?: string;
}

export interface SaleKindSummary {
  count: number;
  value: number;
  commissionValue: number;
}

export interface SalesAttendantSummary {
  attendantId: string;
  attendantName: string;
  byKind: Record<SaleKind, SaleKindSummary>;
  totalValue: number;
  commissionTotal: number;
}

export interface SalesSummary {
  period: LisBudgetsPeriod;
  byKind: Record<SaleKind, SaleKindSummary>;
  totalValue: number;
  commissionTotal: number;
  /**
   * Detalhe por atendente (D-122) — só para manager/admin SEM `attendantId`
   * na query (visão do tenant inteiro); `attendant` e chamadas já filtradas
   * por um `attendantId` recebem `undefined`. Fonte da tabela "Detalhe por
   * atendente" de `/results` (PAGES.md §14), combinada no CLIENTE com
   * `LisBudgetsSummary.byAttendantDetail` e `commissionBudgetPct`.
   */
  byAttendant?: SalesAttendantSummary[];
}
