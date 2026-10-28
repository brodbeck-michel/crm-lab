/**
 * Imagem gravada vira JPEG (CRMLAB-128, D-290/D-291).
 *
 * Roda AO GRAVAR — entrada do WhatsApp (`storeInbound`), anexo da atendente
 * (`prepareOutbound`), anexo do chat interno e da visita medica. O que ja
 * esta no disco fica como esta (decisao do Michel, 28/10/2026).
 *
 * Regras (D-290):
 * - `.rotate()` aplica a orientacao do EXIF antes de descartar os metadados:
 *   foto de celular nao fica deitada.
 * - Sem `withMetadata`: EXIF/GPS/XMP saem (GPS da casa do paciente e dado
 *   pessoal). O perfil ICC tambem sai — o sharp converte para sRGB.
 * - Transparencia (PNG/WebP/GIF) vira fundo branco (`flatten`).
 * - Figurinha, GIF/WebP/PNG animado: formato original, como antes.
 * - JPEG so e reencodado se tiver orientacao girada ou GPS (EXIF ou XMP).
 *   Em prod 535 das 555 imagens ja sao JPEG (levantamento de 28/10/2026, ~150
 *   KB medias, o WhatsApp ja tira o EXIF): reencodar todas so custaria CPU e
 *   qualidade. Outros campos de EXIF (marca da camera, data) ficam.
 * - Qualquer falha (HEIC que o sharp pre-compilado nao decodifica, arquivo
 *   corrompido, grande demais, lento demais) devolve o ORIGINAL com log —
 *   nunca lanca, para `storeInbound` continuar sem lancar.
 */
import sharp, { type Metadata } from 'sharp';
import { mediaCategoryOf, normalizeMediaMimeType } from '@crm-lab/shared';
import { logger } from '../lib/logger.js';

export interface ImageToStore {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

export const JPEG_MIME_TYPE = 'image/jpeg';
/** mozjpeg q82: foto de pedido medico legivel, ~metade do PNG de print. */
export const JPEG_QUALITY = 82;
/**
 * 60 MP. Acima disso (ou bomba de descompressao) o sharp recusa antes de
 * alocar: ~180 MB de RGB decodificado ja e o teto razoavel na VPS. Foto de
 * 108 MP fica no formato original.
 */
export const MAX_INPUT_PIXELS = 60_000_000;
/** Teto de CPU por imagem — o webhook nao pode ficar preso numa conversao. */
export const CONVERT_TIMEOUT_SECONDS = 10;

const WHITE = { r: 255, g: 255, b: 255 };

/**
 * O EXIF aponta o diretorio de GPS pela tag 0x8825. Procura os dois bytes na
 * ordem big e little endian: falso positivo so causa um reencode a mais
 * (lado seguro); falso negativo nao acontece se a tag existir.
 */
function exifHasGps(exif: Buffer | undefined): boolean {
  if (!exif) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

function jpegNeedsReencode(meta: Metadata): boolean {
  if ((meta.orientation ?? 1) > 1) return true;
  if (exifHasGps(meta.exif)) return true;
  return meta.xmp?.includes('GPS') ?? false;
}

/** PNG animado (APNG) tem o chunk `acTL` antes do primeiro `IDAT`. */
function isAnimatedPng(buffer: Buffer): boolean {
  const idat = buffer.indexOf('IDAT', 8, 'latin1');
  const actl = buffer.indexOf('acTL', 8, 'latin1');
  return actl !== -1 && (idat === -1 || actl < idat);
}

export function jpegFileName(fileName: string): string {
  const base = fileName.replace(/\.[^./\\]*$/, '').trim();
  return `${base || 'imagem'}.jpg`;
}

export async function convertImageToJpeg(
  input: ImageToStore,
  options: { keepOriginal?: boolean } = {},
): Promise<ImageToStore> {
  const declared = normalizeMediaMimeType(input.mimeType);
  if (options.keepOriginal || mediaCategoryOf(declared) !== 'image') return input;

  try {
    const meta = await sharp(input.buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();

    if ((meta.pages ?? 1) > 1 || (meta.format === 'png' && isAnimatedPng(input.buffer))) {
      return input;
    }
    if (meta.format === 'jpeg' && !jpegNeedsReencode(meta)) {
      // Bytes intactos. Declarado como outra imagem (o sniff compara por
      // categoria, entao `image/png` com conteudo JPEG passa): o MIME vira o
      // real e o nome ganha `.jpg`, senao banco e WhatsApp diriam `.png`.
      if (declared === JPEG_MIME_TYPE) return input;
      return { ...input, mimeType: JPEG_MIME_TYPE, fileName: jpegFileName(input.fileName) };
    }

    const buffer = await sharp(input.buffer, { limitInputPixels: MAX_INPUT_PIXELS })
      .timeout({ seconds: CONVERT_TIMEOUT_SECONDS })
      .rotate()
      .flatten({ background: WHITE })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { buffer, mimeType: JPEG_MIME_TYPE, fileName: jpegFileName(input.fileName) };
  } catch (err) {
    logger.warn('media.image_convert_failed', {
      mimeType: declared,
      byteSize: input.buffer.byteLength,
      reason: err instanceof Error ? err.message : String(err),
    });
    return input;
  }
}
