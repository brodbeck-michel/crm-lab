/**
 * Curva ABC dos medicos (SCHEMA.md §51 — CRMLAB-188, D-328 item 9; base pelo LIS desde a D-336). So SQL;
 * o Pareto e do `DoctorAbcService` (`classifyAbc` de `@crm-lab/shared`).
 *
 * `listTenantsWithDoctors` e a UNICA funcao chamada com `withoutTenant()`
 * (agendador, excecao listada em SCHEMA.md "RLS"): devolve so `tenant_id`.
 * O resto recebe o `tx` de um `withTenant()`.
 */
import type { DoctorAbcClass } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';
import { DOCTOR_MATCH, doctorOfRequisitionCte } from './lis-doctor-revenue.repository.js';

export async function listTenantsWithDoctors(tx: DbTx): Promise<string[]> {
  const result = await tx.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM doctors ORDER BY tenant_id',
  );
  return result.rows.map((row) => row.tenant_id);
}

/**
 * Base de cada medico do tenant (D-336 item 7, substitui a do D-328 item 9): o RECEBIDO no LIS
 * desde `windowStart` — `paid_value` da dedupe por requisicao (mesma dos KPIs), `paid_on` na
 * janela — das requisicoes casadas ao cadastro por CRM + UF (`DOCTOR_MATCH`). Medico sem CRM/UF
 * ou sem requisicao paga vem com 0.
 */
export async function computeBases(
  tx: DbTx,
  tenantId: string,
  windowStart: Date,
): Promise<Map<string, number>> {
  const result = await tx.query<{ id: string; base: unknown }>(
    `WITH ${doctorOfRequisitionCte('$1')},
     paid AS (
       SELECT requisition_number, paid_value
         FROM (
           SELECT DISTINCT ON (requisition_number) requisition_number, paid_value, paid_on
             FROM lis_budgets
            WHERE tenant_id = $1 AND requisition_number IS NOT NULL
            ORDER BY requisition_number, paid_value DESC
         ) r
        WHERE paid_on >= $2::date AND COALESCE(paid_value, 0) > 0
     )
     SELECT d.id, COALESCE(SUM(paid.paid_value), 0) AS base
       FROM doctors d
       LEFT JOIN doc ON ${DOCTOR_MATCH}
       LEFT JOIN paid ON paid.requisition_number = doc.requisition_number
      WHERE d.tenant_id = $1
      GROUP BY d.id`,
    [tenantId, windowStart.toISOString().slice(0, 10)],
  );
  return new Map(result.rows.map((row) => [row.id, Number(row.base)]));
}

export async function saveClasses(
  tx: DbTx,
  rows: Array<{ id: string; abcClass: DoctorAbcClass; base: number }>,
  calculatedAt: Date,
): Promise<void> {
  if (rows.length === 0) return;
  await tx.query(
    `UPDATE doctors d
        SET abc_class = v.cls, abc_base_value = v.base, abc_calculated_at = $4::timestamptz
       FROM unnest($1::uuid[], $2::text[], $3::numeric[]) AS v(id, cls, base)
      WHERE d.id = v.id`,
    [rows.map((r) => r.id), rows.map((r) => r.abcClass), rows.map((r) => r.base), calculatedAt.toISOString()],
  );
}
