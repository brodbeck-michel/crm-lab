/**
 * Acesso a dados de `visit_purposes` (SCHEMA.md §36a — CRMLAB-190, D-330).
 * SEM regra de negocio (CONVENTIONS.md "Backend"): quem pode escrever, nome
 * repetido e o audit sao do `VisitPurposeService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md) — e ainda filtra `tenant_id` explicito (mesmo padrao de
 * `VisitRepository.findTenantDoctor`).
 */
import type { VisitPurpose, VisitPurposeColor } from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import { isUniqueViolation } from './quick-reply.repository.js';

export { isUniqueViolation };

const COLUMNS = 'id, name, color, is_active, sort_order, created_at, updated_at';

interface PurposeRow {
  id: string;
  name: string;
  color: VisitPurposeColor;
  is_active: boolean;
  sort_order: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toPurpose(row: PurposeRow): VisitPurpose {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    isActive: row.is_active,
    sortOrder: Number(row.sort_order),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface VisitPurposePatch {
  name?: string;
  color?: VisitPurposeColor;
  isActive?: boolean;
  sortOrder?: number;
}

/** Campo -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof VisitPurposePatch, string> = {
  name: 'name',
  color: 'color',
  isActive: 'is_active',
  sortOrder: 'sort_order',
};

export class VisitPurposeRepository {
  constructor(private readonly db: DbClient) {}

  async list(tenantId: string): Promise<VisitPurpose[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<PurposeRow>(
        `SELECT ${COLUMNS} FROM visit_purposes WHERE tenant_id = $1
          ORDER BY sort_order ASC, lower(name) ASC, id ASC`,
        [tenantId],
      );
      return result.rows.map(toPurpose);
    });
  }

  async findById(tenantId: string, id: string): Promise<VisitPurpose | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<PurposeRow>(
        `SELECT ${COLUMNS} FROM visit_purposes WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId],
      );
      const row = result.rows[0];
      return row ? toPurpose(row) : null;
    });
  }

  /** Nasce ativa, no fim da ordem (maior `sort_order` + 1). */
  async insert(
    tenantId: string,
    createdBy: string | null,
    data: { name: string; color: VisitPurposeColor },
  ): Promise<VisitPurpose> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<PurposeRow>(
        `INSERT INTO visit_purposes (tenant_id, name, color, sort_order, created_by)
         VALUES ($1, $2, $3,
                 (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM visit_purposes WHERE tenant_id = $1),
                 $4)
         RETURNING ${COLUMNS}`,
        [tenantId, data.name, data.color, createdBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em visit_purposes nao retornou linha');
      return toPurpose(row);
    });
  }

  /** `null` = inexistente neste tenant. */
  async update(tenantId: string, id: string, patch: VisitPurposePatch): Promise<VisitPurpose | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof VisitPurposePatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }
    if (assignments.length === 0) return this.findById(tenantId, id);

    return this.db.withTenant(tenantId, async (tx) => {
      params.push(id, tenantId);
      const result = await tx.query<PurposeRow>(
        `UPDATE visit_purposes SET ${assignments.join(', ')}
          WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
          RETURNING ${COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row ? toPurpose(row) : null;
    });
  }
}
