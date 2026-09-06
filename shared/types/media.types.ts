/**
 * Mídia de mensagem — Onda 8 §4 (anexo e áudio).
 * Espelha docs/api/API_CONTRACTS.md §2d.
 */

/**
 * `POST /conversations/:id/attachments` — base64 em JSON, não multipart
 * (Express 4 não faz multipart sozinho, e o Evolution já resolve em base64
 * nos dois sentidos — ver a spec da Onda 8 §4.3).
 */
export interface CreateAttachmentRequest {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}
