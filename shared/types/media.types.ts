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

/**
 * Allow-list de MIME de mídia (CRMLAB-31). Espelha docs/api/API_CONTRACTS.md
 * §2d "Hardening de mídia" — fonte única para `MediaService` (grava) e
 * `media.routes.ts` (serve). Fora da lista -> `FALLBACK_MEDIA_MIME_TYPE`.
 *
 * `text/html`/`image/svg+xml` (o vetor de XSS do card) ficam de fora de
 * propósito: nada aqui pode ser interpretado como HTML/script pelo navegador.
 */
export const ALLOWED_MEDIA_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  'video/mp4',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
] as const;

export type AllowedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];

/** Tudo que não está na allow-list (ou diverge do magic-byte) vira isto. */
export const FALLBACK_MEDIA_MIME_TYPE = 'application/octet-stream';

export function isAllowedMediaMimeType(mimeType: string): mimeType is AllowedMediaMimeType {
  return (ALLOWED_MEDIA_MIME_TYPES as readonly string[]).includes(mimeType);
}
