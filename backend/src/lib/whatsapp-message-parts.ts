/**
 * Partes estruturadas de uma mensagem do WhatsApp (Baileys / Evolution v2) —
 * CRMLAB-70, D-235. Funcoes puras: o webhook (`webhook.routes.ts`) decide o
 * que fazer com o resultado; aqui so se le o payload sem confiar nele.
 *
 * Formas de referencia (proto do Baileys, `WAProto.Message`):
 * - `videoMessage { seconds, jpegThumbnail, caption, gifPlayback }`
 * - `audioMessage { seconds, ptt }` · `documentMessage { pageCount, fileName }`
 * - `locationMessage { degreesLatitude, degreesLongitude, name, address }`
 * - `liveLocationMessage { degreesLatitude, degreesLongitude, caption }`
 * - `contactMessage { displayName, vcard }` · `contactsArrayMessage { displayName, contacts[] }`
 */
import {
  normalizeBrazilianPhone,
  type MessageContact,
  type MessageLocation,
} from '@crm-lab/shared';
import type { MessageMetadata } from '../repositories/message.repository.js';

/** Teto da miniatura do video guardada em `metadata` (D-235 item 1). */
export const MAX_THUMBNAIL_BYTES = 48 * 1024;

/** Contatos guardados por mensagem (D-235 item 5). */
export const MAX_SHARED_CONTACTS = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** Inteiro >= 0 — `number` do proto ou string numerica (Long serializado). */
function nonNegativeInt(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * `bytes` do proto como o gateway pode serializar: base64, `Buffer.toJSON()`
 * (`{ type: 'Buffer', data: [...] }`) ou o objeto de indices de um `Uint8Array`
 * passado por `JSON.stringify` (`{ "0": 255, "1": 216, ... }`).
 */
function bytesOf(value: unknown): Buffer | null {
  if (typeof value === 'string') {
    return /^[A-Za-z0-9+/=\s]+$/.test(value) ? Buffer.from(value, 'base64') : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const list = Array.isArray(record.data) ? (record.data as unknown[]) : Object.values(record);
  if (list.length === 0 || list.length > MAX_THUMBNAIL_BYTES) return null;
  if (!list.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
    return null;
  }
  return Buffer.from(list as number[]);
}

/**
 * Miniatura JPEG em base64 limpo, ou `null`. So passa JPEG de verdade (magic
 * `FF D8 FF`) de ate `MAX_THUMBNAIL_BYTES`: a tela a usa como `data:image/jpeg`,
 * e o re-encode garante que nada alem de base64 chega ao `src`.
 */
export function jpegThumbnailOf(value: unknown): string | null {
  const bytes = bytesOf(value);
  if (!bytes || bytes.length < 3 || bytes.length > MAX_THUMBNAIL_BYTES) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  return bytes.toString('base64');
}

/** Metadados da submensagem de midia (D-235 itens 1 e 3). `null` = nada a guardar. */
export function mediaMetadataOf(
  key: string,
  submessage: Record<string, unknown>,
): MessageMetadata | null {
  const meta: MessageMetadata = {};
  if (key === 'videoMessage' || key === 'audioMessage') {
    const seconds = nonNegativeInt(submessage.seconds);
    if (seconds !== null) meta.durationSec = seconds;
  }
  if (key === 'videoMessage') {
    const thumbnail = jpegThumbnailOf(submessage.jpegThumbnail);
    if (thumbnail) meta.thumbnail = thumbnail;
  }
  if (key === 'documentMessage') {
    const pages = nonNegativeInt(submessage.pageCount);
    if (pages !== null && pages > 0) meta.pageCount = pages;
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

function coordinate(value: unknown, limit: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

/**
 * Localizacao estruturada (D-235 item 4), ou `null` quando nao ha submensagem
 * de localizacao OU as coordenadas nao sao validas (ai o webhook cai na linha
 * de texto antiga).
 */
export function locationOf(message: Record<string, unknown>): MessageLocation | null {
  const fixed = asRecord(message.locationMessage);
  const live = asRecord(message.liveLocationMessage);
  const source = fixed ?? live;
  if (!source) return null;
  const latitude = coordinate(source.degreesLatitude, 90);
  const longitude = coordinate(source.degreesLongitude, 180);
  if (latitude === null || longitude === null) return null;
  return {
    latitude,
    longitude,
    name: trimmed(fixed ? source.name : source.caption),
    address: trimmed(source.address),
  };
}

/** Texto de fallback da localizacao (D-234 item 5). */
export function locationFallbackText(location: MessageLocation): string {
  return `📍 ${location.name ?? location.address ?? 'Localização'}`;
}

/** Valor de uma propriedade do vCard (`FN`, `TEL`...), com ou sem parametros. */
function vcardValues(vcard: string, property: string): { params: string; value: string }[] {
  const out: { params: string; value: string }[] = [];
  // Linhas dobradas (RFC 6350 §3.2) nao aparecem no que o WhatsApp gera; ignorar.
  for (const line of vcard.split(/\r?\n/)) {
    const match = new RegExp(`^(?:item\\d+\\.)?${property}([;][^:]*)?:(.*)$`, 'i').exec(line.trim());
    if (match) out.push({ params: match[1] ?? '', value: (match[2] ?? '').trim() });
  }
  return out;
}

/**
 * Telefone do vCard (D-235 item 5): o `waid=` (numero do WhatsApp, so
 * digitos, com pais) quando vier; senao o `TEL` — com `+`, vira `+<digitos>`;
 * sem `+`, tenta como numero brasileiro; nao sendo, ficam os digitos crus.
 */
export function vcardPhone(vcard: string): string | null {
  const tels = vcardValues(vcard, 'TEL');
  for (const tel of tels) {
    const waid = /waid=(\d{8,15})/i.exec(tel.params);
    if (waid) return `+${waid[1]}`;
  }
  for (const tel of tels) {
    const digits = tel.value.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    if (tel.value.startsWith('+')) return `+${digits}`;
    return normalizeBrazilianPhone(tel.value) ?? digits;
  }
  return null;
}

function contactOf(displayName: unknown, vcard: unknown): MessageContact | null {
  const card = typeof vcard === 'string' ? vcard : '';
  const name = trimmed(displayName) ?? trimmed(vcardValues(card, 'FN')[0]?.value);
  if (!name) return null;
  return { name, phone: card ? vcardPhone(card) : null };
}

/** Contatos compartilhados (D-235 item 5); `[]` quando nao ha nenhum com nome. */
export function contactsOf(message: Record<string, unknown>): MessageContact[] {
  const single = asRecord(message.contactMessage);
  if (single) {
    const contact = contactOf(single.displayName, single.vcard);
    return contact ? [contact] : [];
  }
  const list = asRecord(message.contactsArrayMessage)?.contacts;
  if (!Array.isArray(list)) return [];
  const out: MessageContact[] = [];
  for (const item of list) {
    const record = asRecord(item);
    const contact = record ? contactOf(record.displayName, record.vcard) : null;
    if (contact) out.push(contact);
    if (out.length >= MAX_SHARED_CONTACTS) break;
  }
  return out;
}

/** Texto de fallback dos contatos (D-234 item 5). */
export function contactsFallbackText(contacts: MessageContact[]): string {
  const [first] = contacts;
  if (!first) return '👤 Contato';
  return contacts.length > 1 ? `👤 ${first.name} e mais ${contacts.length - 1}` : `👤 ${first.name}`;
}
