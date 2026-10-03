/**
 * Acesso a dados de `doctors` (SCHEMA.md §35 — CRMLAB-86, D-255). SEM regra de
 * negocio (CONVENTIONS.md "Backend"): normalizar CRM, validar o responsavel e
 * converter duplicidade em erro e papel do `DoctorService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: medico e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import type { Doctor, DoctorSortBy } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';
import { escapeLike, foldSearchTerm } from './insurance.repository.js';

export { isUniqueViolation } from './insurance.repository.js';

/** Colunas ordenaveis expostas na query string -> coluna real (whitelist). */
const SORTABLE_COLUMNS: Record<DoctorSortBy, string> = {
  name: 'd.name',
  createdAt: 'd.created_at',
  updatedAt: 'd.updated_at',
};

export type SortOrder = 'asc' | 'desc';

export function isDoctorSortBy(value: string): value is DoctorSortBy {
  return Object.prototype.hasOwnProperty.call(SORTABLE_COLUMNS, value);
}

/** Mesma dobra de acentos de `insurance.repository.ts` (sem `unaccent`, que o PGlite nao tem). */
const ACCENTED = 'áàâãäéèêëíìîïóòôõöúùûüçñ';
const PLAIN = 'aaaaaeeeeiiiiooooouuuucn';

function folded(expression: string): string {
  return `translate(lower(${expression}), '${ACCENTED}', '${PLAIN}')`;
}

/** `u.name` vem do LEFT JOIN: o responsavel e exibido pelo nome. */
const COLUMNS = `d.id, d.name, d.crm, d.crm_uf, d.specialty, d.clinic, d.address, d.phone,
  d.email, d.contact_name, d.visit_preference, d.notes, d.responsible_user_id,
  u.name AS responsible_name, d.is_active, d.created_at, d.updated_at`;

const FROM = `FROM doctors d LEFT JOIN users u ON u.id = d.responsible_user_id`;

interface DoctorRow {
  id: string;
  name: string;
  crm: string | null;
  crm_uf: string | null;
  specialty: string | null;
  clinic: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  contact_name: string | null;
  visit_preference: string | null;
  notes: string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  is_active: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toDoctor(row: DoctorRow): Doctor {
  return {
    id: row.id,
    name: row.name,
    crm: row.crm,
    crmUf: row.crm_uf,
    specialty: row.specialty,
    clinic: row.clinic,
    address: row.address,
    phone: row.phone,
    email: row.email,
    contactName: row.contact_name,
    visitPreference: row.visit_preference,
    notes: row.notes,
    responsible:
      row.responsible_user_id !== null
        ? { id: row.responsible_user_id, name: row.responsible_name ?? '' }
        : null,
    isActive: row.is_active,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
}

export interface DoctorListCriteria {
  search?: string;
  active?: boolean;
  responsibleId?: string;
  page: number;
  limit: number;
  sortBy: DoctorSortBy;
  order: SortOrder;
}

export interface DoctorPage {
  rows: Doctor[];
  total: number;
}

/** Campos gravaveis — ja normalizados pelo service. */
export interface DoctorFields {
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialty: string | null;
  clinic: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  visitPreference: string | null;
  notes: string | null;
  responsibleId: string | null;
}

export type DoctorPatch = Partial<DoctorFields> & { isActive?: boolean };

/** Campo -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof DoctorPatch, string> = {
  name: 'name',
  crm: 'crm',
  crmUf: 'crm_uf',
  specialty: 'specialty',
  clinic: 'clinic',
  address: 'address',
  phone: 'phone',
  email: 'email',
  contactName: 'contact_name',
  visitPreference: 'visit_preference',
  notes: 'notes',
  responsibleId: 'responsible_user_id',
  isActive: 'is_active',
};

/** Usuario do laboratorio que pode ser responsavel pela carteira. */
export interface TenantUserRef {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

export class DoctorRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina de medicos + o total que casa com os MESMOS filtros. O `WHERE`
   * e montado uma vez e reaproveitado pelo COUNT.
   */
  async list(tenantId: string, criteria: DoctorListCriteria): Promise<DoctorPage> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (criteria.active !== undefined) {
      params.push(criteria.active);
      where.push(`d.is_active = $${params.length}`);
    }
    if (criteria.responsibleId !== undefined) {
      params.push(criteria.responsibleId);
      where.push(`d.responsible_user_id = $${params.length}`);
    }
    if (criteria.search !== undefined && criteria.search.length > 0) {
      params.push(`%${escapeLike(foldSearchTerm(criteria.search))}%`);
      const conditions = [`${folded('d.name')} LIKE $${params.length}::text ESCAPE '\\'`];
      // "CRM 12.345" acha pelo numero: o CRM e guardado so com digitos.
      const digits = criteria.search.replace(/\D/g, '');
      if (digits.length > 0) {
        params.push(`%${digits}%`);
        conditions.push(`d.crm LIKE $${params.length}::text`);
      }
      where.push(`(${conditions.join(' OR ')})`);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const direction = criteria.order === 'desc' ? 'DESC' : 'ASC';
    // `id` como desempate: sem ele a paginacao pode repetir/pular linhas.
    const orderSql = `ORDER BY ${SORTABLE_COLUMNS[criteria.sortBy]} ${direction}, d.id ASC`;

    return this.db.withTenant(tenantId, async (tx) => {
      const counted = await tx.query<{ total: number | string }>(
        `SELECT COUNT(*)::int AS total FROM doctors d ${whereSql}`,
        params,
      );
      const total = Number(counted.rows[0]?.total ?? 0);

      const offset = (criteria.page - 1) * criteria.limit;
      const paged = await tx.query<DoctorRow>(
        `SELECT ${COLUMNS} ${FROM} ${whereSql} ${orderSql}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, criteria.limit, offset],
      );

      return { rows: paged.rows.map(toDoctor), total };
    });
  }

  async findById(tenantId: string, id: string): Promise<Doctor | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, id));
  }

  /** O medico que ja usa este (CRM, UF) no tenant, se houver — menos `exceptId`. */
  async findByCrm(
    tenantId: string,
    crm: string,
    crmUf: string,
    exceptId?: string,
  ): Promise<{ id: string; name: string; isActive: boolean } | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string; name: string; is_active: boolean }>(
        `SELECT id, name, is_active FROM doctors
         WHERE crm = $1 AND crm_uf = $2 AND ($3::uuid IS NULL OR id <> $3::uuid)
         LIMIT 1`,
        [crm, crmUf, exceptId ?? null],
      );
      const row = result.rows[0];
      return row ? { id: row.id, name: row.name, isActive: row.is_active } : null;
    });
  }

  /**
   * Usuario do PROPRIO tenant. O filtro explicito por `tenant_id` e redundante
   * com o RLS de `users`, de proposito: o responsavel nunca pode ser de outro
   * laboratorio, nem se a policy um dia mudar.
   */
  async findTenantUser(tenantId: string, userId: string): Promise<TenantUserRef | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string; name: string; role: string; is_active: boolean }>(
        'SELECT id, name, role, is_active FROM users WHERE id = $1 AND tenant_id = $2',
        [userId, tenantId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, name: row.name, role: row.role, isActive: row.is_active } : null;
    });
  }

  async insert(tenantId: string, createdBy: string | null, data: DoctorFields): Promise<Doctor> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO doctors (tenant_id, name, crm, crm_uf, specialty, clinic, address, phone,
                              email, contact_name, visit_preference, notes, responsible_user_id,
                              created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          tenantId,
          data.name,
          data.crm,
          data.crmUf,
          data.specialty,
          data.clinic,
          data.address,
          data.phone,
          data.email,
          data.contactName,
          data.visitPreference,
          data.notes,
          data.responsibleId,
          createdBy,
        ],
      );
      const id = result.rows[0]?.id;
      const created = id ? await selectOne(tx, id) : null;
      if (!created) throw new Error('INSERT em doctors nao retornou linha');
      return created;
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8). `updated_at` fica com
   * o trigger `trg_doctors_updated_at`.
   */
  async update(tenantId: string, id: string, patch: DoctorPatch): Promise<Doctor | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof DoctorPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, id);
      params.push(id);
      const result = await tx.query<{ id: string }>(
        `UPDATE doctors SET ${assignments.join(', ')}
         WHERE id = $${params.length}
         RETURNING id`,
        params,
      );
      return result.rows[0] ? selectOne(tx, id) : null;
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<Doctor | null> {
  const result = await tx.query<DoctorRow>(`SELECT ${COLUMNS} ${FROM} WHERE d.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toDoctor(row) : null;
}
