/**
 * CaptureDeviceService — SERVICES.md §36 (CRMLAB-184, D-327).
 *
 * O celular da recepcao pareado para `/digitalizar`: a UNICA credencial que
 * nao e de usuario (SECURITY.md "Dispositivo de captura").
 *
 * - Codigo de pareamento: 8 caracteres de `PAIRING_CODE_ALPHABET` sorteados
 *   com `crypto.randomInt`, uso unico, 15 min. O banco guarda o sha256.
 * - Credencial: 32 bytes aleatorios (base64url) no cookie `crm_capture`; o
 *   banco guarda o sha256. sha256, nao bcrypt: nao e senha (SCHEMA §50).
 * - `withoutTenant()` SO para achar o dispositivo pelo hash (pareamento e
 *   autenticacao). Todo o resto roda com `withTenant()`.
 * - Cadastro, novo codigo, pareamento e revogacao geram audit log.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MINUTES,
  normalizePairingCode,
  type CaptureDevice,
  type CapturePairingCode,
  type CaptureSession,
  type ListCaptureDevicesResponse,
} from '@crm-lab/shared';
import type { DbClient } from '../db/types.js';
import type { TenantContext } from '../http/context.js';
import { BusinessError, notFound } from '../http/errors.js';
import * as repo from '../repositories/capture-device.repository.js';
import type { AuditService } from './audit.service.js';

/** Quem esta enviando foto: o dispositivo autenticado pelo cookie. */
export interface CaptureDeviceContext {
  tenantId: string;
  deviceId: string;
  deviceName: string;
  tenantName: string;
}

export type ListCaptureDevicesResult = ListCaptureDevicesResponse;

export interface CaptureDeviceServiceDeps {
  db: DbClient;
  audit: AuditService;
  now?: () => Date;
}

/** Metadados da requisicao que pareou (audit sem usuario). */
export interface PairRequestMeta {
  ip: string;
  userAgent: string;
}

export const DEFAULT_DEVICE_PAGE_LIMIT = 50;
export const MAX_DEVICE_PAGE_LIMIT = 100;
const TOKEN_BYTES = 32;
/** 32 bytes em base64url = 43 caracteres. Qualquer outra coisa nem vai ao banco. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return code;
}

export function generateDeviceToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function isWellFormedCode(code: string): boolean {
  if (code.length !== PAIRING_CODE_LENGTH) return false;
  for (const ch of code) if (!PAIRING_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export class CaptureDeviceService {
  private readonly db: DbClient;
  private readonly audit: AuditService;
  private readonly now: () => Date;

  constructor(deps: CaptureDeviceServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.now = deps.now ?? (() => new Date());
  }

  private newPairing(): { code: string; codeHash: string; expiresAt: Date } {
    const code = generatePairingCode();
    const expiresAt = new Date(this.now().getTime() + PAIRING_CODE_TTL_MINUTES * 60_000);
    return { code, codeHash: sha256Hex(code), expiresAt };
  }

  async list(
    ctx: TenantContext,
    page: { page?: number; limit?: number },
  ): Promise<ListCaptureDevicesResult> {
    const limit = page.limit ?? DEFAULT_DEVICE_PAGE_LIMIT;
    const current = page.page ?? 1;
    const { devices, total } = await this.db.withTenant(ctx.tenantId, (tx) =>
      repo.listDevices(tx, { limit, offset: (current - 1) * limit }),
    );
    return {
      devices,
      pagination: { page: current, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async create(
    ctx: TenantContext,
    name: string,
  ): Promise<{ device: CaptureDevice; pairing: CapturePairingCode }> {
    const pairing = this.newPairing();
    const device = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const id = await repo.insertDevice(tx, {
        tenantId: ctx.tenantId,
        name,
        pairingCodeHash: pairing.codeHash,
        pairingCodeExpiresAt: pairing.expiresAt,
        createdBy: ctx.userId,
      });
      return repo.findDevice(tx, id);
    });
    if (!device) throw new Error('capture_device recem-criado nao encontrado');
    await this.audit.record(ctx, {
      action: 'create_capture_device',
      entityType: 'capture_device',
      entityId: device.id,
      newValues: { name },
    });
    return { device, pairing: { code: pairing.code, expiresAt: pairing.expiresAt.toISOString() } };
  }

  async renewPairingCode(ctx: TenantContext, id: string): Promise<CapturePairingCode> {
    const pairing = this.newPairing();
    const name = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const device = await repo.lockDevice(tx, id);
      if (!device) throw notFound({ resource: 'capture_device', id });
      if (device.revoked) throw new BusinessError('CONFLICT', { reason: 'device_revoked' });
      await repo.setPairingCode(tx, id, pairing.codeHash, pairing.expiresAt);
      return device.name;
    });
    await this.audit.record(ctx, {
      action: 'renew_capture_device_pairing_code',
      entityType: 'capture_device',
      entityId: id,
      newValues: { name },
    });
    return { code: pairing.code, expiresAt: pairing.expiresAt.toISOString() };
  }

  /** Idempotente: revogar de novo e 204 sem novo audit. */
  async revoke(ctx: TenantContext, id: string): Promise<void> {
    const revokedNow = await this.db.withTenant(ctx.tenantId, async (tx) => {
      const device = await repo.lockDevice(tx, id);
      if (!device) throw notFound({ resource: 'capture_device', id });
      if (device.revoked) return null;
      await repo.revokeDevice(tx, id);
      return device;
    });
    if (!revokedNow) return;
    await this.audit.record(ctx, {
      action: 'revoke_capture_device',
      entityType: 'capture_device',
      entityId: id,
      oldValues: { name: revokedNow.name, paired: revokedNow.paired },
    });
  }

  /**
   * `POST /capture/pair`. Inexistente, vencido, ja usado, revogado (e
   * laboratorio inativo) respondem IGUAL: `PAIRING_CODE_INVALID`.
   */
  async pair(
    rawCode: string,
    meta: PairRequestMeta,
  ): Promise<{ token: string } & CaptureSession> {
    const code = normalizePairingCode(rawCode);
    if (!isWellFormedCode(code)) throw new BusinessError('PAIRING_CODE_INVALID');
    const codeHash = sha256Hex(code);

    // EXCECAO AUDITADA de RLS (SCHEMA.md): o tenant so e conhecido depois de
    // achar o dispositivo pelo hash do codigo. Uma linha, so leitura.
    const found = await this.db.withoutTenant((tx) => repo.findByPairingCodeHash(tx, codeHash));
    if (!found) throw new BusinessError('PAIRING_CODE_INVALID');

    const token = generateDeviceToken();
    const result = await this.db.withTenant(found.tenantId, async (tx) => {
      const paired = await repo.completePairing(tx, found.id, codeHash, sha256Hex(token));
      if (!paired) return null;
      return { deviceName: paired.name, tenantName: await repo.tenantName(tx, found.tenantId) };
    });
    if (!result) throw new BusinessError('PAIRING_CODE_INVALID');

    await this.audit.log({
      tenantId: found.tenantId,
      userId: null,
      action: 'pair_capture_device',
      entityType: 'capture_device',
      entityId: found.id,
      newValues: { name: result.deviceName },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { token, ...result };
  }

  /**
   * Cookie -> dispositivo. Sem cookie, credencial desconhecida, revogado ou
   * laboratorio inativo: `CAPTURE_DEVICE_UNPAIRED`.
   */
  async authenticate(token: string | undefined): Promise<CaptureDeviceContext> {
    if (token === undefined || !TOKEN_FORMAT.test(token)) {
      throw new BusinessError('CAPTURE_DEVICE_UNPAIRED');
    }
    // EXCECAO AUDITADA de RLS (SCHEMA.md): o equivalente ao login, para o celular.
    const found = await this.db.withoutTenant((tx) => repo.findByTokenHash(tx, sha256Hex(token)));
    if (!found || !found.tenantActive) throw new BusinessError('CAPTURE_DEVICE_UNPAIRED');
    return {
      tenantId: found.tenantId,
      deviceId: found.deviceId,
      deviceName: found.deviceName,
      tenantName: found.tenantName,
    };
  }
}
