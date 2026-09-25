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
  // Foto de iPhone sai como HEIC por padrão; `file-type` reconhece a assinatura.
  'image/heic',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/amr',
  // Recado de voz gravado no Chrome/Edge (`MediaRecorder`, CRMLAB-24, D-182).
  'audio/webm',
  'video/mp4',
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
] as const;

export type AllowedMediaMimeType = (typeof ALLOWED_MEDIA_MIME_TYPES)[number];

/** Tudo que não está na allow-list (ou diverge do magic-byte) vira isto. */
export const FALLBACK_MEDIA_MIME_TYPE = 'application/octet-stream';

/**
 * Sinônimos que gateways e o `file-type` usam para o MESMO formato da
 * allow-list. Comparar string crua rejeitava anexo legítimo (revisão do PR
 * #43): o `file-type` rotula áudio M4A como `audio/x-m4a` e PNG animado como
 * `image/apng`, e um `.wav` chega como `audio/x-wav` ou `audio/wave`.
 */
const MEDIA_MIME_ALIASES: Readonly<Record<string, AllowedMediaMimeType>> = {
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'image/apng': 'image/png',
  'image/jpg': 'image/jpeg',
  'image/heif': 'image/heic',
  'audio/mp3': 'audio/mpeg',
  'audio/opus': 'audio/ogg',
};

/**
 * Forma canônica de um MIME para comparar com a allow-list: minúsculo, sem
 * espaços e SEM PARÂMETROS. `audio/ogg; codecs=opus` é o mimetype padrão do
 * recado de voz do WhatsApp — comparar a string inteira contra `audio/ogg`
 * rebaixava TODO áudio recebido para `application/octet-stream` (revisão do
 * PR #43: o player sumia e a bolha mostrava "Baixar anexo (doc)").
 */
export function normalizeMediaMimeType(mimeType: string): string {
  const base = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  return MEDIA_MIME_ALIASES[base] ?? base;
}

export function isAllowedMediaMimeType(mimeType: string): mimeType is AllowedMediaMimeType {
  return (ALLOWED_MEDIA_MIME_TYPES as readonly string[]).includes(normalizeMediaMimeType(mimeType));
}

/**
 * Categoria para efeito de sniff (`MediaService`) e de `Content-Disposition`
 * (`media.routes.ts`): o que o navegador pode exibir inline sem risco. UMA
 * cópia — a revisão do PR #43 achou cinco mapeamentos MIME→categoria
 * divergentes espalhados pelo backend.
 */
export type MediaCategory = 'image' | 'audio' | 'pdf' | 'other';

export function mediaCategoryOf(mimeType: string): MediaCategory {
  const mime = normalizeMediaMimeType(mimeType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}
