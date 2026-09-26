/**
 * Acesso a `funnel_rules` (SCHEMA.md §32 — CRMLAB-56, D-190). Uma linha por
 * tenant, `rules` JSONB. Quem interpreta o JSON (merge com os padroes,
 * validacao) e o `funnel-rules.service.ts` — ninguem mais le esta tabela.
 */
import type { DbTx } from '../db/types.js';

/** O JSON cru gravado, ou `null` quando o laboratorio nunca salvou (padroes). */
export async function findStoredRules(tx: DbTx, tenantId: string): Promise<unknown> {
  const result = await tx.query<{ rules: unknown }>(
    'SELECT rules FROM funnel_rules WHERE tenant_id = $1',
    [tenantId],
  );
  const raw = result.rows[0]?.rules ?? null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function upsertRules(
  tx: DbTx,
  tenantId: string,
  rules: unknown,
  updatedBy: string,
): Promise<void> {
  await tx.query(
    `INSERT INTO funnel_rules (tenant_id, rules, updated_by)
          VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (tenant_id)
     DO UPDATE SET rules = $2::jsonb, updated_by = $3`,
    [tenantId, JSON.stringify(rules), updatedBy],
  );
}
