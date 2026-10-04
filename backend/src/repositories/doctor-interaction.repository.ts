/**
 * Acesso a dados de `doctor_interactions` (SCHEMA.md §38 — CRMLAB-89, D-261)
 * e a leitura da linha do tempo do medico, que junta essa tabela com
 * `doctor_visits` (§36/§37). SEM regra de negocio (CONVENTIONS.md "Backend"):
 * validar data/descricao, o cursor e o audit sao do `DoctorInteractionService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`.
 */
import type {
  DoctorInteraction,
  DoctorInteractionType,
  DoctorTimelineInteraction,
  DoctorTimelineItem,
  DoctorTimelineVisit,
  VisitPerson,
  VisitStatus,
  VisitType,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

const COLUMNS = `i.id, i.doctor_id, i.type, i.occurred_at, i.description,
  i.created_by, cu.name AS created_by_name, i.updated_by, uu.name AS updated_by_name,
  i.created_at, i.updated_at`;

const FROM = `FROM doctor_interactions i
  LEFT JOIN users cu ON cu.id = i.created_by
  LEFT JOIN users uu ON uu.id = i.updated_by`;

interface InteractionRow {
  id: string;
  doctor_id: string;
  type: DoctorInteractionType;
  occurred_at: Date | string;
  description: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Uma linha da linha do tempo: visita OU registro manual. As colunas que nao
 * existem no outro lado vem `NULL` no `UNION ALL`.
 */
interface TimelineRow {
  kind: 'visit' | 'interaction';
  id: string;
  sort_at: Date | string;
  // visita
  status: VisitStatus | null;
  visit_type: VisitType | null;
  scheduled_at: Date | string | null;
  check_in_at: Date | string | null;
  check_out_at: Date | string | null;
  responsible_user_id: string | null;
  responsible_name: string | null;
  status_reason: string | null;
  report_presented: string | null;
  report_feedback: string | null;
  report_objections: string | null;
  attachment_count: number | string | null;
  // registro manual
  doctor_id: string;
  interaction_type: DoctorInteractionType | null;
  description: string | null;
  created_by: string | null;
  created_by_name: string | null;
  updated_by: string | null;
  updated_by_name: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value !== null ? isoDateTime(value) : null;
}

function person(id: string | null, name: string | null): VisitPerson | null {
  return id !== null ? { id, name: name ?? '' } : null;
}

export function toDoctorInteraction(row: InteractionRow): DoctorInteraction {
  return {
    id: row.id,
    doctorId: row.doctor_id,
    type: row.type,
    occurredAt: isoDateTime(row.occurred_at),
    description: row.description,
    createdBy: person(row.created_by, row.created_by_name),
    updatedBy: person(row.updated_by, row.updated_by_name),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
}

/** Relato bruto da visita — o service escolhe e corta o trecho. */
export interface TimelineVisitReport {
  presented: string | null;
  feedback: string | null;
  objections: string | null;
}

/** Item da linha do tempo + o relato bruto (so visita) para o service montar o trecho. */
export interface TimelineEntry {
  item: DoctorTimelineItem;
  report: TimelineVisitReport | null;
}

function toTimelineEntry(row: TimelineRow): TimelineEntry {
  const occurredAt = isoDateTime(row.sort_at);
  if (row.kind === 'visit') {
    const visit: DoctorTimelineVisit = {
      kind: 'visit',
      id: row.id,
      occurredAt,
      status: row.status as VisitStatus,
      type: row.visit_type as VisitType,
      scheduledAt: isoDateTime(row.scheduled_at as Date | string),
      checkInAt: isoOrNull(row.check_in_at),
      checkOutAt: isoOrNull(row.check_out_at),
      responsible: person(row.responsible_user_id, row.responsible_name),
      statusReason: row.status_reason,
      reportExcerpt: null,
      attachmentCount: Number(row.attachment_count ?? 0),
    };
    return {
      item: visit,
      report: {
        presented: row.report_presented,
        feedback: row.report_feedback,
        objections: row.report_objections,
      },
    };
  }
  const interaction: DoctorTimelineInteraction = {
    kind: 'interaction',
    id: row.id,
    doctorId: row.doctor_id,
    type: row.interaction_type as DoctorInteractionType,
    occurredAt,
    description: row.description ?? '',
    createdBy: person(row.created_by, row.created_by_name),
    updatedBy: person(row.updated_by, row.updated_by_name),
    createdAt: isoDateTime(row.created_at as Date | string),
    updatedAt: isoDateTime(row.updated_at as Date | string),
  };
  return { item: interaction, report: null };
}

/** Posicao a partir da qual a proxima pagina continua (exclusiva). */
export interface TimelineCursor {
  sortAt: string;
  id: string;
}

/** Campos gravaveis — ja validados pelo service. */
export interface DoctorInteractionFields {
  type: DoctorInteractionType;
  occurredAt: string;
  description: string;
}

export type DoctorInteractionPatch = Partial<DoctorInteractionFields>;

const PATCH_COLUMNS: Record<keyof DoctorInteractionPatch, string> = {
  type: 'type',
  occurredAt: 'occurred_at',
  description: 'description',
};

/**
 * Posicao de cada item: o check-in da visita (o que aconteceu), ou a data
 * prevista se nao houve check-in; o `occurred_at` do registro manual.
 * Truncado em milissegundos: e a precisao do ISO que volta no cursor — sem
 * isso o microssegundo do Postgres faria a pagina seguinte repetir o item.
 */
const VISIT_SORT_AT = `date_trunc('milliseconds', COALESCE(v.check_in_at, v.scheduled_at))`;
const INTERACTION_SORT_AT = `date_trunc('milliseconds', i.occurred_at)`;

export class DoctorInteractionRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Uma pagina da linha do tempo do medico: visitas + registros manuais, do
   * mais novo para o mais antigo, com `id` como desempate. Le `limit + 1`
   * linhas para o service saber se ha proxima pagina.
   */
  async timeline(
    tenantId: string,
    doctorId: string,
    limit: number,
    cursor: TimelineCursor | null,
  ): Promise<TimelineEntry[]> {
    const params: unknown[] = [doctorId];
    let after = '';
    if (cursor !== null) {
      params.push(cursor.sortAt, cursor.id);
      after = `WHERE (t.sort_at, t.id) < ($2::timestamptz, $3::uuid)`;
    }
    params.push(limit + 1);

    const sql = `
      SELECT * FROM (
        SELECT 'visit' AS kind, v.id, ${VISIT_SORT_AT} AS sort_at,
          v.status, v.type AS visit_type, v.scheduled_at, v.check_in_at, v.check_out_at,
          v.responsible_user_id, ru.name AS responsible_name, v.status_reason,
          v.report_presented, v.report_feedback, v.report_objections,
          (SELECT COUNT(*)::int FROM doctor_visit_attachments a WHERE a.visit_id = v.id) AS attachment_count,
          v.doctor_id, NULL::varchar AS interaction_type, NULL::text AS description,
          NULL::uuid AS created_by, NULL::varchar AS created_by_name,
          NULL::uuid AS updated_by, NULL::varchar AS updated_by_name,
          NULL::timestamptz AS created_at, NULL::timestamptz AS updated_at
        FROM doctor_visits v
        LEFT JOIN users ru ON ru.id = v.responsible_user_id
        WHERE v.doctor_id = $1
        UNION ALL
        SELECT 'interaction' AS kind, i.id, ${INTERACTION_SORT_AT} AS sort_at,
          NULL::varchar, NULL::varchar, NULL::timestamptz, NULL::timestamptz, NULL::timestamptz,
          NULL::uuid, NULL::varchar, NULL::varchar,
          NULL::text, NULL::text, NULL::text,
          NULL::int,
          i.doctor_id, i.type, i.description,
          i.created_by, cu.name, i.updated_by, uu.name,
          i.created_at, i.updated_at
        ${FROM}
        WHERE i.doctor_id = $1
      ) t
      ${after}
      ORDER BY t.sort_at DESC, t.id DESC
      LIMIT $${params.length}`;

    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<TimelineRow>(sql, params);
      return result.rows.map(toTimelineEntry);
    });
  }

  /** Registro do medico informado — de outro medico (ou tenant) e `null`. */
  async findById(tenantId: string, doctorId: string, id: string): Promise<DoctorInteraction | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, doctorId, id));
  }

  async insert(
    tenantId: string,
    doctorId: string,
    createdBy: string | null,
    data: DoctorInteractionFields,
  ): Promise<DoctorInteraction> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO doctor_interactions (tenant_id, doctor_id, type, occurred_at, description, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, doctorId, data.type, data.occurredAt, data.description, createdBy],
      );
      const id = result.rows[0]?.id;
      const created = id ? await selectOne(tx, doctorId, id) : null;
      if (!created) throw new Error('INSERT em doctor_interactions nao retornou linha');
      return created;
    });
  }

  /**
   * Aplica o patch e grava quem editou. `null` quando o registro nao existe
   * para ESTE medico neste tenant. `updated_at` fica com o trigger.
   */
  async update(
    tenantId: string,
    doctorId: string,
    id: string,
    updatedBy: string | null,
    patch: DoctorInteractionPatch,
  ): Promise<DoctorInteraction | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof DoctorInteractionPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, doctorId, id);
      params.push(updatedBy);
      assignments.push(`updated_by = $${params.length}`);
      params.push(id, doctorId);
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_interactions SET ${assignments.join(', ')}
         WHERE id = $${params.length - 1} AND doctor_id = $${params.length}
         RETURNING id`,
        params,
      );
      return result.rows[0] ? selectOne(tx, doctorId, id) : null;
    });
  }

  /** `true` se apagou. */
  async delete(tenantId: string, doctorId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'DELETE FROM doctor_interactions WHERE id = $1 AND doctor_id = $2 RETURNING id',
        [id, doctorId],
      );
      return result.rows.length > 0;
    });
  }
}

async function selectOne(tx: DbTx, doctorId: string, id: string): Promise<DoctorInteraction | null> {
  const result = await tx.query<InteractionRow>(
    `SELECT ${COLUMNS} ${FROM} WHERE i.id = $1 AND i.doctor_id = $2`,
    [id, doctorId],
  );
  const row = result.rows[0];
  return row ? toDoctorInteraction(row) : null;
}
