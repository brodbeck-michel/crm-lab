/**
 * Acesso a dados de `doctor_timeline_comments` (SCHEMA.md §38a — CRMLAB-192,
 * D-332): comentarios nos itens da linha do tempo do medico (visita OU
 * registro manual). SEM regra de negocio: escopo, autoria, teto e audit sao
 * do `DoctorInteractionService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). O "do mesmo medico" e conferido no SQL (`doctor_id` da visita
 * ou do registro), nunca depois.
 */
import type { DoctorTimelineComment, DoctorTimelineItemKind } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

interface CommentRow {
  id: string;
  visit_id: string | null;
  interaction_id: string | null;
  body: string;
  author_id: string | null;
  author_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  edited_at: Date | string | null;
}

const COLUMNS = `c.id, c.visit_id, c.interaction_id, c.body, c.author_id, u.name AS author_name,
  c.created_at, c.updated_at, c.edited_at`;

/** Comentario + o medico do item (para o service conferir o caminho). */
const FROM = `FROM doctor_timeline_comments c
  LEFT JOIN users u ON u.id = c.author_id
  LEFT JOIN doctor_visits v ON v.id = c.visit_id
  LEFT JOIN doctor_interactions i ON i.id = c.interaction_id`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toComment(row: CommentRow): DoctorTimelineComment {
  const itemKind: DoctorTimelineItemKind = row.visit_id !== null ? 'visit' : 'interaction';
  return {
    id: row.id,
    itemKind,
    itemId: (row.visit_id ?? row.interaction_id) as string,
    body: row.body,
    author: row.author_id !== null ? { id: row.author_id, name: row.author_name ?? '' } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    editedAt: row.edited_at !== null ? iso(row.edited_at) : null,
  };
}

/** Coluna do alvo — so os dois literais, nunca texto do cliente. */
function targetColumn(kind: DoctorTimelineItemKind): 'visit_id' | 'interaction_id' {
  return kind === 'visit' ? 'visit_id' : 'interaction_id';
}

async function selectOne(tx: DbTx, doctorId: string, id: string): Promise<DoctorTimelineComment | null> {
  const result = await tx.query<CommentRow>(
    `SELECT ${COLUMNS} ${FROM} WHERE c.id = $1 AND COALESCE(v.doctor_id, i.doctor_id) = $2`,
    [id, doctorId],
  );
  const row = result.rows[0];
  return row ? toComment(row) : null;
}

export class DoctorTimelineCommentRepository {
  constructor(private readonly db: DbClient) {}

  /** Comentarios dos itens informados, mais antigo primeiro. */
  async listForItems(
    tenantId: string,
    visitIds: string[],
    interactionIds: string[],
  ): Promise<DoctorTimelineComment[]> {
    if (visitIds.length === 0 && interactionIds.length === 0) return [];
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<CommentRow>(
        `SELECT ${COLUMNS} ${FROM}
          WHERE c.visit_id = ANY($1::uuid[]) OR c.interaction_id = ANY($2::uuid[])
          ORDER BY c.created_at ASC, c.id ASC`,
        [visitIds, interactionIds],
      );
      return result.rows.map(toComment);
    });
  }

  /**
   * Quantos comentarios o item tem — `null` quando o item nao existe para
   * ESTE medico neste tenant.
   */
  async countForItem(
    tenantId: string,
    doctorId: string,
    kind: DoctorTimelineItemKind,
    itemId: string,
  ): Promise<number | null> {
    const table = kind === 'visit' ? 'doctor_visits' : 'doctor_interactions';
    const column = targetColumn(kind);
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ total: number | string }>(
        `SELECT (SELECT COUNT(*)::int FROM doctor_timeline_comments c WHERE c.${column} = t.id) AS total
           FROM ${table} t WHERE t.id = $1 AND t.doctor_id = $2`,
        [itemId, doctorId],
      );
      const row = result.rows[0];
      return row ? Number(row.total) : null;
    });
  }

  /** Comentario de um item DESTE medico — de outro medico (ou tenant) e `null`. */
  async findById(tenantId: string, doctorId: string, id: string): Promise<DoctorTimelineComment | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, doctorId, id));
  }

  async insert(
    tenantId: string,
    doctorId: string,
    kind: DoctorTimelineItemKind,
    itemId: string,
    authorId: string | null,
    body: string,
  ): Promise<DoctorTimelineComment> {
    const column = targetColumn(kind);
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `INSERT INTO doctor_timeline_comments (tenant_id, ${column}, author_id, body)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [tenantId, itemId, authorId, body],
      );
      const id = result.rows[0]?.id;
      const created = id ? await selectOne(tx, doctorId, id) : null;
      if (!created) throw new Error('INSERT em doctor_timeline_comments nao retornou linha');
      return created;
    });
  }

  /** Troca o texto e marca `edited_at`. `null` se sumiu no meio do caminho. */
  async updateBody(
    tenantId: string,
    doctorId: string,
    id: string,
    body: string,
  ): Promise<DoctorTimelineComment | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'UPDATE doctor_timeline_comments SET body = $1, edited_at = now() WHERE id = $2 RETURNING id',
        [body, id],
      );
      return result.rows[0] ? selectOne(tx, doctorId, id) : null;
    });
  }

  /** `true` se apagou. */
  async delete(tenantId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'DELETE FROM doctor_timeline_comments WHERE id = $1 RETURNING id',
        [id],
      );
      return result.rows.length > 0;
    });
  }
}
