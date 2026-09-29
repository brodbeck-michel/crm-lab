/**
 * Partes estruturadas do payload do WhatsApp (CRMLAB-70, D-235) — funções
 * puras de `lib/whatsapp-message-parts.ts`. Formas do proto do Baileys.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_SHARED_CONTACTS,
  MAX_THUMBNAIL_BYTES,
  contactsFallbackText,
  contactsOf,
  jpegThumbnailOf,
  locationOf,
  mediaMetadataOf,
  vcardPhone,
} from '../../src/lib/whatsapp-message-parts.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02]);

describe('jpegThumbnailOf', () => {
  it('aceita base64, Buffer.toJSON e objeto de índices de Uint8Array', () => {
    const b64 = JPEG.toString('base64');
    expect(jpegThumbnailOf(b64)).toBe(b64);
    expect(jpegThumbnailOf({ type: 'Buffer', data: Array.from(JPEG) })).toBe(b64);
    expect(jpegThumbnailOf({ ...Array.from(JPEG) })).toBe(b64);
  });

  it('recusa o que não é JPEG, grande demais ou lixo', () => {
    expect(jpegThumbnailOf(Buffer.from('GIF89a').toString('base64'))).toBeNull();
    expect(jpegThumbnailOf(Buffer.concat([JPEG, Buffer.alloc(MAX_THUMBNAIL_BYTES)]).toString('base64'))).toBeNull();
    expect(jpegThumbnailOf('"><script>')).toBeNull();
    expect(jpegThumbnailOf({ data: [255, 999] })).toBeNull();
    expect(jpegThumbnailOf(42)).toBeNull();
  });
});

describe('mediaMetadataOf', () => {
  it('duração do vídeo/áudio (número ou string de Long) e páginas do documento', () => {
    expect(mediaMetadataOf('videoMessage', { seconds: 9 })).toEqual({ durationSec: 9 });
    expect(mediaMetadataOf('audioMessage', { seconds: '31' })).toEqual({ durationSec: 31 });
    expect(mediaMetadataOf('documentMessage', { pageCount: 4 })).toEqual({ pageCount: 4 });
  });

  it('nada a guardar → null; campo de outro tipo é ignorado', () => {
    expect(mediaMetadataOf('imageMessage', { seconds: 3 })).toBeNull();
    expect(mediaMetadataOf('documentMessage', { pageCount: 0 })).toBeNull();
    expect(mediaMetadataOf('videoMessage', { seconds: -1 })).toBeNull();
  });
});

describe('locationOf', () => {
  it('fixa: nome e endereço; em tempo real: caption vira nome', () => {
    expect(
      locationOf({ locationMessage: { degreesLatitude: -1.5, degreesLongitude: 2, name: ' Lab ', address: '' } }),
    ).toEqual({ latitude: -1.5, longitude: 2, name: 'Lab', address: null });
    expect(
      locationOf({ liveLocationMessage: { degreesLatitude: 0, degreesLongitude: 0, caption: 'aqui' } }),
    ).toEqual({ latitude: 0, longitude: 0, name: 'aqui', address: null });
  });

  it('coordenada fora da faixa ou não numérica → null', () => {
    expect(locationOf({ locationMessage: { degreesLatitude: 91, degreesLongitude: 0 } })).toBeNull();
    expect(locationOf({ locationMessage: { degreesLatitude: 0, degreesLongitude: '1' } })).toBeNull();
    expect(locationOf({ conversation: 'oi' })).toBeNull();
  });
});

describe('vcardPhone', () => {
  it('prefere o waid', () => {
    expect(vcardPhone('TEL;type=CELL;waid=5511987654321:+55 11 98765-4321')).toBe('+5511987654321');
  });

  it('TEL com + vira +dígitos; sem +, número BR; senão dígitos crus', () => {
    expect(vcardPhone('TEL:+1 (415) 555-0100')).toBe('+14155550100');
    expect(vcardPhone('TEL;type=CELL:(48) 99999-1234')).toBe('+5548999991234');
    expect(vcardPhone('TEL:0800 123 4567')).toBe('08001234567');
    expect(vcardPhone('FN:Sem telefone')).toBeNull();
  });
});

describe('contactsOf', () => {
  it('nome do displayName ou do FN; limite de contatos', () => {
    expect(contactsOf({ contactMessage: { vcard: 'BEGIN:VCARD\nFN:Carla\nEND:VCARD' } })).toEqual([
      { name: 'Carla', phone: null },
    ]);
    const many = Array.from({ length: MAX_SHARED_CONTACTS + 5 }, (_, i) => ({ displayName: `C${i}` }));
    expect(contactsOf({ contactsArrayMessage: { contacts: many } })).toHaveLength(MAX_SHARED_CONTACTS);
    expect(contactsOf({ contactMessage: {} })).toEqual([]);
  });

  it('texto de fallback', () => {
    expect(contactsFallbackText([{ name: 'Ana', phone: null }])).toBe('👤 Ana');
    expect(
      contactsFallbackText([
        { name: 'Ana', phone: null },
        { name: 'Bia', phone: null },
        { name: 'Caio', phone: null },
      ]),
    ).toBe('👤 Ana e mais 2');
  });
});
