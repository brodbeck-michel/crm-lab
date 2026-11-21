/**
 * Acesso a dados de `doctor_specialties` (SCHEMA.md §51 — CRMLAB-188, D-328).
 * Sem regra de negocio: normalizar o nome, semear a lista e converter
 * duplicidade em erro e papel do `DoctorSpecialtyService`. Tudo com
 * `withTenant()`.
 */
import type { DoctorSpecialty } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

interface SpecialtyRow {
  id: string;
  name: string;
  is_active: boolean;
}

function toSpecialty(row: SpecialtyRow): DoctorSpecialty {
  return { id: row.id, name: row.name, isActive: row.is_active };
}

const COLUMNS = 'id, name, is_active';

export class DoctorSpecialtyRepository {
  constructor(private readonly db: DbClient) {}

  async list(tenantId: string, active?: boolean): Promise<DoctorSpecialty[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<SpecialtyRow>(
        `SELECT ${COLUMNS} FROM doctor_specialties
          WHERE ($1::boolean IS NULL OR is_active = $1::boolean)
          ORDER BY normalized_name, id`,
        [active ?? null],
      );
      return result.rows.map(toSpecialty);
    });
  }

  async count(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ total: number | string }>(
        'SELECT COUNT(*)::int AS total FROM doctor_specialties',
      );
      return Number(result.rows[0]?.total ?? 0);
    });
  }

  /** Insere a lista padrao; nome ja presente fica como esta (idempotente). */
  async seed(tenantId: string, entries: Array<{ name: string; normalizedName: string }>): Promise<void> {
    if (entries.length === 0) return;
    await this.db.withTenant(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO doctor_specialties (tenant_id, name, normalized_name)
         SELECT $1::uuid, e.name, e.normalized_name
           FROM unnest($2::text[], $3::text[]) AS e(name, normalized_name)
         ON CONFLICT (tenant_id, normalized_name) DO NOTHING`,
        [tenantId, entries.map((e) => e.name), entries.map((e) => e.normalizedName)],
      );
    });
  }

  async findById(tenantId: string, id: string): Promise<DoctorSpecialty | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<SpecialtyRow>(
        `SELECT ${COLUMNS} FROM doctor_specialties WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? toSpecialty(row) : null;
    });
  }

  async findByNormalizedName(
    tenantId: string,
    normalizedName: string,
    exceptId?: string,
  ): Promise<DoctorSpecialty | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<SpecialtyRow>(
        `SELECT ${COLUMNS} FROM doctor_specialties
          WHERE normalized_name = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)
          LIMIT 1`,
        [normalizedName, exceptId ?? null],
      );
      const row = result.rows[0];
      return row ? toSpecialty(row) : null;
    });
  }

  async insert(tenantId: string, name: string, normalizedName: string): Promise<DoctorSpecialty> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<SpecialtyRow>(
        `INSERT INTO doctor_specialties (tenant_id, name, normalized_name)
         VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
        [tenantId, name, normalizedName],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em doctor_specialties nao retornou linha');
      return toSpecialty(row);
    });
  }

  /**
   * Atualiza e, se o nome mudou, regrava a coluna ANTIGA `doctors.specialty`
   * dos medicos que usam a especialidade (escrita dupla, D-328 item 1) — na
   * MESMA transacao.
   */
  async update(
    tenantId: string,
    id: string,
    patch: { name?: string; normalizedName?: string; isActive?: boolean },
  ): Promise<DoctorSpecialty | null> {
    return this.db.withTenant(tenantId, async (tx: DbTx) => {
      const result = await tx.query<SpecialtyRow>(
        `UPDATE doctor_specialties
            SET name = COALESCE($2, name),
                normalized_name = COALESCE($3, normalized_name),
                is_active = COALESCE($4::boolean, is_active)
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [id, patch.name ?? null, patch.normalizedName ?? null, patch.isActive ?? null],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (patch.name !== undefined) {
        await tx.query('UPDATE doctors SET specialty = $2 WHERE specialty_id = $1', [id, patch.name]);
      }
      return toSpecialty(row);
    });
  }
}
