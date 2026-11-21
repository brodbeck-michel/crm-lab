/**
 * Acesso a dados de `doctors` (SCHEMA.md §35 — CRMLAB-86, D-255). SEM regra de
 * negocio (CONVENTIONS.md "Backend"): normalizar CRM, validar o responsavel e
 * converter duplicidade em erro e papel do `DoctorService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: medico e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import { VISITATION_RESPONSIBLE_ROLES, type Doctor, type DoctorSortBy, type TenantRole } from '@crm-lab/shared';
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
  /** Sem responsavel, de perfil inelegivel ou inativo (D-329). */
  unassigned?: boolean;
  /** Escopo do representante (D-329): so a carteira dele. Ausente = sem recorte. */
  ownerId?: string;
  page: number;
  limit: number;
  sortBy: DoctorSortBy;
  order: SortOrder;
}

/** Perfis elegiveis como literal SQL (whitelist fixa, nada vindo do cliente). */
const ELIGIBLE_ROLES_SQL = `(${VISITATION_RESPONSIBLE_ROLES.map((role) => `'${role}'`).join(', ')})`;

/**
 * Medico "sem responsavel" para o gestor (D-329 item 6): nulo, usuario sumido,
 * inativo ou de perfil inelegivel. Exige o `LEFT JOIN users u`.
 */
const UNASSIGNED_SQL = `(d.responsible_user_id IS NULL OR u.id IS NULL OR u.is_active = FALSE
  OR u.role NOT IN ${ELIGIBLE_ROLES_SQL})`;

/** Linha da carteira, como sai do SQL. */
export interface PortfolioRow {
  responsible: { id: string; name: string; role: TenantRole };
  doctorCount: number;
  activeDoctorCount: number;
}

export interface PortfolioCounts {
  doctorCount: number;
  activeDoctorCount: number;
}

/** Resultado da transferencia: o que mudou, para o audit do service. */
export interface DoctorTransferResult {
  /** Medicos que de fato mudaram de responsavel (o que ja era do destino fica fora). */
  doctors: Array<{ id: string; previousResponsibleId: string | null; movedVisitIds: string[] }>;
  /** Visitas levadas junto, com o responsavel anterior. */
  visits: Array<{ id: string; doctorId: string; previousResponsibleId: string }>;
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
    if (criteria.ownerId !== undefined) {
      params.push(criteria.ownerId);
      where.push(`d.responsible_user_id = $${params.length}`);
    }
    if (criteria.unassigned === true) {
      where.push(UNASSIGNED_SQL);
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
        `SELECT COUNT(*)::int AS total ${FROM} ${whereSql}`,
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

  /** `ownerId` (D-329): medico de outra carteira nao existe para o representante (`null` -> 404). */
  async findById(tenantId: string, id: string, ownerId?: string): Promise<Doctor | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const doctor = await selectOne(tx, id);
      if (doctor && ownerId !== undefined && doctor.responsible?.id !== ownerId) return null;
      return doctor;
    });
  }

  /**
   * Carteiras (D-329 item 7): uma linha por usuario ATIVO de perfil elegivel que
   * e representante ou tem medico; o resto (sem responsavel, inelegivel, inativo)
   * soma em `unassigned`. Cada medico conta uma vez.
   */
  async portfolios(tenantId: string): Promise<{ rows: PortfolioRow[]; unassigned: PortfolioCounts }> {
    return this.db.withTenant(tenantId, async (tx) => {
      const rows = await tx.query<{
        id: string;
        name: string;
        role: TenantRole;
        doctor_count: number | string;
        active_doctor_count: number | string;
      }>(
        `SELECT u.id, u.name, u.role,
                COUNT(d.id)::int AS doctor_count,
                COUNT(d.id) FILTER (WHERE d.is_active)::int AS active_doctor_count
           FROM users u
           LEFT JOIN doctors d ON d.responsible_user_id = u.id
          WHERE u.tenant_id = $1
            AND u.is_active = TRUE
            AND u.role IN ${ELIGIBLE_ROLES_SQL}
          GROUP BY u.id, u.name, u.role
         HAVING u.role = 'representative' OR COUNT(d.id) > 0
          ORDER BY u.name ASC, u.id ASC`,
        [tenantId],
      );
      const unassigned = await tx.query<{ doctor_count: number | string; active_doctor_count: number | string }>(
        `SELECT COUNT(*)::int AS doctor_count,
                COUNT(*) FILTER (WHERE d.is_active)::int AS active_doctor_count
           ${FROM}
          WHERE ${UNASSIGNED_SQL}`,
      );
      const counts = unassigned.rows[0];
      return {
        rows: rows.rows.map((row) => ({
          responsible: { id: row.id, name: row.name, role: row.role },
          doctorCount: Number(row.doctor_count),
          activeDoctorCount: Number(row.active_doctor_count),
        })),
        unassigned: {
          doctorCount: Number(counts?.doctor_count ?? 0),
          activeDoctorCount: Number(counts?.active_doctor_count ?? 0),
        },
      };
    });
  }

  /**
   * Transferencia em lote (D-329 item 8), tudo numa transacao com os medicos
   * travados. Devolve `null` se algum id nao existe NESTE tenant (nada muda).
   * Com `includeFutureVisits`, leva as visitas `agendada` futuras de cada medico
   * que estavam com o responsavel anterior dele (cobertura de outra pessoa fica).
   */
  async transfer(
    tenantId: string,
    doctorIds: string[],
    toUserId: string,
    includeFutureVisits: boolean,
    now: Date,
  ): Promise<DoctorTransferResult | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const locked = await tx.query<{ id: string; responsible_user_id: string | null }>(
        `SELECT id, responsible_user_id FROM doctors WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [doctorIds],
      );
      if (locked.rows.length !== doctorIds.length) return null;

      const result: DoctorTransferResult = { doctors: [], visits: [] };
      for (const row of locked.rows) {
        if (row.responsible_user_id === toUserId) continue;
        await tx.query('UPDATE doctors SET responsible_user_id = $1 WHERE id = $2', [toUserId, row.id]);

        const movedVisitIds: string[] = [];
        if (includeFutureVisits && row.responsible_user_id !== null) {
          const moved = await tx.query<{ id: string }>(
            `UPDATE doctor_visits SET responsible_user_id = $1
              WHERE doctor_id = $2 AND responsible_user_id = $3
                AND status = 'agendada' AND scheduled_at > $4::timestamptz
             RETURNING id`,
            [toUserId, row.id, row.responsible_user_id, now.toISOString()],
          );
          for (const visit of moved.rows) {
            movedVisitIds.push(visit.id);
            result.visits.push({ id: visit.id, doctorId: row.id, previousResponsibleId: row.responsible_user_id });
          }
        }
        result.doctors.push({ id: row.id, previousResponsibleId: row.responsible_user_id, movedVisitIds });
      }
      return result;
    });
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
