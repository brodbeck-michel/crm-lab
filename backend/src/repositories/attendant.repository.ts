/**
 * Acesso a dados de `attendants` (SCHEMA.md §24, D-112). SEM regra de negocio
 * (CONVENTIONS.md "Backend"): quem decide papel/dedupe/conflito e o
 * `AttendantService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento.
 */
import type { Attendant } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { toIso } from './row-mappers.js';

const COLUMNS = `a.id, a.name, a.is_active, a.user_id, u.name AS user_name,
                 a.created_at, a.updated_at`;

interface AttendantRow {
  id: string;
  name: string;
  is_active: boolean;
  user_id: string | null;
  user_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toAttendant(row: AttendantRow): Attendant {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    userId: row.user_id,
    userName: row.user_name,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export interface AttendantListCriteria {
  active?: boolean;
  search?: string;
  page: number;
  limit: number;
}

export interface AttendantPage {
  rows: Attendant[];
  total: number;
}

export interface AttendantInsert {
  name: string;
  userId: string | null;
}

export interface AttendantPatch {
  name?: string;
  userId?: string | null;
  isActive?: boolean;
}

/** SQLSTATE de violacao de unicidade — o service converte para CONFLICT. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION) return true;
  // PGlite embrulha o erro do servidor em `cause` em alguns caminhos.
  return isUniqueViolation(candidate.cause);
}

const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn';

function folded(expression: string): string {
  return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

/** Mesma dobra do SQL, aplicada ao termo de busca antes de virar parametro. */
export function foldSearchTerm(term: string): string {
  let out = '';
  for (const char of term.toLowerCase()) {
    const index = ACCENTED.indexOf(char);
    out += index >= 0 ? PLAIN[index] : char;
  }
  return out;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** `lower` + colapso de espacos — MESMA formula de `attendants.folded_name` (SCHEMA.md §24). */
export function foldName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export class AttendantRepository {
  constructor(private readonly db: DbClient) {}

  async list(tenantId: string, criteria: AttendantListCriteria): Promise<AttendantPage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`a.is_active = $${params.length}`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      where.push(`${folded('a.name')} LIKE $${params.length}::text ESCAPE '\\'`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM attendants a ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<AttendantRow>(
        `SELECT ${COLUMNS}
           FROM attendants a
           LEFT JOIN users u ON u.id = a.user_id
           ${whereSql}
          ORDER BY a.name ASC, a.id ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, criteria.limit, offset],
      );

      return { rows: paged.rows.map(toAttendant), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<Attendant | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, id));
  }

  /** `true` quando o tenant ja tem um atendente com este `folded_name`. */
  async foldedNameExists(tenantId: string, foldedName: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'SELECT id FROM attendants WHERE folded_name = $1 LIMIT 1',
        [foldedName],
      );
      return result.rows.length > 0;
    });
  }

  /** `true` quando este `userId` ja esta ligado a outro atendente no tenant. */
  async userIdLinked(tenantId: string, userId: string, excludeId?: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const params: unknown[] = [userId];
      let sql = 'SELECT id FROM attendants WHERE user_id = $1';
      if (excludeId) {
        params.push(excludeId);
        sql += ` AND id <> $${params.length}`;
      }
      const result = await tx.query<{ id: string }>(`${sql} LIMIT 1`, params);
      return result.rows.length > 0;
    });
  }

  async insert(tenantId: string, data: AttendantInsert): Promise<Attendant> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO attendants (tenant_id, name, user_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         RETURNING id`,
        [tenantId, data.name, data.userId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em attendants nao retornou linha');
      const attendant = await selectOne(tx, row.id);
      if (!attendant) throw new Error('Atendente recem-criado nao encontrado apos INSERT');
      return attendant;
    });
  }

  async update(tenantId: string, id: string, patch: AttendantPatch): Promise<Attendant | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    if (patch.name !== undefined) {
      params.push(patch.name);
      assignments.push(`name = $${params.length}`);
    }
    if (patch.userId !== undefined) {
      params.push(patch.userId);
      assignments.push(`user_id = $${params.length}`);
    }
    if (patch.isActive !== undefined) {
      params.push(patch.isActive);
      assignments.push(`is_active = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, id);
      params.push(id);
      const result = await tx.query<{ id: string }>(
        `UPDATE attendants SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING id`,
        params,
      );
      const row = result.rows[0];
      if (!row) return null;
      return selectOne(tx, row.id);
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Attendant | null> {
  const result = await tx.query<AttendantRow>(
    `SELECT ${COLUMNS}
       FROM attendants a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toAttendant(row) : null;
}

/**
 * Resolucao de atendente por `folded_name` (BUSINESS_RULES.md §11.6) — usada
 * pelo `LisImportService` DENTRO da transacao de um chunk. Sem casar, devolve
 * `null` (NUNCA cria atendente automaticamente).
 */
export async function findAttendantIdByFoldedName(
  tx: DbTx,
  tenantId: string,
  name: string,
): Promise<string | null> {
  const folded = foldName(name);
  if (folded === '') return null;
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM attendants WHERE tenant_id = $1 AND folded_name = $2 LIMIT 1',
    [tenantId, folded],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Vínculo `attendants.user_id = ctx.userId` (D-112) — usado por `SalesService`
 * para resolver o atendente do login antes de tocar `sales`. `null` quando o
 * login não está ligado a nenhuma linha de `attendants`.
 */
export async function findAttendantIdByUserId(
  tx: DbTx,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const result = await tx.query<{ id: string }>(
    'SELECT id FROM attendants WHERE tenant_id = $1 AND user_id = $2 LIMIT 1',
    [tenantId, userId],
  );
  return result.rows[0]?.id ?? null;
}
