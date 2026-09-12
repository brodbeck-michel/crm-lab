/**
 * Acesso a `lis_budgets` para os KPIs do domínio LIS (SERVICES.md §20,
 * BUSINESS_RULES.md §11). SEM regra de alçada/gating — o `MIN_ORC_RANKING`
 * (§11.5) é aplicado pelo `LisAnalyticsService`, que conhece `issued.count`
 * antes de decidir se os rankings saem `[]`.
 *
 * Todo método recebe `tenantId` e os filtros já resolvidos (período YYYY-MM-DD,
 * `attendantId`/`insuranceId` opcionais) — validação de formato mora no
 * service (`resolvePeriod`, reaproveitado de `analytics.service.ts`).
 *
 * **Dedupe por requisição (§11.2):** `DISTINCT ON (requisition_number) ...
 * ORDER BY requisition_number, paid_value DESC` — a mesma requisição pode
 * aparecer em mais de uma linha de `lis_budgets` (reimportação com pagamento
 * atualizado); só a de maior `paid_value` conta para qualquer KPI de
 * pagamento/Busca Ativa.
 */
import type { LisBudget, LisBudgetAgeBand, PendingLisBudget } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { toIso, toNumber } from './row-mappers.js';

// ---------------------------------------------------------------------------
// lis_budgets — leitura crua (GET /lis-budgets)
// ---------------------------------------------------------------------------

/** `issued_on`/`paid_on` são `DATE` puras (D-110) — `to_char` evita o driver devolver `Date`. */
const BUDGET_COLUMNS = `id, number, to_char(issued_on, 'YYYY-MM-DD') AS issued_on, patient_name,
  principal_insurance_name, total_value, insurance_id, attendant_name, attendant_id,
  requisition_number, requisition_value, paid_value, to_char(paid_on, 'YYYY-MM-DD') AS paid_on,
  proposal_id, created_at`;

interface BudgetRow {
  id: string;
  number: string;
  issued_on: string | null;
  patient_name: string | null;
  principal_insurance_name: string | null;
  total_value: string | number;
  insurance_id: string | null;
  attendant_name: string | null;
  attendant_id: string | null;
  requisition_number: string | null;
  requisition_value: string | number | null;
  paid_value: string | number | null;
  paid_on: string | null;
  proposal_id: string | null;
  created_at: Date | string;
}

function toLisBudget(row: BudgetRow): LisBudget {
  return {
    id: row.id,
    number: row.number,
    issuedOn: row.issued_on,
    patientName: row.patient_name,
    principalInsuranceName: row.principal_insurance_name,
    totalValue: toNumber(row.total_value),
    insuranceId: row.insurance_id,
    attendantName: row.attendant_name,
    attendantId: row.attendant_id,
    requisitionNumber: row.requisition_number,
    requisitionValue: row.requisition_value === null ? null : toNumber(row.requisition_value),
    paidValue: row.paid_value === null ? null : toNumber(row.paid_value),
    paidOn: row.paid_on,
    proposalId: row.proposal_id,
    createdAt: toIso(row.created_at),
  };
}

export interface BudgetListCriteria {
  startDate: string;
  endDate: string;
  attendantId?: string;
  insuranceId?: string;
  search?: string;
  sortBy: 'issuedOn' | 'number' | 'totalValue';
  order: 'asc' | 'desc';
  page: number;
  limit: number;
}

const SORT_COLUMNS: Record<BudgetListCriteria['sortBy'], string> = {
  issuedOn: 'issued_on',
  number: 'number',
  totalValue: 'total_value',
};

export async function listBudgets(
  tx: DbTx,
  tenantId: string,
  criteria: BudgetListCriteria,
): Promise<{ rows: LisBudget[]; total: number }> {
  const where: string[] = ['tenant_id = $1', 'issued_on BETWEEN $2 AND $3'];
  const params: unknown[] = [tenantId, criteria.startDate, criteria.endDate];

  if (criteria.attendantId !== undefined) {
    params.push(criteria.attendantId);
    where.push(`attendant_id = $${params.length}`);
  }
  if (criteria.insuranceId !== undefined) {
    params.push(criteria.insuranceId);
    where.push(`insurance_id = $${params.length}`);
  }
  if (criteria.search !== undefined && criteria.search.length > 0) {
    params.push(`%${criteria.search}%`);
    where.push(`patient_name ILIKE $${params.length}`);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const counted = await tx.query<{ total: number | string }>(
    `SELECT COUNT(*)::int AS total FROM lis_budgets ${whereSql}`,
    params,
  );
  const total = Number(counted.rows[0]?.total ?? 0);

  const orderColumn = SORT_COLUMNS[criteria.sortBy];
  const orderDirection = criteria.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (criteria.page - 1) * criteria.limit;
  const paged = await tx.query<BudgetRow>(
    `SELECT ${BUDGET_COLUMNS} FROM lis_budgets ${whereSql}
      ORDER BY ${orderColumn} ${orderDirection}, id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, criteria.limit, offset],
  );

  return { rows: paged.rows.map(toLisBudget), total };
}

// ---------------------------------------------------------------------------
// KPIs de Resultados (GET /lis-budgets/summary, GET /reports/executive)
// ---------------------------------------------------------------------------

export interface SummaryFilters {
  startDate: string;
  endDate: string;
  attendantId?: string;
  insuranceId?: string;
}

function summaryFilterClauses(
  filters: Pick<SummaryFilters, 'attendantId' | 'insuranceId'>,
  params: unknown[],
): string[] {
  const clauses: string[] = [];
  if (filters.attendantId !== undefined) {
    params.push(filters.attendantId);
    clauses.push(`attendant_id = $${params.length}`);
  }
  if (filters.insuranceId !== undefined) {
    params.push(filters.insuranceId);
    clauses.push(`insurance_id = $${params.length}`);
  }
  return clauses;
}

export interface IssuedTotalsRow {
  count: number;
  totalValue: number;
}

/** Janela de EMISSÃO: `issued_on` dentro do período (BUSINESS_RULES.md §11.7). */
export async function getIssuedTotals(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters,
): Promise<IssuedTotalsRow> {
  const params: unknown[] = [tenantId, filters.startDate, filters.endDate];
  const extra = summaryFilterClauses(filters, params);
  const where = ['tenant_id = $1', 'issued_on BETWEEN $2 AND $3', ...extra].join(' AND ');
  const result = await tx.query<{ count: number | string; total_value: string | number | null }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS total_value
       FROM lis_budgets WHERE ${where}`,
    params,
  );
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), totalValue: toNumber(row?.total_value) };
}

export interface RequisitionTotalsRow {
  count: number;
  totalValue: number;
}

/**
 * "Em Requisição" (D-125) — orçamentos que foram convertidos em requisição
 * (viraram venda efetiva no LIS), somando `requisition_value`. Janela de
 * EMISSÃO (`issued_on`, igual a `getIssuedTotals`) — **não** filtra por
 * pago/não pago: inclui TODA requisição do período, paga ou pendente. Dedupe
 * por requisição (maior `paid_value` vence, mesmo critério de §11.2, para a
 * linha representante ser a mesma que os outros KPIs de pagamento usam).
 *
 * Corrige a Onda 10: o card "Em Requisição" tinha sido implementado com a
 * definição de Busca Ativa (pendente = sem pagamento), que é uma pergunta
 * DIFERENTE — comparado com o app de referência do FluxoLab
 * (`orcamentos-sante-main/src/lib/orcamento.ts`, `kpis.reqValue`).
 */
export async function getRequisitionTotals(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters,
): Promise<RequisitionTotalsRow> {
  const params: unknown[] = [tenantId, filters.startDate, filters.endDate];
  const extra = summaryFilterClauses(filters, params);
  const where = [
    'tenant_id = $1',
    'issued_on BETWEEN $2 AND $3',
    'requisition_number IS NOT NULL',
    ...extra,
  ].join(' AND ');
  const result = await tx.query<{ count: number | string; total_value: string | number | null }>(
    `WITH req AS (
       SELECT DISTINCT ON (requisition_number) requisition_value, paid_value
         FROM lis_budgets
        WHERE ${where}
        ORDER BY requisition_number, paid_value DESC
     )
     SELECT COUNT(*)::int AS count, COALESCE(SUM(requisition_value), 0) AS total_value
       FROM req`,
    params,
  );
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), totalValue: toNumber(row?.total_value) };
}

export interface PaidTotalsRow {
  count: number;
  totalValue: number;
}

/**
 * Janela de PAGAMENTO: dedupe por requisição (maior `paid_value` vence,
 * BUSINESS_RULES.md §11.2), `paid_on` dentro do período e `paid_value > 0`.
 */
export async function getPaidTotals(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters,
): Promise<PaidTotalsRow> {
  const params: unknown[] = [tenantId];
  const extra = summaryFilterClauses(filters, params);
  const dedupeWhere = ['tenant_id = $1', 'requisition_number IS NOT NULL', ...extra].join(
    ' AND ',
  );
  params.push(filters.startDate, filters.endDate);
  const startIdx = params.length - 1;
  const endIdx = params.length;
  const result = await tx.query<{ count: number | string; total_value: string | number | null }>(
    `WITH req AS (
       SELECT DISTINCT ON (requisition_number) paid_value, paid_on
         FROM lis_budgets
        WHERE ${dedupeWhere}
        ORDER BY requisition_number, paid_value DESC
     )
     SELECT COUNT(*)::int AS count, COALESCE(SUM(paid_value), 0) AS total_value
       FROM req
      WHERE paid_on BETWEEN $${startIdx} AND $${endIdx} AND COALESCE(paid_value, 0) > 0`,
    params,
  );
  const row = result.rows[0];
  return { count: Number(row?.count ?? 0), totalValue: toNumber(row?.total_value) };
}

export interface AttendantAggRow {
  attendantId: string;
  attendantName: string;
  issuedCount: number;
  paidCount: number;
  paidValue: number;
}

/** `byAttendant` — issuedCount da janela de emissão, paidValue da de pagamento (§20). */
export async function getAttendantAgg(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters,
): Promise<AttendantAggRow[]> {
  const issuedParams: unknown[] = [tenantId, filters.startDate, filters.endDate];
  const issuedExtra = summaryFilterClauses(filters, issuedParams);
  const issuedWhere = [
    'tenant_id = $1',
    'issued_on BETWEEN $2 AND $3',
    'attendant_id IS NOT NULL',
    ...issuedExtra,
  ].join(' AND ');

  const paidParams: unknown[] = [tenantId];
  const paidExtra = summaryFilterClauses(filters, paidParams);
  const dedupeWhere = [
    'tenant_id = $1',
    'requisition_number IS NOT NULL',
    'attendant_id IS NOT NULL',
    ...paidExtra,
  ].join(' AND ');
  paidParams.push(filters.startDate, filters.endDate);
  const startIdx = paidParams.length - 1;
  const endIdx = paidParams.length;

  const [issuedResult, paidResult] = await Promise.all([
    tx.query<{ attendant_id: string; attendant_name: string; count: number | string }>(
      `SELECT attendant_id, MAX(attendant_name) AS attendant_name, COUNT(*)::int AS count
         FROM lis_budgets WHERE ${issuedWhere}
        GROUP BY attendant_id`,
      issuedParams,
    ),
    tx.query<{ attendant_id: string; count: number | string; paid_value: string | number | null }>(
      `WITH req AS (
         SELECT DISTINCT ON (requisition_number) attendant_id, paid_value, paid_on
           FROM lis_budgets WHERE ${dedupeWhere}
           ORDER BY requisition_number, paid_value DESC
       )
       SELECT attendant_id, COUNT(*)::int AS count, COALESCE(SUM(paid_value), 0) AS paid_value
         FROM req
        WHERE paid_on BETWEEN $${startIdx} AND $${endIdx} AND COALESCE(paid_value, 0) > 0
        GROUP BY attendant_id`,
      paidParams,
    ),
  ]);

  const paidByAttendant = new Map<string, { count: number; value: number }>(
    paidResult.rows.map((row) => [
      row.attendant_id,
      { count: Number(row.count), value: toNumber(row.paid_value) },
    ]),
  );

  return issuedResult.rows.map((row) => ({
    attendantId: row.attendant_id,
    attendantName: row.attendant_name,
    issuedCount: Number(row.count),
    paidCount: paidByAttendant.get(row.attendant_id)?.count ?? 0,
    paidValue: paidByAttendant.get(row.attendant_id)?.value ?? 0,
  }));
}

export interface InsuranceAggRow {
  insuranceName: string;
  count: number;
  totalValue: number;
}

/** `byInsurance` — só a janela de EMISSÃO (mesmo shape de API_CONTRACTS.md §5c/§10.2). */
export async function getInsuranceAgg(
  tx: DbTx,
  tenantId: string,
  filters: SummaryFilters,
): Promise<InsuranceAggRow[]> {
  const params: unknown[] = [tenantId, filters.startDate, filters.endDate];
  const extra = summaryFilterClauses(filters, params);
  const where = [
    'tenant_id = $1',
    'issued_on BETWEEN $2 AND $3',
    'principal_insurance_name IS NOT NULL',
    ...extra,
  ].join(' AND ');
  const result = await tx.query<{
    principal_insurance_name: string;
    count: number | string;
    total_value: string | number | null;
  }>(
    `SELECT principal_insurance_name, COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS total_value
       FROM lis_budgets WHERE ${where}
      GROUP BY principal_insurance_name
      ORDER BY total_value DESC
      LIMIT 6`,
    params,
  );
  return result.rows.map((row) => ({
    insuranceName: row.principal_insurance_name,
    count: Number(row.count),
    totalValue: toNumber(row.total_value),
  }));
}

/** 12 meses terminando no mês de `endDate` — `GET /reports/executive` (D-116). */
export interface MonthlyPointRow {
  month: string;
  issuedValue: number;
  paidValue: number;
}

export async function getMonthlySeries(
  tx: DbTx,
  tenantId: string,
  endDate: string,
): Promise<MonthlyPointRow[]> {
  const result = await tx.query<{
    month: string;
    issued_value: string | number | null;
    paid_value: string | number | null;
  }>(
    `WITH months AS (
       SELECT to_char(date_trunc('month', $2::date) - (n || ' months')::interval, 'YYYY-MM') AS month
         FROM generate_series(0, 11) AS n
     ),
     issued AS (
       SELECT to_char(issued_on, 'YYYY-MM') AS month, SUM(total_value) AS value
         FROM lis_budgets
        WHERE tenant_id = $1 AND issued_on IS NOT NULL
        GROUP BY 1
     ),
     req AS (
       SELECT DISTINCT ON (requisition_number) paid_on, paid_value
         FROM lis_budgets
        WHERE tenant_id = $1 AND requisition_number IS NOT NULL
        ORDER BY requisition_number, paid_value DESC
     ),
     paid AS (
       SELECT to_char(paid_on, 'YYYY-MM') AS month, SUM(paid_value) AS value
         FROM req
        WHERE paid_on IS NOT NULL AND COALESCE(paid_value, 0) > 0
        GROUP BY 1
     )
     SELECT months.month,
            COALESCE(issued.value, 0) AS issued_value,
            COALESCE(paid.value, 0) AS paid_value
       FROM months
       LEFT JOIN issued ON issued.month = months.month
       LEFT JOIN paid ON paid.month = months.month
      ORDER BY months.month ASC`,
    [tenantId, endDate],
  );
  return result.rows.map((row) => ({
    month: row.month,
    issuedValue: toNumber(row.issued_value),
    paidValue: toNumber(row.paid_value),
  }));
}

// ---------------------------------------------------------------------------
// Busca Ativa (GET /lis-budgets/pending, /pending/summary)
// ---------------------------------------------------------------------------

function ageBandCase(column = 'days_open'): string {
  return `CASE
    WHEN ${column} <= 7 THEN '0-7'
    WHEN ${column} <= 15 THEN '8-15'
    WHEN ${column} <= 30 THEN '16-30'
    ELSE '30+'
  END`;
}

export interface PendingListCriteria {
  attendantId?: string;
  ageBand?: LisBudgetAgeBand;
  page: number;
  limit: number;
}

interface PendingRow {
  id: string;
  number: string;
  patient_name: string | null;
  principal_insurance_name: string | null;
  total_value: string | number;
  attendant_name: string | null;
  attendant_id: string | null;
  requisition_number: string | null;
  requisition_value: string | number | null;
  issued_on: string | null;
  days_open: number | string;
  age_band: string;
}

function toPendingBudget(row: PendingRow): PendingLisBudget {
  return {
    id: row.id,
    number: row.number,
    patientName: row.patient_name,
    principalInsuranceName: row.principal_insurance_name,
    totalValue: toNumber(row.total_value),
    attendantName: row.attendant_name,
    attendantId: row.attendant_id,
    requisitionNumber: row.requisition_number,
    requisitionValue: row.requisition_value === null ? null : toNumber(row.requisition_value),
    issuedOn: row.issued_on,
    daysOpen: Number(row.days_open),
    ageBand: row.age_band as LisBudgetAgeBand,
  };
}

/** `req` deduplicado por requisição, com `days_open`/`age_band` computados. */
function pendingCte(attendantId: string | undefined, params: unknown[]): string {
  const where = ['tenant_id = $1', 'requisition_number IS NOT NULL'];
  if (attendantId !== undefined) {
    params.push(attendantId);
    where.push(`attendant_id = $${params.length}`);
  }
  return `req AS (
     SELECT DISTINCT ON (requisition_number)
            id, number, patient_name, principal_insurance_name, total_value,
            attendant_name, attendant_id, requisition_number, requisition_value,
            issued_on, paid_value
       FROM lis_budgets
      WHERE ${where.join(' AND ')}
      ORDER BY requisition_number, paid_value DESC
   ),
   pending AS (
     SELECT *, (CURRENT_DATE - issued_on) AS days_open
       FROM req
      WHERE COALESCE(paid_value, 0) = 0
   )`;
}

export async function listPendingBudgets(
  tx: DbTx,
  tenantId: string,
  criteria: PendingListCriteria,
): Promise<{ rows: PendingLisBudget[]; total: number }> {
  const params: unknown[] = [tenantId];
  const cte = pendingCte(criteria.attendantId, params);

  const outerWhere: string[] = [];
  if (criteria.ageBand !== undefined) {
    params.push(criteria.ageBand);
    outerWhere.push(`${ageBandCase()} = $${params.length}`);
  }
  const outerWhereSql = outerWhere.length > 0 ? `WHERE ${outerWhere.join(' AND ')}` : '';

  const counted = await tx.query<{ total: number | string }>(
    `WITH ${cte} SELECT COUNT(*)::int AS total FROM pending ${outerWhereSql}`,
    params,
  );
  const total = Number(counted.rows[0]?.total ?? 0);

  const offset = (criteria.page - 1) * criteria.limit;
  const paged = await tx.query<PendingRow>(
    `WITH ${cte}
     SELECT id, number, patient_name, principal_insurance_name, total_value,
            attendant_name, attendant_id, requisition_number, requisition_value,
            to_char(issued_on, 'YYYY-MM-DD') AS issued_on, days_open, ${ageBandCase()} AS age_band
       FROM pending
       ${outerWhereSql}
      ORDER BY days_open DESC, id ASC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, criteria.limit, offset],
  );

  return { rows: paged.rows.map(toPendingBudget), total };
}

export interface PendingSummaryRow {
  total: { count: number; value: number };
  byAgeBand: Record<LisBudgetAgeBand, { count: number; value: number }>;
}

export async function getPendingSummary(
  tx: DbTx,
  tenantId: string,
  attendantId: string | undefined,
): Promise<PendingSummaryRow> {
  const params: unknown[] = [tenantId];
  const cte = pendingCte(attendantId, params);

  const result = await tx.query<{
    age_band: string;
    count: number | string;
    value: string | number | null;
  }>(
    `WITH ${cte}
     SELECT ${ageBandCase()} AS age_band, COUNT(*)::int AS count, COALESCE(SUM(total_value), 0) AS value
       FROM pending
      GROUP BY 1`,
    params,
  );

  const byAgeBand: Record<LisBudgetAgeBand, { count: number; value: number }> = {
    '0-7': { count: 0, value: 0 },
    '8-15': { count: 0, value: 0 },
    '16-30': { count: 0, value: 0 },
    '30+': { count: 0, value: 0 },
  };
  let totalCount = 0;
  let totalValue = 0;
  for (const row of result.rows) {
    const band = row.age_band as LisBudgetAgeBand;
    const count = Number(row.count);
    const value = toNumber(row.value);
    byAgeBand[band] = { count, value };
    totalCount += count;
    totalValue += value;
  }

  return { total: { count: totalCount, value: totalValue }, byAgeBand };
}

// ---------------------------------------------------------------------------
// Filtros das telas (GET /lis-budgets/filters)
// ---------------------------------------------------------------------------

export interface LisBudgetsFiltersRow {
  attendants: Array<{ id: string; name: string }>;
  insurances: Array<{ id: string; name: string }>;
  issuedOnRange: { min: string | null; max: string | null };
}

/** Só atendentes/convênios que aparecem em algum `lis_budgets` do tenant (nunca o cadastro inteiro). */
export async function getFilters(tx: DbTx, tenantId: string): Promise<LisBudgetsFiltersRow> {
  const [attendants, insurances, range] = await Promise.all([
    tx.query<{ id: string; name: string }>(
      `SELECT DISTINCT a.id, a.name
         FROM lis_budgets b
         JOIN attendants a ON a.id = b.attendant_id
        WHERE b.tenant_id = $1
        ORDER BY a.name ASC`,
      [tenantId],
    ),
    tx.query<{ id: string; name: string }>(
      `SELECT DISTINCT i.id, i.name
         FROM lis_budgets b
         JOIN insurances i ON i.id = b.insurance_id
        WHERE b.tenant_id = $1
        ORDER BY i.name ASC`,
      [tenantId],
    ),
    tx.query<{ min: string | null; max: string | null }>(
      `SELECT to_char(MIN(issued_on), 'YYYY-MM-DD') AS min,
              to_char(MAX(issued_on), 'YYYY-MM-DD') AS max
         FROM lis_budgets WHERE tenant_id = $1`,
      [tenantId],
    ),
  ]);

  const rangeRow = range.rows[0];
  return {
    attendants: attendants.rows,
    insurances: insurances.rows,
    issuedOnRange: { min: rangeRow?.min ?? null, max: rangeRow?.max ?? null },
  };
}
