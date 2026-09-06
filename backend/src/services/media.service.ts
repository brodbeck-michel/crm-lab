/**
 * MediaService — Onda 8 §4 (anexo e áudio).
 *
 * Teto de tamanho explicito na validacao (spec §4.3): a alternativa seria
 * esconder o limite dentro de um middleware de multipart (`multer`), que este
 * projeto nem usa — Express 4 recebe o arquivo em base64 dentro do JSON.
 */
import type { MessageType } from '@crm-lab/shared';
import { BusinessError, notFound } from '../http/errors.js';
import { readMediaFile, writeMediaFile } from '../lib/media-storage.js';
import { logger } from '../lib/logger.js';
import { MediaRepository } from '../repositories/media.repository.js';

/** 15 MiB — recado de voz e foto de pedido medico cabem folgados; base64 ja infla ~33%. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export function messageTypeFromMime(mimeType: string): MessageType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'doc';
}

export interface StoredMedia {
  id: string;
  buffer: Buffer;
}

export interface ReadMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export class MediaService {
  constructor(private readonly repository: MediaRepository) {}

  /**
   * Saída (CRM → paciente, §4.3). Lança `MEDIA_TOO_LARGE` — quem chama ainda
   * nao gravou mensagem nenhuma, entao nao ha nada para desfazer.
   */
  async storeOutbound(
    tenantId: string,
    dto: { fileName: string; mimeType: string; contentBase64: string },
  ): Promise<StoredMedia> {
    const buffer = decodeBase64(dto.contentBase64);
    assertWithinLimit(buffer);
    const id = await this.repository.insert(tenantId, {
      messageId: null,
      mimeType: dto.mimeType,
      fileName: dto.fileName,
      byteSize: buffer.byteLength,
    });
    await writeMediaFile(id, buffer);
    return { id, buffer };
  }

  /**
   * Entrada (paciente → CRM, §4.2). NUNCA lança: um arquivo grande demais e
   * recusado com log explicito, e o webhook responde 200 do mesmo jeito —
   * quem chama trata `null` como "nao ha mídia para anexar".
   */
  async storeInbound(
    tenantId: string,
    dto: { fileName: string; mimeType: string; base64: string },
  ): Promise<StoredMedia | null> {
    const buffer = decodeBase64(dto.base64);
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_MEDIA_BYTES) {
      logger.warn('media.inbound_rejected', { tenantId, byteSize: buffer.byteLength });
      return null;
    }
    const id = await this.repository.insert(tenantId, {
      messageId: null,
      mimeType: dto.mimeType,
      fileName: dto.fileName,
      byteSize: buffer.byteLength,
    });
    await writeMediaFile(id, buffer);
    return { id, buffer };
  }

  async attachToMessage(tenantId: string, id: string, messageId: string): Promise<void> {
    await this.repository.attachToMessage(tenantId, id, messageId);
  }

  /** `GET /media/:id`. `null` = mídia inexistente OU de outro tenant (RLS). */
  async read(tenantId: string, id: string): Promise<ReadMedia | null> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) return null;
    const buffer = await readMediaFile(id);
    return { buffer, mimeType: row.mimeType, fileName: row.fileName };
  }

  /** Mesmo que `read`, mas lança `NOT_FOUND` — atalho para o controller. */
  async readOrThrow(tenantId: string, id: string): Promise<ReadMedia> {
    const media = await this.read(tenantId, id);
    if (!media) throw notFound({ resource: 'media', id });
    return media;
  }
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function assertWithinLimit(buffer: Buffer): void {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_MEDIA_BYTES) {
    throw new BusinessError('MEDIA_TOO_LARGE', { byteSize: buffer.byteLength, max: MAX_MEDIA_BYTES });
  }
}
