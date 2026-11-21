/**
 * Digitalizar pelo celular — CRMLAB-184, D-327.
 * Espelha docs/api/API_CONTRACTS.md §15.
 */

import type { PaginationMeta } from './api.types.js';

export type CaptureDeviceStatus = 'pending' | 'active' | 'revoked';

export interface CaptureDevice {
  id: string;
  name: string;
  /** pending = cadastrado, ainda não pareado. */
  status: CaptureDeviceStatus;
  /** ISO UTC; só quando há código válido. */
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  /** Último envio de foto. */
  lastUsedAt: string | null;
  /** Fotos na fila (não vencidas). */
  pendingScans: number;
  createdAt: string;
}

/** `GET /settings/capture-devices`. */
export interface ListCaptureDevicesResponse {
  devices: CaptureDevice[];
  pagination: PaginationMeta;
}

export interface CapturePairingCode {
  /** 8 caracteres de `PAIRING_CODE_ALPHABET`, sem hífen (a tela mostra `XXXX-XXXX`). */
  code: string;
  expiresAt: string;
}

export interface CreateCaptureDeviceRequest {
  name: string;
}

export interface CreateCaptureDeviceResponse {
  device: CaptureDevice;
  pairing: CapturePairingCode;
}

export interface CapturePairRequest {
  code: string;
}

/** `POST /capture/pair` e `GET /capture/session`. */
export interface CaptureSession {
  deviceName: string;
  tenantName: string;
}

export interface CreateScanRequest {
  mimeType: string;
  contentBase64: string;
}

export interface CreateScanResponse {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface Scan {
  id: string;
  deviceId: string;
  deviceName: string;
  /** "digitalizacao-AAAAMMDD-HHMMSS.jpg" (horário de Brasília). */
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** "/api/v1/scans/<id>/content" — nunca URL pública. */
  contentUrl: string;
  createdAt: string;
  expiresAt: string;
}

/** `GET /scans`. */
export interface ListScansResponse {
  scans: Scan[];
  pagination: PaginationMeta;
}

/** Alfabeto do código de pareamento: sem 0/O/1/I/L (31 símbolos). */
export const PAIRING_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MINUTES = 15;
export const CAPTURE_DEVICE_NAME_MAX = 60;

/** Fotos aceitas pela captura (o celular já manda JPEG). */
export const SCAN_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
/** 5 MB — teto de imagem da Cloud API (D-314). */
export const MAX_SCAN_BYTES = 5 * 1024 * 1024;
/** Fotos pendentes por dispositivo (D-327 item 8). */
export const MAX_PENDING_SCANS_PER_DEVICE = 100;
/** Vida da foto na fila (D-327 item 6). */
export const SCAN_TTL_HOURS = 48;

/** Normaliza o que foi digitado: maiúsculas, sem hífen/espaço. */
export function normalizePairingCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}
