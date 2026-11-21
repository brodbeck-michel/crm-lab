/**
 * Acesso a dados de `doctors` (SCHEMA.md §35 e §51 — CRMLAB-86/D-255,
 * CRMLAB-188/D-328). SEM regra de negocio (CONVENTIONS.md "Backend"):
 * normalizar CRM, validar o responsavel e converter duplicidade em erro e
 * papel do `DoctorService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: medico e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import type { Doctor, DoctorAbcClass, DoctorSortBy, DoctorVisitHours, Weekday } from '@crm-lab/shared';
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

/**
 * `u.name` vem do LEFT JOIN: o responsavel e exibido pelo nome. A
 * especialidade e o nome da LISTA; sem `specialty_id`, o texto antigo.
 */
const COLUMNS = `d.id, d.name, d.crm, d.crm_uf, d.specialty_id,
  COALESCE(s.name, d.specialty) AS specialty_name,
  d.birth_day, d.birth_month, d.birth_year, d.clinic, d.accepts_private,
  d.monthly_consultations, d.monthly_private_consultations, d.consultation_fee,
  d.visit_hours, d.visit_preference, d.is_partner,
  to_char(d.partner_since, 'YYYY-MM-DD') AS partner_since, d.partnership_notes,
  d.address_zip, d.address_street, d.address_number, d.address_complement,
  d.address_district, d.address_city, d.address_state, d.address, d.phone, d.email,
  d.secretary_name, d.secretary_birth_day, d.secretary_birth_month, d.secretary_birth_year,
  d.secretary_phone, d.secretary_notes, d.contact_name, d.notes,
  d.abc_class, d.abc_base_value, d.abc_calculated_at,
  d.responsible_user_id, u.name AS responsible_name, d.is_active, d.created_at, d.updated_at`;

const FROM = `FROM doctors d
  LEFT JOIN users u ON u.id = d.responsible_user_id
  LEFT JOIN doctor_specialties s ON s.id = d.specialty_id`;

interface DoctorRow {
  id: string;
  name: string;
  crm: string | null;
  crm_uf: string | null;
  specialty_id: string | null;
  specialty_name: string | null;
  birth_day: number | null;
  birth_month: number | null;
  birth_year: number | null;
  clinic: string | null;
  accepts_private: boolean | null;
  monthly_consultations: number | null;
  monthly_private_consultations: number | null;
  consultation_fee: unknown;
  visit_hours: unknown;
  visit_preference: string | null;
  is_partner: boolean;
  partner_since: string | null;
  partnership_notes: string | null;
  address_zip: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  secretary_name: string | null;
  secretary_birth_day: number | null;
  secretary_birth_month: number | null;
  secretary_birth_year: number | null;
  secretary_phone: string | null;
  secretary_notes: string | null;
  contact_name: string | null;
  notes: string | null;
  abc_class: string | null;
  abc_base_value: unknown;
  abc_calculated_at: Date | string | null;
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

/** NUMERIC chega como string do driver; dinheiro no fio e numero (regra 9). */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value: unknown): number | null {
  const n = toNumberOrNull(value);
  return n === null ? null : Math.trunc(n);
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

/** JSONB ja validado na escrita; aqui so o narrowing (nada de `any`). */
function parseVisitHours(value: unknown): DoctorVisitHours[] {
  const raw: unknown = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(raw)) return [];
  const result: DoctorVisitHours[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { weekdays?: unknown; start?: unknown; end?: unknown };
    if (!Array.isArray(candidate.weekdays)) continue;
    if (typeof candidate.start !== 'string' || typeof candidate.end !== 'string') continue;
    result.push({
      weekdays: (candidate.weekdays as unknown[]).filter(isWeekday),
      start: candidate.start,
      end: candidate.end,
    });
  }
  return result;
}

function toAbcClass(value: string | null): DoctorAbcClass | null {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}

export function toDoctor(row: DoctorRow): Doctor {
  return {
    id: row.id,
    name: row.name,
    crm: row.crm,
    crmUf: row.crm_uf,
    specialtyId: row.specialty_id,
    specialty: row.specialty_name,
    birthDay: toIntOrNull(row.birth_day),
    birthMonth: toIntOrNull(row.birth_month),
    birthYear: toIntOrNull(row.birth_year),
    clinic: row.clinic,
    acceptsPrivate: row.accepts_private,
    monthlyConsultations: toIntOrNull(row.monthly_consultations),
    monthlyPrivateConsultations: toIntOrNull(row.monthly_private_consultations),
    consultationFee: toNumberOrNull(row.consultation_fee),
    visitHours: parseVisitHours(row.visit_hours),
    visitPreference: row.visit_preference,
    isPartner: row.is_partner,
    partnerSince: row.partner_since,
    partnershipNotes: row.partnership_notes,
    addressZip: row.address_zip,
    addressStreet: row.address_street,
    addressNumber: row.address_number,
    addressComplement: row.address_complement,
    addressDistrict: row.address_district,
    addressCity: row.address_city,
    addressState: row.address_state,
    address: row.address,
    phone: row.phone,
    email: row.email,
    secretaryName: row.secretary_name,
    secretaryBirthDay: toIntOrNull(row.secretary_birth_day),
    secretaryBirthMonth: toIntOrNull(row.secretary_birth_month),
    secretaryBirthYear: toIntOrNull(row.secretary_birth_year),
    secretaryPhone: row.secretary_phone,
    secretaryNotes: row.secretary_notes,
    contactName: row.contact_name,
    notes: row.notes,
    abcClass: toAbcClass(row.abc_class),
    abcBaseValue: toNumberOrNull(row.abc_base_value),
    abcCalculatedAt: row.abc_calculated_at === null ? null : isoDateTime(row.abc_calculated_at),
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
  specialtyId?: string;
  abcClass?: DoctorAbcClass;
  page: number;
  limit: number;
  sortBy: DoctorSortBy;
  order: SortOrder;
}

export interface DoctorPage {
  rows: Doctor[];
  total: number;
}

/**
 * Campos gravaveis — ja normalizados pelo service. `specialty` e
 * `contactName` sao as colunas ANTIGAS, escritas em dobro (D-328 itens 1 e 8).
 */
export interface DoctorFields {
  name: string;
  crm: string | null;
  crmUf: string | null;
  specialtyId: string | null;
  specialty: string | null;
  birthDay: number | null;
  birthMonth: number | null;
  birthYear: number | null;
  clinic: string | null;
  acceptsPrivate: boolean | null;
  monthlyConsultations: number | null;
  monthlyPrivateConsultations: number | null;
  consultationFee: number | null;
  visitHours: DoctorVisitHours[];
  visitPreference: string | null;
  isPartner: boolean;
  partnerSince: string | null;
  partnershipNotes: string | null;
  addressZip: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressComplement: string | null;
  addressDistrict: string | null;
  addressCity: string | null;
  addressState: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  secretaryName: string | null;
  secretaryBirthDay: number | null;
  secretaryBirthMonth: number | null;
  secretaryBirthYear: number | null;
  secretaryPhone: string | null;
  secretaryNotes: string | null;
  contactName: string | null;
  notes: string | null;
  responsibleId: string | null;
}

export type DoctorPatch = Partial<DoctorFields> & { isActive?: boolean };

/** Campo -> coluna fisica (e cast, quando o driver precisa). Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof DoctorPatch, { column: string; cast?: string }> = {
  name: { column: 'name' },
  crm: { column: 'crm' },
  crmUf: { column: 'crm_uf' },
  specialtyId: { column: 'specialty_id', cast: 'uuid' },
  specialty: { column: 'specialty' },
  birthDay: { column: 'birth_day', cast: 'smallint' },
  birthMonth: { column: 'birth_month', cast: 'smallint' },
  birthYear: { column: 'birth_year', cast: 'smallint' },
  clinic: { column: 'clinic' },
  acceptsPrivate: { column: 'accepts_private', cast: 'boolean' },
  monthlyConsultations: { column: 'monthly_consultations', cast: 'integer' },
  monthlyPrivateConsultations: { column: 'monthly_private_consultations', cast: 'integer' },
  consultationFee: { column: 'consultation_fee', cast: 'numeric' },
  visitHours: { column: 'visit_hours', cast: 'jsonb' },
  visitPreference: { column: 'visit_preference' },
  isPartner: { column: 'is_partner', cast: 'boolean' },
  partnerSince: { column: 'partner_since', cast: 'date' },
  partnershipNotes: { column: 'partnership_notes' },
  addressZip: { column: 'address_zip' },
  addressStreet: { column: 'address_street' },
  addressNumber: { column: 'address_number' },
  addressComplement: { column: 'address_complement' },
  addressDistrict: { column: 'address_district' },
  addressCity: { column: 'address_city' },
  addressState: { column: 'address_state' },
  address: { column: 'address' },
  phone: { column: 'phone' },
  email: { column: 'email' },
  secretaryName: { column: 'secretary_name' },
  secretaryBirthDay: { column: 'secretary_birth_day', cast: 'smallint' },
  secretaryBirthMonth: { column: 'secretary_birth_month', cast: 'smallint' },
  secretaryBirthYear: { column: 'secretary_birth_year', cast: 'smallint' },
  secretaryPhone: { column: 'secretary_phone' },
  secretaryNotes: { column: 'secretary_notes' },
  contactName: { column: 'contact_name' },
  notes: { column: 'notes' },
  responsibleId: { column: 'responsible_user_id', cast: 'uuid' },
  isActive: { column: 'is_active', cast: 'boolean' },
};

/** Valor no formato do driver: JSONB vai serializado. */
function toParam(key: keyof DoctorPatch, value: unknown): unknown {
  return key === 'visitHours' ? JSON.stringify(value) : value;
}

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
    if (criteria.specialtyId !== undefined) {
      params.push(criteria.specialtyId);
      where.push(`d.specialty_id = $${params.length}`);
    }
    if (criteria.abcClass !== undefined) {
      params.push(criteria.abcClass);
      where.push(`d.abc_class = $${params.length}`);
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
    const keys = Object.keys(PATCH_COLUMNS).filter(
      (key): key is keyof DoctorFields => key !== 'isActive',
    );
    const columns = keys.map((key) => PATCH_COLUMNS[key].column);
    const params: unknown[] = [tenantId, createdBy];
    const placeholders = keys.map((key) => {
      params.push(toParam(key, data[key]));
      const cast = PATCH_COLUMNS[key].cast;
      return cast ? `$${params.length}::${cast}` : `$${params.length}`;
    });

    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO doctors (tenant_id, created_by, ${columns.join(', ')})
         VALUES ($1, $2, ${placeholders.join(', ')})
         RETURNING id`,
        params,
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
      params.push(toParam(key, value));
      const { column, cast } = PATCH_COLUMNS[key];
      assignments.push(`${column} = $${params.length}${cast ? `::${cast}` : ''}`);
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
