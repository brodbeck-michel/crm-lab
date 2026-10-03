/**
 * Acesso a dados de `doctor_visits` e `doctor_visit_reschedules` (SCHEMA.md
 * §36 — CRMLAB-87, D-256) e `doctor_visit_attachments` (§37 — CRMLAB-88, D-258). SEM regra de negocio (CONVENTIONS.md "Backend"):
 * quem pode mudar o que, o motivo obrigatorio e o audit sao do `VisitService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`.
 */
import type {
  Visit,
  VisitAttachment,
  VisitDetail,
  VisitPerson,
  VisitReschedule,
  VisitStatus,
  VisitType,
} from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

/** `LEFT JOIN users` para os nomes; o medico e obrigatorio (JOIN). */
const COLUMNS = `v.id, v.doctor_id, d.name AS doctor_name, d.crm AS doctor_crm, d.crm_uf AS doctor_crm_uf,
  d.specialty AS doctor_specialty, d.is_active AS doctor_is_active,
  v.responsible_user_id, ru.name AS responsible_name,
  v.scheduled_at, v.type, v.agenda, v.status, v.status_reason, v.status_changed_at,
  v.status_changed_by, su.name AS status_changed_by_name,
  v.created_by, cu.name AS created_by_name, v.created_at, v.updated_at,
  (SELECT COUNT(*)::int FROM doctor_visit_reschedules r WHERE r.visit_id = v.id) AS reschedule_count,
  v.check_in_at, v.check_in_by, ciu.name AS check_in_by_name,
  v.check_out_at, v.check_out_by, cou.name AS check_out_by_name,
  to_char(v.next_visit_date, 'YYYY-MM-DD') AS next_visit_date,
  v.report_presented, v.report_feedback, v.report_objections,
  (SELECT COUNT(*)::int FROM doctor_visit_attachments a WHERE a.visit_id = v.id) AS attachment_count`;

const FROM = `FROM doctor_visits v
  JOIN doctors d ON d.id = v.doctor_id
  LEFT JOIN users ru ON ru.id = v.responsible_user_id
  LEFT JOIN users su ON su.id = v.status_changed_by
  LEFT JOIN users cu ON cu.id = v.created_by
  LEFT JOIN users ciu ON ciu.id = v.check_in_by
  LEFT JOIN users cou ON cou.id = v.check_out_by`;

/** Status em que relato, proximo passo e anexos mudam (D-258 item 6). */
const RECORD_EDITABLE = `('agendada', 'realizada')`;

interface VisitRow {
  id: string;
  doctor_id: string;
  doctor_name: string;
  doctor_crm: string | null;
  doctor_crm_uf: string | null;
  doctor_specialty: string | null;
  doctor_is_active: boolean;
  responsible_user_id: string | null;
  responsible_name: string | null;
  scheduled_at: Date | string;
  type: VisitType;
  agenda: string | null;
  status: VisitStatus;
  status_reason: string | null;
  status_changed_at: Date | string | null;
  status_changed_by: string | null;
  status_changed_by_name: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  reschedule_count: number | string;
  check_in_at: Date | string | null;
  check_in_by: string | null;
  check_in_by_name: string | null;
  check_out_at: Date | string | null;
  check_out_by: string | null;
  check_out_by_name: string | null;
  /** `to_char` no SQL: `DATE` cru voltaria no fuso da maquina (D-078). */
  next_visit_date: string | null;
  report_presented: string | null;
  report_feedback: string | null;
  report_objections: string | null;
  attachment_count: number | string;
}

interface AttachmentRow {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number | string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: Date | string;
}

interface RescheduleRow {
  id: string;
  previous_scheduled_at: Date | string;
  new_scheduled_at: Date | string;
  reason: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: Date | string;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function person(id: string | null, name: string | null): VisitPerson | null {
  return id !== null ? { id, name: name ?? '' } : null;
}

function isoOrNull(value: Date | string | null): string | null {
  return value !== null ? isoDateTime(value) : null;
}

export function toVisit(row: VisitRow): Visit {
  return {
    id: row.id,
    doctor: {
      id: row.doctor_id,
      name: row.doctor_name,
      crm: row.doctor_crm,
      crmUf: row.doctor_crm_uf,
      specialty: row.doctor_specialty,
      isActive: row.doctor_is_active,
    },
    responsible: person(row.responsible_user_id, row.responsible_name),
    scheduledAt: isoDateTime(row.scheduled_at),
    type: row.type,
    agenda: row.agenda,
    status: row.status,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at !== null ? isoDateTime(row.status_changed_at) : null,
    statusChangedBy: person(row.status_changed_by, row.status_changed_by_name),
    rescheduleCount: Number(row.reschedule_count),
    createdBy: person(row.created_by, row.created_by_name),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
    checkInAt: isoOrNull(row.check_in_at),
    checkInBy: person(row.check_in_by, row.check_in_by_name),
    checkOutAt: isoOrNull(row.check_out_at),
    checkOutBy: person(row.check_out_by, row.check_out_by_name),
    nextVisitDate: row.next_visit_date,
    attachmentCount: Number(row.attachment_count),
  };
}

function toAttachment(row: AttachmentRow): VisitAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: Number(row.byte_size),
    uploadedBy: person(row.uploaded_by, row.uploaded_by_name),
    createdAt: isoDateTime(row.created_at),
  };
}

function toReschedule(row: RescheduleRow): VisitReschedule {
  return {
    id: row.id,
    previousScheduledAt: isoDateTime(row.previous_scheduled_at),
    newScheduledAt: isoDateTime(row.new_scheduled_at),
    reason: row.reason,
    changedBy: person(row.changed_by, row.changed_by_name),
    changedAt: isoDateTime(row.changed_at),
  };
}

export interface VisitListCriteria {
  from: Date;
  to: Date;
  doctorId?: string;
  responsibleId?: string;
  status?: VisitStatus;
  /** Quantas linhas buscar (o service pede uma a mais para saber se truncou). */
  limit: number;
}

export interface VisitFields {
  doctorId: string;
  responsibleId: string;
  scheduledAt: Date;
  type: VisitType;
  agenda: string | null;
}

export type VisitPatch = Partial<Pick<VisitFields, 'doctorId' | 'responsibleId' | 'type' | 'agenda'>>;

/** Campo -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof VisitPatch, string> = {
  doctorId: 'doctor_id',
  responsibleId: 'responsible_user_id',
  type: 'type',
  agenda: 'agenda',
};

/** Campos do relato + proximo passo (CRMLAB-88). */
export interface VisitReportPatch {
  presented?: string | null;
  doctorFeedback?: string | null;
  objections?: string | null;
  nextVisitDate?: string | null;
}

const REPORT_COLUMNS: Record<keyof VisitReportPatch, string> = {
  presented: 'report_presented',
  doctorFeedback: 'report_feedback',
  objections: 'report_objections',
  nextVisitDate: 'next_visit_date',
};

export interface AttachmentInsert {
  mimeType: string;
  fileName: string;
  byteSize: number;
}

/**
 * Resultado de `insertAttachment`. A guarda de status e do teto roda na
 * MESMA transacao do INSERT, com a visita travada (`FOR UPDATE`), para dois
 * uploads simultaneos nao passarem juntos do teto.
 */
export type AttachmentInsertResult =
  | { kind: 'ok'; attachment: VisitAttachment }
  | { kind: 'missing' }
  | { kind: 'not_editable' }
  | { kind: 'full' };

/** Medico do tenant, para validar a escolha na visita. */
export interface TenantDoctorRef {
  id: string;
  isActive: boolean;
}

/** Usuario do laboratorio que pode ser responsavel pela visita. */
export interface TenantUserRef {
  id: string;
  role: string;
  isActive: boolean;
}

export class VisitRepository {
  constructor(private readonly db: DbClient) {}

  /** Visitas de `[from, to)` com os filtros, por `scheduled_at` crescente. */
  async list(tenantId: string, criteria: VisitListCriteria): Promise<Visit[]> {
    const params: unknown[] = [criteria.from.toISOString(), criteria.to.toISOString()];
    const where = ['v.scheduled_at >= $1::timestamptz', 'v.scheduled_at < $2::timestamptz'];

    if (criteria.doctorId !== undefined) {
      params.push(criteria.doctorId);
      where.push(`v.doctor_id = $${params.length}`);
    }
    if (criteria.responsibleId !== undefined) {
      params.push(criteria.responsibleId);
      where.push(`v.responsible_user_id = $${params.length}`);
    }
    if (criteria.status !== undefined) {
      params.push(criteria.status);
      where.push(`v.status = $${params.length}`);
    }
    params.push(criteria.limit);

    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<VisitRow>(
        `SELECT ${COLUMNS} ${FROM}
         WHERE ${where.join(' AND ')}
         ORDER BY v.scheduled_at ASC, v.id ASC
         LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(toVisit);
    });
  }

  async findById(tenantId: string, id: string): Promise<VisitDetail | null> {
    return this.db.withTenant(tenantId, (tx) => selectDetail(tx, id));
  }

  /**
   * Medico do PROPRIO tenant. O filtro explicito por `tenant_id` e redundante
   * com o RLS, de proposito (mesmo padrao de `DoctorRepository.findTenantUser`).
   */
  async findTenantDoctor(tenantId: string, doctorId: string): Promise<TenantDoctorRef | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string; is_active: boolean }>(
        'SELECT id, is_active FROM doctors WHERE id = $1 AND tenant_id = $2',
        [doctorId, tenantId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, isActive: row.is_active } : null;
    });
  }

  async findTenantUser(tenantId: string, userId: string): Promise<TenantUserRef | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string; role: string; is_active: boolean }>(
        'SELECT id, role, is_active FROM users WHERE id = $1 AND tenant_id = $2',
        [userId, tenantId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, role: row.role, isActive: row.is_active } : null;
    });
  }

  async insert(tenantId: string, createdBy: string | null, data: VisitFields): Promise<VisitDetail> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO doctor_visits (tenant_id, doctor_id, responsible_user_id, scheduled_at, type, agenda, created_by)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7)
         RETURNING id`,
        [
          tenantId,
          data.doctorId,
          data.responsibleId,
          data.scheduledAt.toISOString(),
          data.type,
          data.agenda,
          createdBy,
        ],
      );
      const id = result.rows[0]?.id;
      const created = id ? await selectDetail(tx, id) : null;
      if (!created) throw new Error('INSERT em doctor_visits nao retornou linha');
      return created;
    });
  }

  /**
   * Aplica o patch SO se a visita ainda esta `agendada` (a guarda vai no
   * `WHERE`, para uma corrida com cancelar nao editar visita encerrada).
   * `null` = id inexistente neste tenant OU visita ja encerrada; o service
   * distingue relendo.
   */
  async updateOpen(tenantId: string, id: string, patch: VisitPatch): Promise<VisitDetail | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof VisitPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectDetail(tx, id);
      params.push(id);
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits SET ${assignments.join(', ')}
         WHERE id = $${params.length} AND status = 'agendada'
         RETURNING id`,
        params,
      );
      return result.rows[0] ? selectDetail(tx, id) : null;
    });
  }

  /**
   * Muda a data da visita `agendada` e grava o historico na MESMA transacao.
   * `null` = inexistente ou ja encerrada.
   */
  async reschedule(
    tenantId: string,
    id: string,
    changedBy: string | null,
    previousScheduledAt: Date,
    newScheduledAt: Date,
    reason: string | null,
  ): Promise<VisitDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      // Depois do check-in a data nao muda mais (D-258 item 4).
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits SET scheduled_at = $1::timestamptz
         WHERE id = $2 AND status = 'agendada' AND check_in_at IS NULL
         RETURNING id`,
        [newScheduledAt.toISOString(), id],
      );
      if (!result.rows[0]) return null;
      await tx.query(
        `INSERT INTO doctor_visit_reschedules
           (tenant_id, visit_id, previous_scheduled_at, new_scheduled_at, reason, changed_by)
         VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6)`,
        [tenantId, id, previousScheduledAt.toISOString(), newScheduledAt.toISOString(), reason, changedBy],
      );
      return selectDetail(tx, id);
    });
  }

  /** `agendada` -> `cancelada | nao_recebeu` com motivo. `null` = inexistente ou ja encerrada. */
  async close(
    tenantId: string,
    id: string,
    status: VisitStatus,
    reason: string,
    changedBy: string | null,
  ): Promise<VisitDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits
            SET status = $1, status_reason = $2, status_changed_at = now(), status_changed_by = $3
          WHERE id = $4 AND status = 'agendada'
          RETURNING id`,
        [status, reason, changedBy, id],
      );
      return result.rows[0] ? selectDetail(tx, id) : null;
    });
  }

  /** Check-in de visita `agendada` ainda sem check-in. `null` = a guarda falhou. */
  async checkIn(tenantId: string, id: string, userId: string | null): Promise<VisitDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits SET check_in_at = now(), check_in_by = $1
          WHERE id = $2 AND status = 'agendada' AND check_in_at IS NULL
          RETURNING id`,
        [userId, id],
      );
      return result.rows[0] ? selectDetail(tx, id) : null;
    });
  }

  /**
   * Check-out: `agendada` com check-in -> `realizada`, no mesmo UPDATE.
   * `null` = a guarda falhou (sem check-in, encerrada ou inexistente).
   */
  async checkOut(tenantId: string, id: string, userId: string | null): Promise<VisitDetail | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits
            SET check_out_at = GREATEST(now(), check_in_at), check_out_by = $1,
                status = 'realizada', status_changed_at = GREATEST(now(), check_in_at), status_changed_by = $1
          WHERE id = $2 AND status = 'agendada' AND check_in_at IS NOT NULL AND check_out_at IS NULL
          RETURNING id`,
        [userId, id],
      );
      return result.rows[0] ? selectDetail(tx, id) : null;
    });
  }

  /** Relato/proximo passo de visita `agendada` ou `realizada`. `null` = a guarda falhou. */
  async updateReport(tenantId: string, id: string, patch: VisitReportPatch): Promise<VisitDetail | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];
    for (const key of Object.keys(REPORT_COLUMNS) as Array<keyof VisitReportPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      const cast = key === 'nextVisitDate' ? '::date' : '';
      assignments.push(`${REPORT_COLUMNS[key]} = $${params.length}${cast}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectDetail(tx, id);
      params.push(id);
      const result = await tx.query<{ id: string }>(
        `UPDATE doctor_visits SET ${assignments.join(', ')}
          WHERE id = $${params.length} AND status IN ${RECORD_EDITABLE}
          RETURNING id`,
        params,
      );
      return result.rows[0] ? selectDetail(tx, id) : null;
    });
  }

  async insertAttachment(
    tenantId: string,
    visitId: string,
    uploadedBy: string | null,
    data: AttachmentInsert,
    maxPerVisit: number,
  ): Promise<AttachmentInsertResult> {
    return this.db.withTenant(tenantId, async (tx) => {
      const visit = await tx.query<{ status: VisitStatus }>(
        'SELECT status FROM doctor_visits WHERE id = $1 FOR UPDATE',
        [visitId],
      );
      const status = visit.rows[0]?.status;
      if (!status) return { kind: 'missing' };
      if (status !== 'agendada' && status !== 'realizada') return { kind: 'not_editable' };

      const count = await tx.query<{ total: number | string }>(
        'SELECT COUNT(*)::int AS total FROM doctor_visit_attachments WHERE visit_id = $1',
        [visitId],
      );
      if (Number(count.rows[0]?.total ?? 0) >= maxPerVisit) return { kind: 'full' };

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO doctor_visit_attachments (tenant_id, visit_id, mime_type, file_name, byte_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, visitId, data.mimeType, data.fileName, data.byteSize, uploadedBy],
      );
      const id = inserted.rows[0]?.id;
      const attachment = id ? await selectAttachment(tx, visitId, id) : null;
      if (!attachment) throw new Error('INSERT em doctor_visit_attachments nao retornou linha');
      return { kind: 'ok', attachment };
    });
  }

  /** Anexo DESTA visita (anexo de outra visita = inexistente). */
  async findAttachment(tenantId: string, visitId: string, attachmentId: string): Promise<VisitAttachment | null> {
    return this.db.withTenant(tenantId, (tx) => selectAttachment(tx, visitId, attachmentId));
  }

  /**
   * Apaga o anexo se a visita ainda aceita mudanca no registro. `null` = a
   * guarda falhou (anexo inexistente/de outra visita, ou visita encerrada).
   */
  async deleteAttachment(tenantId: string, visitId: string, attachmentId: string): Promise<VisitAttachment | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const current = await selectAttachment(tx, visitId, attachmentId);
      if (!current) return null;
      const result = await tx.query<{ id: string }>(
        `DELETE FROM doctor_visit_attachments a
          USING doctor_visits v
          WHERE a.id = $1 AND a.visit_id = $2 AND v.id = a.visit_id AND v.status IN ${RECORD_EDITABLE}
          RETURNING a.id`,
        [attachmentId, visitId],
      );
      return result.rows[0] ? current : null;
    });
  }

  /** Desfaz o INSERT quando a gravacao do arquivo em disco falha. */
  async removeAttachmentRow(tenantId: string, attachmentId: string): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query('DELETE FROM doctor_visit_attachments WHERE id = $1', [attachmentId]),
    );
  }
}

async function selectAttachment(tx: DbTx, visitId: string, attachmentId: string): Promise<VisitAttachment | null> {
  const result = await tx.query<AttachmentRow>(
    `SELECT a.id, a.file_name, a.mime_type, a.byte_size, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
       FROM doctor_visit_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.id = $1 AND a.visit_id = $2`,
    [attachmentId, visitId],
  );
  const row = result.rows[0];
  return row ? toAttachment(row) : null;
}

async function selectDetail(tx: DbTx, id: string): Promise<VisitDetail | null> {
  const result = await tx.query<VisitRow>(`SELECT ${COLUMNS} ${FROM} WHERE v.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  const history = await tx.query<RescheduleRow>(
    `SELECT r.id, r.previous_scheduled_at, r.new_scheduled_at, r.reason, r.changed_by,
            u.name AS changed_by_name, r.changed_at
       FROM doctor_visit_reschedules r
       LEFT JOIN users u ON u.id = r.changed_by
      WHERE r.visit_id = $1
      ORDER BY r.changed_at ASC, r.id ASC`,
    [id],
  );
  const attachments = await tx.query<AttachmentRow>(
    `SELECT a.id, a.file_name, a.mime_type, a.byte_size, a.uploaded_by, u.name AS uploaded_by_name, a.created_at
       FROM doctor_visit_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.visit_id = $1
      ORDER BY a.created_at ASC, a.id ASC`,
    [id],
  );
  return {
    ...toVisit(row),
    reschedules: history.rows.map(toReschedule),
    report: {
      presented: row.report_presented,
      doctorFeedback: row.report_feedback,
      objections: row.report_objections,
    },
    attachments: attachments.rows.map(toAttachment),
  };
}
