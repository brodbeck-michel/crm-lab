/**
 * MediaService — Onda 8 §4 (anexo e áudio).
 *
 * Teto de tamanho explicito na validacao (spec §4.3): a alternativa seria
 * esconder o limite dentro de um middleware de multipart (`multer`), que este
 * projeto nem usa — Express 4 recebe o arquivo em base64 dentro do JSON.
 */
import { fileTypeFromBuffer } from 'file-type';
import {
  FALLBACK_MEDIA_MIME_TYPE,
  isAllowedMediaMimeType,
  mediaCategoryOf,
  normalizeMediaMimeType,
  type MessageType,
} from '@crm-lab/shared';
import { BusinessError, notFound } from '../http/errors.js';
import { readMediaFile, writeMediaFile } from '../lib/media-storage.js';
import { logger } from '../lib/logger.js';
import type { MediaRepository } from '../repositories/media.repository.js';

/** 15 MiB — recado de voz e foto de pedido medico cabem folgados; base64 ja infla ~33%. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export function messageTypeFromMime(mimeType: string): MessageType {
  const category = mediaCategoryOf(mimeType);
  if (category === 'other') return 'doc';
  return category;
}

export interface StoredMedia {
  id: string;
  buffer: Buffer;
  /** MIME efetivamente gravado (CRMLAB-31) — pode divergir do declarado no DTO. */
  mimeType: string;
}

/**
 * Categorias com magic bytes verificáveis (CRMLAB-31 §"Sniff de magic
 * bytes"). Documento (Word/Excel/PowerPoint) e `text/plain` ficam de fora de
 * propósito: o card pede sniff só para imagem/áudio/PDF, e texto puro não tem
 * assinatura binária para conferir.
 */
function needsMagicByteSniff(mimeType: string): boolean {
  return mediaCategoryOf(mimeType) !== 'other';
}

/**
 * Contêineres que o `file-type` rotula SEMPRE como vídeo, mas que o
 * `MediaRecorder` usa para áudio (CRMLAB-24, D-182): todo WebM é `video/webm`
 * e o MP4 do Safari (brand `mp42`/`isom`, não `M4A `) é `video/mp4`. Declarado
 * de áudio no MESMO contêiner não é troca de categoria — é o mesmo arquivo.
 */
const AUDIO_IN_VIDEO_CONTAINER: Readonly<Record<string, readonly string[]>> = {
  'video/webm': ['audio/webm'],
  'video/mp4': ['audio/mp4', 'audio/aac'],
};

function sameCategoryOrContainer(detectedMime: string, declared: string): boolean {
  if (mediaCategoryOf(detectedMime) === mediaCategoryOf(declared)) return true;
  return AUDIO_IN_VIDEO_CONTAINER[normalizeMediaMimeType(detectedMime)]?.includes(declared) ?? false;
}

/**
 * Allow-list primeiro, sniff depois. `file-type` só reconhece formatos com
 * assinatura binária (não cobre `audio/amr`, por exemplo) — quando ele não
 * identifica NADA, o dado é inconclusivo, não uma divergência provada, então
 * o MIME declarado (já dentro da allow-list) é mantido. Só uma detecção
 * POSITIVA e DIFERENTE da declarada derruba para `FALLBACK_MEDIA_MIME_TYPE`
 * (ex.: HTML/SVG disfarçado de PDF ou imagem — o vetor de XSS do card).
 */
export async function resolveStoredMimeType(declaredMimeType: string, buffer: Buffer): Promise<string> {
  // `normalizeMediaMimeType` tira parametros (`; codecs=opus`) e resolve
  // sinonimos — sem isso o recado de voz do WhatsApp caia fora da allow-list.
  const normalized = normalizeMediaMimeType(declaredMimeType);
  if (!isAllowedMediaMimeType(normalized)) {
    logger.warn('media.mime_not_allowed', { declared: normalized });
    return FALLBACK_MEDIA_MIME_TYPE;
  }
  if (!needsMagicByteSniff(normalized)) return normalized;

  // `fileTypeFromBuffer` lança quando o buffer é curto demais para a
  // assinatura que está tentando ler (`EndOfStreamError`, arquivo minúsculo
  // ou truncado) — isso NÃO é uma divergência provada, é o mesmo "inconclusivo"
  // do comentário acima, então cai no mesmo caminho de manter o declarado.
  // `storeInbound` promete NUNCA lançar (§4.2): deixar isso escapar quebraria
  // essa promessa pro webhook inteiro.
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(buffer);
  } catch (err) {
    logger.warn('media.mime_sniff_failed', {
      declared: normalized,
      reason: err instanceof Error ? err.message : String(err),
    });
    return normalized;
  }
  // Compara por CATEGORIA, nao por string (revisao do PR #43). O objetivo do
  // sniff e pegar HTML/SVG/PDF disfarcado de imagem (troca de categoria), nao
  // punir o `file-type` por rotular Opus-em-Ogg como `audio/ogg; codecs=opus`
  // ou M4A como `audio/x-m4a` — string diferente, mesma coisa, e o anexo
  // legitimo virava `application/octet-stream`.
  if (detected && !sameCategoryOrContainer(detected.mime, normalized)) {
    logger.warn('media.mime_mismatch', { declared: normalized, detected: detected.mime });
    return FALLBACK_MEDIA_MIME_TYPE;
  }
  return normalized;
}

/**
 * Anexo do ATENDENTE (saida): MIME fora da allow-list e erro de validacao, nao
 * rebaixamento silencioso (revisao do PR #43). Na entrada (webhook) rebaixar e
 * o certo — nao ha quem avisar. Na saida ha: o atendente anexava uma foto
 * HEIC ou um `.xls`, via 201, e o paciente recebia um "documento" generico sem
 * ninguem perceber que a foto nao foi.
 */
export function assertOutboundMimeAllowed(declaredMimeType: string): void {
  if (isAllowedMediaMimeType(declaredMimeType)) return;
  throw new BusinessError('VALIDATION_ERROR', {
    fields: { mimeType: `Tipo de arquivo nao aceito (${normalizeMediaMimeType(declaredMimeType)})` },
  });
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
    assertOutboundMimeAllowed(dto.mimeType);
    const buffer = decodeBase64(dto.contentBase64);
    assertWithinLimit(buffer);
    const mimeType = await resolveStoredMimeType(dto.mimeType, buffer);
    const id = await this.repository.insert(tenantId, {
      messageId: null,
      mimeType,
      fileName: dto.fileName,
      byteSize: buffer.byteLength,
    });
    await writeMediaFile(id, buffer);
    return { id, buffer, mimeType };
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
    const mimeType = await resolveStoredMimeType(dto.mimeType, buffer);
    const id = await this.repository.insert(tenantId, {
      messageId: null,
      mimeType,
      fileName: dto.fileName,
      byteSize: buffer.byteLength,
    });
    await writeMediaFile(id, buffer);
    return { id, buffer, mimeType };
  }

  async attachToMessage(tenantId: string, id: string, messageId: string): Promise<void> {
    await this.repository.attachToMessage(tenantId, id, messageId);
  }

  /**
   * `GET /media/:id`. `null` = mídia inexistente, de outro tenant (RLS) OU com
   * a linha no banco e o arquivo fora do disco — caso real em homologação, que
   * nasce de um dump de produção sem o volume de mídia junto. Arquivo ausente
   * é 404 com log, nunca 500: o dado sumiu, o servidor não quebrou.
   */
  async read(tenantId: string, id: string): Promise<ReadMedia | null> {
    const row = await this.repository.findById(tenantId, id);
    if (!row) return null;
    const buffer = await readMediaFile(id);
    if (!buffer) {
      logger.warn('media.file_missing', { tenantId, id, fileName: row.fileName });
      return null;
    }
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
