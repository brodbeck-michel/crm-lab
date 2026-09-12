/**
 * Acesso às colunas de comissão de `tenant_settings` (SCHEMA.md §16, ALTER da
 * migração 012 — Onda 9, D-113). Tabela cujo dono geral é
 * `channel-settings.repository.ts`; estas 3 colunas são um assunto próprio
 * (SERVICES.md §18), por isso um repositório pequeno e separado.
 */
import type { DbTx } from '../db/types.js';

export interface CommissionSettingsRow {
  commissionBudgetPct: number;
  commissionExamsPct: number;
  commissionCheckupPct: number;
}

/** `null` quando o laboratório nunca gravou `tenant_settings` (D-065, reaproveitada). */
export async function findCommissionSettings(
  tx: DbTx,
  tenantId: string,
): Promise<CommissionSettingsRow | null> {
  const result = await tx.query<{
    commission_budget_pct: string | number;
    commission_exams_pct: string | number;
    commission_checkup_pct: string | number;
  }>(
    `SELECT commission_budget_pct, commission_exams_pct, commission_checkup_pct
       FROM tenant_settings
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    commissionBudgetPct: Number(row.commission_budget_pct),
    commissionExamsPct: Number(row.commission_exams_pct),
    commissionCheckupPct: Number(row.commission_checkup_pct),
  };
}

/**
 * `INSERT ... ON CONFLICT (tenant_id) DO UPDATE`, mesmo padrão de upsert de
 * `tenant_settings` usado por `upsertSettings` (channel-settings.repository.ts).
 * As demais colunas de `tenant_settings` ficam com o `DEFAULT` da tabela
 * quando a linha ainda não existe — mesma disciplina de D-065.
 */
export async function upsertCommissionSettings(
  tx: DbTx,
  tenantId: string,
  settings: CommissionSettingsRow,
): Promise<void> {
  await tx.query(
    `INSERT INTO tenant_settings (tenant_id, commission_budget_pct, commission_exams_pct, commission_checkup_pct)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id)
     DO UPDATE SET commission_budget_pct = $2,
                   commission_exams_pct = $3,
                   commission_checkup_pct = $4`,
    [
      tenantId,
      settings.commissionBudgetPct,
      settings.commissionExamsPct,
      settings.commissionCheckupPct,
    ],
  );
}
