/**
 * Acesso a dados de `message_media` (Onda 8 §4, SCHEMA.md §22). SEM regra de
 * negocio (CONVENTIONS.md): quem decide teto de tamanho e o `MediaService`.
 *
 * Todo metodo abre `db.withTenant(tenantId, ...)` — camada 3 do isolamento
 * (SECURITY.md). Mídia de outro tenant e invisivel pelo RLS, nunca lida aqui.
 */
import type { DbClient, DbTx } from '../db/types.js';

export interface MediaRow {
  id: string;
  mimeType: string;
  fileName: string;
  byteSize: number;
}

export interface MediaInsert {
  messageId: string | null;
  mimeType: string;
  fileName: string;
  byteSize: number;
}

export class MediaRepository {
  constructor(private readonly db: DbClient) {}

  /** Insere a linha e devolve o id — o MESMO nome que o arquivo recebe em disco. */
  async insert(tenantId: string, data: MediaInsert): Promise<string> {
    return this.db.withTenant(tenantId, (tx) => insertMediaRow(tx, tenantId, data));
  }

  /** Liga a mídia (gravada antes) à mensagem recém-criada. */
  async attachToMessage(tenantId: string, id: string, messageId: string): Promise<void> {
    await this.db.withTenant(tenantId, (tx) =>
      tx.query('UPDATE message_media SET message_id = $1 WHERE id = $2', [messageId, id]),
    );
  }

  async findById(tenantId: string, id: string): Promise<MediaRow | null> {
    return this.db.withTenant(tenantId, async (tx) => {
      const result = await tx.query<{
        id: string;
        mime_type: string;
        file_name: string;
        byte_size: number;
      }>('SELECT id, mime_type, file_name, byte_size FROM message_media WHERE id = $1', [id]);
      const row = result.rows[0];
      if (!row) return null;
      return { id: row.id, mimeType: row.mime_type, fileName: row.file_name, byteSize: row.byte_size };
    });
  }
}

/**
 * O mesmo INSERT dentro de uma transacao ja aberta com `withTenant` — usado
 * pelo anexo com `scanId` (CRMLAB-184, D-326): a foto sai da fila na MESMA
 * transacao em que a midia da mensagem e gravada.
 */
export async function insertMediaRow(tx: DbTx, tenantId: string, data: MediaInsert): Promise<string> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO message_media (tenant_id, message_id, mime_type, file_name, byte_size)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, data.messageId, data.mimeType, data.fileName, data.byteSize],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('INSERT em message_media nao retornou linha');
  return id;
}
