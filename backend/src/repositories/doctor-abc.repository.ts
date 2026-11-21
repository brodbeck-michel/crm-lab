/**
 * Curva ABC dos medicos (SCHEMA.md §51 — CRMLAB-188, D-328 item 9). So SQL;
 * o Pareto e do `DoctorAbcService` (`classifyAbc` de `@crm-lab/shared`).
 *
 * `listTenantsWithDoctors` e a UNICA funcao chamada com `withoutTenant()`
 * (agendador, excecao listada em SCHEMA.md "RLS"): devolve so `tenant_id`.
 * O resto recebe o `tx` de um `withTenant()`.
 */
import type { DoctorAbcClass } from '@crm-lab/shared';
import type { DbTx } from '../db/types.js';

export async function listTenantsWithDoctors(tx: DbTx): Promise<string[]> {
  const result = await tx.query<{ tenant_id: string }>(
    'SELECT DISTINCT tenant_id FROM doctors ORDER BY tenant_id',
  );
  return result.rows.map((row) => row.tenant_id);
}

/**
 * Base de cada medico do tenant: soma de `total_price` das propostas `ganho`
 * fechadas desde `windowStart`. Medico sem venda vem com 0.
 * `closed_at` e `TIMESTAMP` (sem fuso) gravado em UTC: o ISO com `Z` vira o
 * mesmo relogio UTC no cast.
 */
export async function computeBases(tx: DbTx, windowStart: Date): Promise<Map<string, number>> {
  const result = await tx.query<{ id: string; base: unknown }>(
    `SELECT d.id, COALESCE(SUM(p.total_price), 0) AS base
       FROM doctors d
       LEFT JOIN proposals p
         ON p.doctor_id = d.id
        AND p.tenant_id = d.tenant_id
        AND p.status = 'ganho'
        AND p.closed_at >= $1::timestamp
      GROUP BY d.id`,
    [windowStart.toISOString()],
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
