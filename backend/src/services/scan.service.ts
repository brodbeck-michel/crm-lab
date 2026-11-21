/**
 * ScanService — a fila "Digitalizacoes" (SERVICES.md §36, CRMLAB-184, D-327).
 *
 * - `create`: a foto do celular pareado. Mesmo hardening do anexo (allow-list
 *   + sniff, CRMLAB-31) e a mesma conversao JPEG sem EXIF/GPS (D-290). So
 *   JPEG/PNG ate 5 MB (teto de imagem da Cloud API, D-314): nada da fila e
 *   recusado pela Meta no envio. Teto de 100 pendentes por dispositivo.
 * - `list`/`readContent`/`discard`: quem atende. Vencida nunca aparece.
 * - `prepareForAttachment` + `consumeAsMedia`: a foto vira anexo de mensagem
 *   (`POST /conversations/:id/attachments` com `scanId`). O primeiro so le
 *   (as checagens do anexo rodam com ele); o segundo tira a foto da fila
 *   (`DELETE ... RETURNING`) NA MESMA transacao que grava a midia.
 * - `expireDue`: o agendador do `main.ts`.
 */
import { fileTypeFromBuffer } from 'file-type';
import {
  FALLBACK_MEDIA_MIME_TYPE,
  MAX_PENDING_SCANS_PER_DEVICE,
  MAX_SCAN_BYTES,
  SCAN_MIME_TYPES,
  SCAN_TTL_HOURS,
  normalizeMediaMimeType,
  type CreateScanResponse,
  type ListScansResponse,
  type Scan,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import { logger } from '../lib/logger.js';
import {
  deleteScanFile,
  readScanFile,
  writeMediaFile,
  writeScanFile,
} from '../lib/media-storage.js';
import { insertMediaRow } from '../repositories/media.repository.js';
import * as captureRepo from '../repositories/capture-device.repository.js';
import * as repo from '../repositories/scan.repository.js';
import type { AuditService } from './audit.service.js';
import type { CaptureDeviceContext } from './capture-device.service.js';
import { convertImageToJpeg } from './image-to-jpeg.js';
import { resolveStoredMimeType, type PreparedMedia, type StoredMedia } from './media.service.js';

export const DEFAULT_SCAN_PAGE_LIMIT = 50;
export const MAX_SCAN_PAGE_LIMIT = 100;

const SCAN_MIMES: readonly string[] = SCAN_MIME_TYPES;

export type ListScansResult = ListScansResponse;

export interface ScanServiceDeps {
  db: DbClient;
  audit: AuditService;
}

const SAO_PAULO_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** "digitalizacao-AAAAMMDD-HHMMSS.jpg" no horario de Brasilia (D-327). */
export function scanFileName(createdAt: Date, mimeType: string): string {
  const parts: Record<string, string> = {};
  for (const p of SAO_PAULO_PARTS.formatToParts(createdAt)) parts[p.type] = p.value;
  const ext = normalizeMediaMimeType(mimeType) === 'image/png' ? 'png' : 'jpg';
  return `digitalizacao-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}.${ext}`;
}

function toScan(row: repo.ScanRow): Scan {
  return {
    id: row.id,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    fileName: scanFileName(row.createdAt, row.mimeType),
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    contentUrl: `/api/v1/scans/${row.id}/content`,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

function scanNotFound(): BusinessError {
  return notFound({ reason: 'scan_not_found' });
}

function notAPhoto(): BusinessError {
  return new BusinessError('VALIDATION_ERROR', {
    fields: { contentBase64: 'O arquivo nao e uma foto JPEG ou PNG' },
  });
}

function tooLarge(byteSize: number): BusinessError {
  return new BusinessError('MEDIA_TOO_LARGE', { byteSize, max: MAX_SCAN_BYTES });
}

/** Apagar o arquivo da fila depois do commit: falha so vira log (SERVICES §36). */
async function removeScanFile(tenantId: string, id: string): Promise<void> {
  try {
    await deleteScanFile(id);
  } catch (err) {
    logger.warn('scan.file_delete_failed', {
      tenantId,
      scanId: id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

let expireInProgress = false;

export class ScanService {
  private readonly db: DbClient;
  private readonly audit: AuditService;

  constructor(deps: ScanServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
  }

  /** Allow-list, teto, sniff e JPEG — sem gravar nada. */
  private async prepareUpload(input: { mimeType: string; contentBase64: string }): Promise<{
    buffer: Buffer;
    mimeType: string;
  }> {
    const declared = normalizeMediaMimeType(input.mimeType);
    if (!SCAN_MIMES.includes(declared)) {
      throw new BusinessError('VALIDATION_ERROR', {
        fields: { mimeType: `Tipo nao aceito: envie ${SCAN_MIMES.join(' ou ')}` },
      });
    }
    const raw = Buffer.from(input.contentBase64, 'base64');
    if (raw.byteLength === 0) throw notAPhoto();
    if (raw.byteLength > MAX_SCAN_BYTES) throw tooLarge(raw.byteLength);

    // Sniff positivo obrigatorio: a fila so guarda foto. "Inconclusivo" (que
    // no anexo comum mantem o declarado) aqui e recusa.
    let detected: string | null = null;
    try {
      detected = (await fileTypeFromBuffer(raw))?.mime ?? null;
    } catch {
      detected = null;
    }
    if (detected === null || !SCAN_MIMES.includes(detected)) throw notAPhoto();
    const resolved = await resolveStoredMimeType(declared, raw);
    if (resolved === FALLBACK_MEDIA_MIME_TYPE) throw notAPhoto();

    const converted = await convertImageToJpeg({ buffer: raw, mimeType: resolved, fileName: 'scan' });
    if (converted.buffer.byteLength > MAX_SCAN_BYTES) throw tooLarge(converted.buffer.byteLength);
    return { buffer: converted.buffer, mimeType: converted.mimeType };
  }

  /** `POST /capture/scans`. O arquivo nasce depois da linha, nomeado pelo `id`. */
  async create(
    dev: CaptureDeviceContext,
    input: { mimeType: string; contentBase64: string },
  ): Promise<CreateScanResponse> {
    const { buffer, mimeType } = await this.prepareUpload(input);

    const created = await this.db.withTenant(dev.tenantId, async (tx) => {
      // Trava o dispositivo: duas fotos ao mesmo tempo nao furam o teto, e a
      // revogacao feita no meio do caminho vale.
      const device = await captureRepo.lockDevice(tx, dev.deviceId);
      if (!device || device.revoked) throw new BusinessError('CAPTURE_DEVICE_UNPAIRED');
      const pending = await repo.countPendingByDevice(tx, dev.deviceId);
      if (pending >= MAX_PENDING_SCANS_PER_DEVICE) {
        throw new BusinessError('CONFLICT', {
          reason: 'scan_queue_full',
          max: MAX_PENDING_SCANS_PER_DEVICE,
        });
      }
      const scan = await repo.insertScan(tx, {
        tenantId: dev.tenantId,
        deviceId: dev.deviceId,
        mimeType,
        byteSize: buffer.byteLength,
        ttlHours: SCAN_TTL_HOURS,
      });
      await captureRepo.touchLastUsed(tx, dev.deviceId);
      // Dentro da transacao: falhou o disco, a linha nao fica orfa.
      await writeScanFile(scan.id, buffer);
      return scan;
    });

    logger.info('scan.created', {
      tenantId: dev.tenantId,
      deviceId: dev.deviceId,
      byteSize: buffer.byteLength,
    });
    return {
      id: created.id,
      createdAt: created.createdAt.toISOString(),
      expiresAt: created.expiresAt.toISOString(),
    };
  }

  async list(
    ctx: TenantContext,
    page: { page?: number; limit?: number },
  ): Promise<ListScansResult> {
    const limit = page.limit ?? DEFAULT_SCAN_PAGE_LIMIT;
    const current = page.page ?? 1;
    const { scans, total } = await this.db.withTenant(ctx.tenantId, (tx) =>
      repo.listPending(tx, { limit, offset: (current - 1) * limit }),
    );
    return {
      scans: scans.map(toScan),
      pagination: { page: current, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async readContent(
    ctx: TenantContext,
    id: string,
  ): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const row = await this.db.withTenant(ctx.tenantId, (tx) => repo.findPending(tx, id));
    if (!row) throw scanNotFound();
    const buffer = await readScanFile(id);
    if (!buffer) {
      logger.warn('scan.file_missing', { tenantId: ctx.tenantId, scanId: id });
      throw scanNotFound();
    }
    return { buffer, mimeType: row.mimeType, fileName: scanFileName(row.createdAt, row.mimeType) };
  }

  /** `DELETE /scans/:id`: apaga linha e arquivo. Audit `discard_scan`. */
  async discard(ctx: TenantContext, id: string): Promise<void> {
    const row = await this.db.withTenant(ctx.tenantId, (tx) => repo.deletePending(tx, id));
    if (!row) throw scanNotFound();
    await removeScanFile(ctx.tenantId, id);
    await this.audit.record(ctx, {
      action: 'discard_scan',
      entityType: 'scan',
      entityId: id,
      oldValues: {
        deviceName: row.deviceName,
        createdAt: row.createdAt.toISOString(),
        byteSize: row.byteSize,
      },
    });
  }

  /**
   * Anexo com `scanId`, fase 1: le a foto SEM tira-la da fila. As checagens do
   * anexo (formato da Meta, canal, janela) rodam sobre isto; recusa aqui deixa
   * a foto na fila.
   */
  async prepareForAttachment(ctx: TenantContext, id: string): Promise<PreparedMedia> {
    const content = await this.readContent(ctx, id);
    return { buffer: content.buffer, mimeType: content.mimeType, fileName: content.fileName };
  }

  /**
   * Anexo com `scanId`, fase 2: `DELETE ... RETURNING` da foto + INSERT da
   * midia da mensagem + arquivo da midia em disco, tudo dentro da MESMA
   * transacao. Quem perde a corrida (outra atendente ja usou) recebe
   * `NOT_FOUND scan_not_found` e nada e gravado. O arquivo da fila e apagado
   * depois do commit.
   */
  async consumeAsMedia(
    ctx: TenantContext,
    id: string,
    prepared: PreparedMedia,
  ): Promise<StoredMedia> {
    const mediaId = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const consumed = await repo.deletePending(tx, id);
      if (!consumed) throw scanNotFound();
      const inserted = await insertMediaRow(tx, ctx.tenantId, {
        messageId: null,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
        byteSize: prepared.buffer.byteLength,
      });
      await writeMediaFile(inserted, prepared.buffer);
      return inserted;
    });
    await removeScanFile(ctx.tenantId, id);
    return { id: mediaId, ...prepared };
  }

  /**
   * Agendador (main.ts, 30 min). Lista os tenants com vencidas
   * (`withoutTenant`, D-327) e apaga um por vez com `withTenant`. Nunca lanca.
   */
  async expireDue(): Promise<{ tenantId: string; expired: number }[]> {
    if (expireInProgress) return [];
    expireInProgress = true;
    try {
      let tenantIds: string[];
      try {
        tenantIds = await this.db.withoutTenant((tx) => repo.listTenantsWithExpired(tx));
      } catch (err) {
        logger.warn('scan.expire_failed', {
          message: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
      const results: { tenantId: string; expired: number }[] = [];
      for (const tenantId of tenantIds) {
        try {
          const ids = await this.db.withTenant(tenantId, (tx) => repo.deleteExpired(tx));
          for (const scanId of ids) await removeScanFile(tenantId, scanId);
          results.push({ tenantId, expired: ids.length });
          logger.info('scan.expired', { tenantId, count: ids.length });
        } catch (err) {
          logger.warn('scan.expire_tenant_failed', {
            tenantId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    } finally {
      expireInProgress = false;
    }
  }
}
