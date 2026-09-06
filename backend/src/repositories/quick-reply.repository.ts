/**
 * Acesso a dados de `quick_replies` (SCHEMA.md §22). SEM regra de negocio
 * (CONVENTIONS.md "Backend"): quem normaliza atalho e traduz duplicidade em
 * erro de campo e o `QuickReplyService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Nenhum caminho aqui usa `withoutTenant()`: macro e dado de
 * laboratorio e o RLS falha fechado sem contexto de tenant.
 */
import type { QuickReply } from '@crm-lab/shared';
import type { DbClient, DbTx } from '../db/types.js';

const COLUMNS = `id, shortcut, title, content, created_by, created_at, updated_at`;

interface QuickReplyRow {
  id: string;
  shortcut: string;
  title: string;
  content: string;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** ISO 8601 UTC no fio (CLAUDE.md regra 9). */
function isoDateTime(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toQuickReply(row: QuickReplyRow): QuickReply {
  return {
    id: row.id,
    shortcut: row.shortcut,
    title: row.title,
    content: row.content,
    createdBy: row.created_by,
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
  };
}

export interface QuickReplyInsert {
  shortcut: string;
  title: string;
  content: string;
  createdBy: string | null;
}

export interface QuickReplyPatch {
  shortcut?: string;
  title?: string;
  content?: string;
}

/** Colunas de `QuickReplyPatch` -> coluna fisica. Whitelist: nada dinamico no SQL. */
const PATCH_COLUMNS: Record<keyof QuickReplyPatch, string> = {
  shortcut: 'shortcut',
  title: 'title',
  content: 'content',
};

/** SQLSTATE de violacao de unicidade — o service converte para erro de campo. */
export const UNIQUE_VIOLATION = '23505';
/** SQLSTATE de violacao de CHECK — o `quick_replies_shortcut_format` da 008. */
export const CHECK_VIOLATION = '23514';

function hasSqlState(err: unknown, state: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; cause?: unknown };
  if (candidate.code === state) return true;
  // PGlite embrulha o erro do servidor em `cause` em alguns caminhos.
  return hasSqlState(candidate.cause, state);
}

export function isUniqueViolation(err: unknown): boolean {
  return hasSqlState(err, UNIQUE_VIOLATION);
}

export function isCheckViolation(err: unknown): boolean {
  return hasSqlState(err, CHECK_VIOLATION);
}

export class QuickReplyRepository {
  constructor(private readonly db: DbClient) {}

  /**
   * Todas as macros do tenant, ordenadas por atalho. Sem paginacao: a lista
   * alimenta o menu do Composer, que precisa dela inteira para filtrar
   * enquanto se digita (API_CONTRACTS.md §9).
   */
  async list(tenantId: string): Promise<QuickReply[]> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<QuickReplyRow>(
        `SELECT ${COLUMNS} FROM quick_replies ORDER BY shortcut ASC`,
      );
      return result.rows.map(toQuickReply);
    });
  }

  async findById(tenantId: string, id: string): Promise<QuickReply | null> {
    return this.db.withTenant(tenantId, (tx) => selectOne(tx, id));
  }

  async insert(tenantId: string, data: QuickReplyInsert): Promise<QuickReply> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<QuickReplyRow>(
        `INSERT INTO quick_replies (tenant_id, shortcut, title, content, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [tenantId, data.shortcut, data.title, data.content, data.createdBy],
      );
      const row = result.rows[0];
      if (!row) throw new Error('INSERT em quick_replies nao retornou linha');
      return toQuickReply(row);
    });
  }

  /**
   * Aplica o patch. Devolve `null` quando o id nao existe NESTE tenant — o RLS
   * ja torna a linha de outro tenant invisivel, e o service converte isso em
   * `NOT_FOUND` (nunca `FORBIDDEN`; CLAUDE.md regra 8).
   */
  async update(tenantId: string, id: string, patch: QuickReplyPatch): Promise<QuickReply | null> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const key of Object.keys(PATCH_COLUMNS) as Array<keyof QuickReplyPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      params.push(value);
      assignments.push(`${PATCH_COLUMNS[key]} = $${params.length}`);
    }

    return this.db.withTenant(tenantId, async (tx) => {
      if (assignments.length === 0) return selectOne(tx, id);
      params.push(id);
      const result = await tx.query<QuickReplyRow>(
        `UPDATE quick_replies SET ${assignments.join(', ')}, updated_at = NOW()
         WHERE id = $${params.length}
         RETURNING ${COLUMNS}`,
        params,
      );
      const row = result.rows[0];
      return row ? toQuickReply(row) : null;
    });
  }

  /** `true` quando apagou. `false` = id inexistente neste tenant -> NOT_FOUND. */
  async remove(tenantId: string, id: string): Promise<boolean> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        'DELETE FROM quick_replies WHERE id = $1 RETURNING id',
        [id],
      );
      return result.rows.length > 0;
    });
  }
}

async function selectOne(tx: DbTx, id: string): Promise<QuickReply | null> {
  const result = await tx.query<QuickReplyRow>(
    `SELECT ${COLUMNS} FROM quick_replies WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toQuickReply(row) : null;
}
