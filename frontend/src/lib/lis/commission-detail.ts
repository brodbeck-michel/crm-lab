import type { LisAttendantAgg, SalesAttendantSummary } from '@crm-lab/shared';

/**
 * "Detalhe por atendente" — combinação feita no CLIENTE de
 * `LisBudgetsSummary.byAttendantDetail` (orçado/pago/conversão) +
 * `SalesSummary.byAttendant` (vendas de exames/check-up) + os percentuais de
 * `/settings/commissions` (D-122). Nenhum endpoint faz esse join no
 * servidor: `lis_budgets` e `sales` são domínios de leitura separados por
 * design (D-108/D-112), e `/results` é o único lugar que precisa da visão
 * combinada — ver docs/frontend/PAGES.md §14.
 */

export interface CommissionDetailRow {
  attendantId: string;
  attendantName: string;
  issuedCount: number;
  paidCount: number;
  paidValue: number;
  /** `paidCount / issuedCount`, capado em 100% — mesma fórmula do agregado do servidor. */
  conversionQty: number;
  examsValue: number;
  examsCommission: number;
  checkupValue: number;
  checkupCommission: number;
  budgetCommission: number;
  totalCommission: number;
}

export interface CommissionDetailTotals {
  issuedCount: number;
  paidValue: number;
  examsValue: number;
  examsCommission: number;
  checkupValue: number;
  checkupCommission: number;
  budgetCommission: number;
  totalCommission: number;
}

function conversionPct(paidCount: number, issuedCount: number): number {
  if (issuedCount <= 0) return 0;
  return Math.min(100, (paidCount / issuedCount) * 100);
}

export function buildCommissionDetail(
  byAttendantDetail: LisAttendantAgg[],
  salesByAttendant: SalesAttendantSummary[] | undefined,
  commissionBudgetPct: number,
): CommissionDetailRow[] {
  const salesById = new Map((salesByAttendant ?? []).map((row) => [row.attendantId, row]));

  return byAttendantDetail.map((agg) => {
    const sales = salesById.get(agg.attendantId);
    const examsValue = sales?.byKind.exams.value ?? 0;
    const examsCommission = sales?.byKind.exams.commissionValue ?? 0;
    const checkupValue = sales?.byKind.checkup.value ?? 0;
    const checkupCommission = sales?.byKind.checkup.commissionValue ?? 0;
    const budgetCommission = Math.round(((agg.paidValue * commissionBudgetPct) / 100) * 100) / 100;

    return {
      attendantId: agg.attendantId,
      attendantName: agg.attendantName,
      issuedCount: agg.issuedCount,
      paidCount: agg.paidCount,
      paidValue: agg.paidValue,
      conversionQty: conversionPct(agg.paidCount, agg.issuedCount),
      examsValue,
      examsCommission,
      checkupValue,
      checkupCommission,
      budgetCommission,
      totalCommission: Math.round((budgetCommission + examsCommission + checkupCommission) * 100) / 100,
    };
  });
}

export function totalsOf(rows: CommissionDetailRow[]): CommissionDetailTotals {
  return rows.reduce(
    (acc, row) => ({
      issuedCount: acc.issuedCount + row.issuedCount,
      paidValue: acc.paidValue + row.paidValue,
      examsValue: acc.examsValue + row.examsValue,
      examsCommission: acc.examsCommission + row.examsCommission,
      checkupValue: acc.checkupValue + row.checkupValue,
      checkupCommission: acc.checkupCommission + row.checkupCommission,
      budgetCommission: acc.budgetCommission + row.budgetCommission,
      totalCommission: acc.totalCommission + row.totalCommission,
    }),
    {
      issuedCount: 0,
      paidValue: 0,
      examsValue: 0,
      examsCommission: 0,
      checkupValue: 0,
      checkupCommission: 0,
      budgetCommission: 0,
      totalCommission: 0,
    },
  );
}
